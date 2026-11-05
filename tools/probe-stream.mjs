// What does `--include-partial-messages` actually add to the resident stream?
//
// The panel polls every two seconds. Without this flag the CLI emits one
// `assistant` record when the answer is FINISHED, so a long answer shows nothing
// at all until it lands; with it, the text arrives as token-sized
// `content_block_delta/text_delta` records and the Host can paint it while it is
// written. This probe measures how many records of each kind one turn produces,
// because that count is exactly why the Host buffers the deltas into one live row
// instead of appending a row per delta.
//
// Run: node tools/probe-stream.mjs [--partial]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'ccw-stream-'))
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio']
const extra = process.argv.includes('--partial') ? ['--include-partial-messages'] : []

const counts = new Map()
const child = spawn('claude', [...base, ...extra], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
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
    const key = `${record.type}${record.subtype ? `/${record.subtype}` : ''}` +
      `${record.event?.type ? `:${record.event.type}` : ''}${record.event?.delta?.type ? `/${record.event.delta.type}` : ''}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (record.type === 'result') {
      console.log(`partial: ${String(extra.length > 0)}`)
      for (const [name, value] of counts) console.log(`  ${name}: ${String(value)}`)
      const deltas = [...counts.entries()].filter(([name]) => name.includes('text_delta')).reduce((sum, [, value]) => sum + value, 0)
      console.log('')
      console.log(deltas > 0
        ? `partial text arrived in ${String(deltas)} delta(s) — the panel can paint it while it is written`
        : 'no partial text: the answer only exists once it is finished')
      child.kill()
      process.exit(0)
    }
  }
})
child.stderr.on('data', () => {})
child.stdin.write(`${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Count from 1 to 30 in words, one per line.' }] },
  parent_tool_use_id: null,
})}\n`)
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1) }, 120_000)
