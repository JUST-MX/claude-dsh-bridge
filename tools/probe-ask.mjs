// Answer one AskUserQuestion control_request with a candidate `control_response`
// shape and print what Claude Code replies, so the panel can send the shape that
// actually delivers answers.
//
// Why this file exists: after the user pressed Allow on an AskUserQuestion
// request, the CLI ran the tool and reported "The user did not answer the
// questions." An `{behavior:'allow'}` response grants permission but carries no
// answer, so the tool has nothing to return. This probe finds the field that
// carries it.
//
// The spawn uses regular-file handles for all three stdio slots: the Windows
// sandbox refuses to spawn a child with a named pipe, and appending to the file
// that backs stdin still feeds the CLI line by line.
//
// Run: node tools/probe-ask.mjs <shape> [outDir]
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shape = process.argv[2] ?? 'answers-map'
const outDir = process.argv[3] ?? join(here, '..', '.research', 'ask-probe', shape)
mkdirSync(outDir, { recursive: true })

const CLI = `${process.env.USERPROFILE}\\.local\\bin\\claude.exe`
const stdinPath = join(outDir, 'stdin.jsonl')
writeFileSync(stdinPath, '')

const stdinFd = openSync(stdinPath, 'a')
const stdoutFd = openSync(join(outDir, 'stdout.jsonl'), 'w')
const stderrFd = openSync(join(outDir, 'stderr.txt'), 'w')

const send = (payload) => writeSync(stdinFd, JSON.stringify(payload) + '\n')

const child = spawn(CLI, [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'manual',
  '--permission-prompt-tool', 'stdio',
], { cwd: outDir, stdio: [stdinFd, stdoutFd, stderrFd] })

/** The questions the model asked, as one answer map keyed by question text. */
function answersFor(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  const first = {}
  const byHeader = {}
  const list = []
  for (const question of questions) {
    const option = question.options?.[0]
    const label = String(option?.label ?? 'yes')
    first[String(question.question ?? '')] = label
    byHeader[String(question.header ?? '')] = label
    list.push({ question: String(question.question ?? ''), answer: label })
  }
  if (shape === 'answers-map') return { answers: first }
  if (shape === 'answers-header') return { answers: byHeader }
  if (shape === 'answers-array') return { answers: list }
  if (shape === 'bare-answers') return { ...input, answers: first }
  throw new Error(`unknown shape "${shape}"`)
}

let buffer = ''
const stdoutWatcher = setInterval(() => {
  const text = readFileSync(join(outDir, 'stdout.jsonl'), 'utf8')
  const fresh = text.slice(buffer.length)
  buffer = text
  for (const line of fresh.split('\n')) {
    if (line.trim() === '') continue
    let payload
    try { payload = JSON.parse(line) } catch { continue }
    if (payload.type === 'control_request' && payload.request?.subtype === 'can_use_tool') {
      const input = payload.request.input ?? {}
      const response = { behavior: 'allow', updatedInput: { ...input, ...answersFor(input) } }
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: payload.request_id, response },
      })
      console.log('answered with', JSON.stringify(response).slice(0, 200))
    }
    if (payload.type === 'user') {
      for (const block of payload.message?.content ?? []) {
        if (block.type === 'tool_result') console.log('TOOL_RESULT', JSON.stringify(block.content).slice(0, 300))
      }
    }
    if (payload.type === 'result') {
      clearInterval(stdoutWatcher)
      closeSync(stdinFd)
      closeSync(stdoutFd)
      closeSync(stderrFd)
      console.log('DONE')
      process.exit(0)
    }
  }
}, 400)

send({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: '用 AskUserQuestion 问我一个问题：我喜欢什么颜色？给三个选项。只问我一次，不要做别的事。' }],
  },
  parent_tool_use_id: null,
})

setTimeout(() => {
  console.log('TIMEOUT')
  child.kill()
  process.exit(2)
}, 120_000)
