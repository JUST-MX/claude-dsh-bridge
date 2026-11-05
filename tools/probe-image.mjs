// Does an image pasted into the panel actually reach the model?
//
// The wire contract and the browser both accept an image block (probe-image.mjs
// shows a resident `-p` session answering questions about a picture), but neither
// proves the two halves are wired to each other. This writes a PNG whose colour is
// a codeword — a solid magenta square — and asks a real session what colour it is.
// A model that never received the image answers "I don't see an image"; one that
// did names the colour.
//
// Run: node tools/probe-image.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/** A solid-colour PNG, built by hand: no dependency, and the colour is the test. */
function solidPng(size, [red, green, blue]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    const crcBuffer = Buffer.alloc(4)
    crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, crcBuffer])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x += 1) {
      const at = y * (size * 3 + 1) + 1 + x * 3
      raw[at] = red
      raw[at + 1] = green
      raw[at + 2] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const cwd = mkdtempSync(join(tmpdir(), 'ccw-image-'))
const file = join(cwd, 'codeword.png')
// Magenta: a colour a model names without ambiguity and that no default UI colour
// could be mistaken for.
writeFileSync(file, solidPng(64, [255, 0, 255]))
const data = solidPng(64, [255, 0, 255]).toString('base64')

const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio']
const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
let answered = ''
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
    if (record.type === 'result') {
      answered = String(record.result ?? '')
      child.kill()
      finish()
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  const text = String(chunk)
  if (text.includes('unrecognized_model')) return
  if (text.trim() !== '') console.error(`stderr: ${text.trim().slice(0, 300)}`)
})

function finish() {
  const verdict = /magenta|purple|violet|紫|洋红|品红/i.test(answered)
  console.log(`answer: ${answered.slice(0, 300)}`)
  console.log('')
  console.log(verdict
    ? 'image reached the model: it named the colour'
    : 'the model did not describe the image')
  process.exit(verdict ? 0 : 1)
}

child.stdin.write(`${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      { type: 'text', text: 'What colour is this square? Answer with the colour name only.' },
    ],
  },
  parent_tool_use_id: null,
})}\n`)
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1) }, 90_000)
