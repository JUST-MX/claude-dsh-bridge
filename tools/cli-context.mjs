// Dump a readable window of the Claude Code executable around one string.
//
// tools/grep-cli.mjs answers "does this name exist"; this answers "what does the
// surrounding code do". The binary is packed JavaScript, so the context is
// minified but the string literals and property names are intact — enough to see
// which field an answer is read from.
//
// Run: node tools/cli-context.mjs "did not answer the questions" 2500
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const CLI = `${process.env.USERPROFILE}\\.local\\bin\\claude.exe`
const needle = process.argv[2]
const span = Number(process.argv[3] ?? 1600)
if (needle === undefined) throw new Error('usage: node tools/cli-context.mjs <needle> [span]')

const CHUNK = 8 * 1024 * 1024
const OVERLAP = 4096
const size = statSync(CLI).size
const handle = openSync(CLI, 'r')
const buffer = Buffer.alloc(CHUNK + OVERLAP)
const needleBuffer = Buffer.from(needle, 'latin1')

let offset = 0
let reported = 0
while (offset < size && reported < 4) {
  const read = readSync(handle, buffer, 0, buffer.length, offset)
  if (read <= 0) break
  const at = buffer.indexOf(needleBuffer)
  if (at >= 0 && at < read) {
    const start = Math.max(0, at - span)
    const end = Math.min(read, at + span)
    const text = buffer.subarray(start, end).toString('latin1')
    console.log(`--- hit at ${String(offset + at)} ---`)
    console.log(text.replace(/[^\x20-\x7e\n]/g, '·'))
    reported += 1
  }
  const step = read - OVERLAP
  if (step <= 0) break
  offset += step
}
closeSync(handle)
if (reported === 0) console.log(`no hit for ${needle}`)
