// Find stray backticks inside the CSS template literal.
//
// A backtick in a CSS comment ends the template early and produces
//   SyntaxError: Invalid left-hand side expression in postfix operation
// at the line where the template closes. It has now happened four times, always
// in a comment that quotes a CSS custom property name.
//
// Run: node tools/find-backtick.mjs
import { readFileSync } from 'node:fs'

const source = readFileSync('plugin/packages/claude-sessions/src/client-body.js', 'utf8')
const start = source.indexOf('const CSS = `')
if (start < 0) {
  console.log('no CSS template found')
  process.exit(1)
}
const body = start + 'const CSS = `'.length

// The template's real end is the next backtick that terminates it; if that is not
// the start of a line, there is a stray one before it.
const end = source.indexOf('\n`', body)
const inner = source.slice(body, end < 0 ? source.length : end)
const lines = inner.split('\n')
let bad = 0
lines.forEach((line, index) => {
  if (line.includes('`')) {
    bad += 1
    console.log(`line ${String(index + 1)} of the template: ${line.trim()}`)
  }
})
console.log(bad === 0 ? 'no stray backtick inside the CSS template' : `${String(bad)} stray backtick(s)`)
process.exitCode = bad === 0 ? 0 : 1
