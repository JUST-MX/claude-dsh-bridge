// Does a `-p` session persist, and does `--resume` work across processes?
//
// An earlier design note was written against an older CLI and says the opposite ("`-p`
// never writes ~/.claude/projects, so process death = conversation death"). The
// plugin was built around that: a finished item reopened as a NEW process whose
// first message carried the last 4 KB of chat. If the CLI now persists, that
// primer is strictly worse than `--resume`, so this measures the four facts the
// decision rests on, with CLAUDE_CONFIG_DIR pointed at a scratch tree so nothing
// in ~/.claude is read or written.
//
// Run: node tools/probe-resume.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'ccw-resume-'))
const config = mkdtempSync(join(tmpdir(), 'ccw-config-'))
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio']
const env = { ...process.env, CLAUDE_CONFIG_DIR: config }

function run(extra, text, waitMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn('claude', [...base, ...extra], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let sessionId = ''
    let answer = ''
    const finish = (outcome) => { try { child.kill() } catch {} resolve({ sessionId, answer, ...outcome }) }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (record.type === 'system' && record.subtype === 'init') sessionId = record.session_id
        if (record.type === 'result') { answer = String(record.result ?? ''); finish({ isError: record.is_error === true }) ; return }
      }
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('exit', () => finish({ exited: true, stderr }))
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })}\n`)
    setTimeout(() => finish({ timedOut: true }), waitMs)
  })
}

const first = await run([], 'Remember the codeword: PLUM. Reply with exactly OK.')
console.log('1. first process:', JSON.stringify(first))
const projects = join(config, 'projects')
const files = readdirSync(projects).flatMap((name) => {
  try {
    return readdirSync(join(projects, name))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => join(projects, name, file))
  } catch { return [] }
})
console.log('2. transcripts written:', files.length, files.map((file) => `${file.split(/[\\/]/).pop()} ${readFileSync(file).length}B`))
const resumed = await run(['--resume', first.sessionId], 'What was the codeword? Reply with just the word.')
console.log('3. resumed process:', JSON.stringify(resumed))
const missing = await run(['--resume', '00000000-0000-4000-8000-000000000000'], 'hello')
console.log('4. resume of an unknown id:', JSON.stringify(missing))

// A verdict, not a wall of JSON: the point of this probe is the yes/no.
const persisted = files.length > 0
console.log('')
console.log(`persisted:  ${persisted ? 'yes' : 'no'}`)
console.log(`resumed:    ${resumed.answer === 'PLUM' ? 'yes (context carried)' : 'no'}`)
console.log(`unknown id: ${missing.isError === true ? 'error_during_execution, as expected' : 'unexpected success'}`)
if (!persisted || resumed.answer !== 'PLUM') {
  console.error('')
  console.error('The resume path in index.js is NOT supported by this CLI build; the primer fallback is all there is.')
  process.exitCode = 1
}
