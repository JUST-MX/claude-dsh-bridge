// Search the Claude Code executable for protocol field names.
//
// The binary is ~296 MB of packed JavaScript, so the question "what does the CLI
// call the field that carries AskUserQuestion answers?" can be answered by
// finding the string itself rather than by probing an interactive session —
// which this sandbox cannot do, because it refuses to spawn a child with a
// piped stdin (see tools/probe-stdio.mjs).
//
// Buffer#indexOf scans in C, so this walks the whole file in a few seconds and
// keeps a small overlap so a name split across two chunks is still found.
//
// Run: node tools/grep-cli.mjs updatedInput answers
//      node tools/grep-cli.mjs "Retrying in" --width 400 --limit 5
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const CLI = `${process.env.USERPROFILE}\\.local\\bin\\claude.exe`
const raw = process.argv.slice(2)
/** A positive integer flag, or its default when absent. */
const option = (name, fallback) => {
  const at = raw.indexOf(name)
  if (at < 0) return fallback
  const value = Number(raw[at + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const width = option('--width', 200)
const limit = option('--limit', 1)
const needles = raw.filter((value, index) => !value.startsWith('--')
  // Skip the value that belongs to a flag.
  && raw[index - 1] !== '--width' && raw[index - 1] !== '--limit')
if (needles.length === 0) throw new Error('usage: node tools/grep-cli.mjs <needle> [...] [--width N] [--limit N]')

const CHUNK = 8 * 1024 * 1024
const OVERLAP = 512
const size = statSync(CLI).size
const handle = openSync(CLI, 'r')
const buffer = Buffer.alloc(CHUNK + OVERLAP)
const counts = new Map(needles.map((needle) => [needle, 0]))
const samples = new Map()

const needlesBuffer = needles.map((needle) => Buffer.from(needle, 'latin1'))
let offset = 0
let chunks = 0
while (offset < size) {
  const read = readSync(handle, buffer, 0, buffer.length, offset)
  if (read <= 0) break
  chunks += 1
  for (let index = 0; index < needles.length; index += 1) {
    const needle = needles[index]
    const needleBuffer = needlesBuffer[index]
    let from = 0
    for (;;) {
      const at = buffer.indexOf(needleBuffer, from)
      if (at < 0 || at >= read) break
      counts.set(needle, counts.get(needle) + 1)
      const seen = samples.get(needle) ?? []
      if (seen.length < limit) {
        const start = Math.max(0, at - width)
        const window = buffer.subarray(start, Math.min(read, at + needle.length + width)).toString('latin1')
        // Printable-only, with a marker for every non-ASCII byte: the bundle is
        // UTF-8 but this reads latin1, so CJK arrives as runs of high bytes.
        seen.push(window.replace(/[^\x20-\x7e]/g, '·'))
        samples.set(needle, seen)
      }
      from = at + 1
    }
  }
  const step = read - OVERLAP
  if (step <= 0) break
  offset += step
}
closeSync(handle)

console.log(`scanned ${String(chunks)} chunk(s) of ${String(size)} bytes`)
for (const needle of needles) {
  console.log(`${needle}: ${String(counts.get(needle))}`)
  for (const sample of samples.get(needle) ?? []) {
    console.log(`  …${sample}…`)
    console.log('')
  }
}
