// Inspect the panel's CSS block: balanced braces, no stray backtick (which would
// end the template literal early and break the whole bundle), and a quick report
// of the selectors it defines.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const body = readFileSync(join(here, '..', 'plugin', 'packages', 'claude-sessions', 'src', 'client-body.js'), 'utf8')

const START = 'const CSS = `'
const start = body.indexOf(START)
if (start < 0) throw new Error('the CSS block is gone')
const open = start + START.length
const end = body.indexOf('`', open)
if (end < 0) throw new Error('the CSS block is never closed')
const css = body.slice(open, end)

const problems = []
let used = new Set()
let defined = new Set()
if (css.includes('`')) problems.push('a backtick inside the template literal')
if (css.includes('${')) problems.push('an interpolation inside the template literal')

// Count braces outside of comments, since a comment may mention one.
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
const opens = (stripped.match(/\{/g) ?? []).length
const closes = (stripped.match(/\}/g) ?? []).length
if (opens !== closes) problems.push(`${String(opens)} "{" against ${String(closes)} "}"`)

// Every declaration must end in `;` inside a rule, or the next one is swallowed.
for (const rule of stripped.split('}')) {
  const inner = rule.includes('{') ? rule.slice(rule.indexOf('{') + 1) : ''
  for (const line of inner.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (!text.endsWith(';')) problems.push(`declaration without ";" — ${text.slice(0, 70)}`)
  }
}

const selectors = [...stripped.matchAll(/(^|\n)([^{}\n][^{}]*)\{/g)].map((m) => m[2].trim())

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`)
  process.exitCode = 1
} else {
  // Every class the render tree applies must have a rule, and every rule must be
  // reachable from the render tree: an orphaned selector is dead weight, and a
  // class with no rule is an invisible style bug.
  const usedNow = new Set([...body.matchAll(/className: '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)))
  for (const text of [...body.matchAll(/`ccw-[^`]*`/g)]) {
    for (const word of text[0].replaceAll('`', '').split(/\s+/)) if (word.startsWith('ccw-')) usedNow.add(word)
  }
  const definedNow = new Set()
  for (const selector of selectors) {
    for (const name of selector.matchAll(/\.(ccw-[A-Za-z0-9-]+)/g)) definedNow.add(name[1])
  }
  used = usedNow
  defined = definedNow
  for (const name of used) if (!defined.has(name)) problems.push(`class "${name}" has no rule`)
  for (const name of defined) if (!used.has(name)) problems.push(`rule ".${name}" matches no element`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-css: ${String(selectors.length)} rule(s), ${String(used.size)} class(es), braces balanced`)
}
