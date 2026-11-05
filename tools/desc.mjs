// Print one Remote descriptor from the generated Host face, next to a sibling, so
// a mismatch in shape (method name, parameter wires, result codec) is visible.
//
// Run: node tools/desc.mjs answer approve
import { readFileSync } from 'node:fs'

const file = 'plugin/packages/claude-sessions/typert.js'
const source = readFileSync(file, 'utf8')

/** The `"name": { … }` block for one endpoint, brace-balanced. */
function block(name) {
  const head = `  "${name}": {`
  const at = source.indexOf(head)
  if (at < 0) return null
  let depth = 0
  let index = at + head.length - 1
  for (; index < source.length; index += 1) {
    const ch = source[index]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, index + 1)
    }
  }
  return null
}

for (const name of process.argv.slice(2)) {
  const text = block(name)
  console.log(`===== ${name} =====`)
  console.log(text ?? '(absent from the Host face)')
  console.log('')
}
