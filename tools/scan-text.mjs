// Scan source for characters a lossy round-trip turned into "?".
//
// PowerShell 5.1's `Set-Content -Encoding utf8` once re-decoded a UTF-8 file as
// GBK and destroyed every non-ASCII character in it. The visible damage was a
// template literal that should have read "→ 自动" but read "?自动", and three
// em dashes that became " ?". None of it breaks syntax, so the syntax check, the
// render harness, and the click-through harness all passed while the panel showed
// a question mark where a direction arrow belonged.
//
// Run: node tools/scan-text.mjs [--self-test]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')

/**
 * The two shapes the corruption actually produced.
 *
 * 1. A template or string literal that OPENS with "?" — that is where an arrow
 *    lands ("`?${t('modeAuto')}`"). A real ternary is written "? `…`", with the
 *    backtick after the question mark, so this never matches legitimate code.
 * 2. A "?" glued to a following word with no space ("on failure ?and never"),
 *    which is where an em dash lands. This codebase always spaces a ternary
 *    ("x ? y : z"), so a glued "?" is a defect.
 */
const RULES = [
  {
    id: 'literal-opens-with-question-mark',
    match: (line) => /[`'"]\?/.test(line),
  },
  {
    id: 'question-mark-glued-to-word',
    // Exclude `??`/`?.`/`?=` operators and the spaced ternary this repo writes.
    match: (line) => /\s\?[A-Za-z\u4e00-\u9fff]/.test(line) && !/\?\?|\?\./.test(line),
  },
  {
    id: 'replacement-character',
    match: (line) => line.includes('\uFFFD'),
  },
]

/** A line inside a comment cannot reach the screen, so it cannot be the defect. */
function isComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line)
}

function scanText(text) {
  const found = []
  text.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.id !== 'replacement-character' && isComment(line)) continue
      if (!rule.match(line)) continue
      found.push({ line: index + 1, id: rule.id, text: line.trim().slice(0, 90) })
    }
  })
  return found
}

// The self-test is what makes this guard trustworthy: a scanner that has never
// caught anything is indistinguishable from one that cannot catch anything.
if (process.argv.includes('--self-test')) {
  const SAMPLES = [
    { text: "}, x === 'manual' ? `?${t('a')}` : `?${t('b')}`),", expect: true, why: 'arrow became ?' },
    { text: 'on any failure ?and never', expect: true, why: 'em dash became ?' },
    { text: 'const a = b ? c : d', expect: false, why: 'a legitimate ternary' },
    { text: '如果你愿意 ?可以这样做', expect: true, why: 'em dash between CJK' },
    { text: "}, x === 'manual' ? `→ ${t('a')}` : `→ ${t('b')}`),", expect: false, why: 'the repaired form' },
    { text: '// a comment may discuss ?anything', expect: false, why: 'a comment cannot reach the screen' },
    { text: 'const v = a ?? b', expect: false, why: 'the nullish operator' },
  ]
  let bad = 0
  for (const sample of SAMPLES) {
    const caught = scanText(sample.text).length > 0
    const ok = caught === sample.expect
    if (!ok) bad += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${sample.expect ? 'catches' : 'ignores'} ${sample.why}`)
  }
  if (bad !== 0) {
    console.log(`${String(bad)} sample(s) mis-classified`)
    process.exitCode = 1
  } else {
    console.log(`${String(SAMPLES.length)}/${String(SAMPLES.length)} samples classified correctly`)
  }
  process.exit(process.exitCode ?? 0)
}

function* sources(directory) {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === '.research' || name.startsWith('.')) continue
    const full = join(directory, name)
    const stats = statSync(full)
    if (stats.isDirectory()) yield* sources(full)
    // Prose is excluded: the docs quote the broken form on purpose.
    else if (/\.(js|mjs|json|yml|ps1)$/.test(name)) yield full
  }
}

let scanned = 0
const problems = []
for (const file of sources(root)) {
  scanned += 1
  const relative = file.slice(root.length + 1).split('\\').join('/')
  // This file holds the deliberately broken samples the self-test feeds to the
  // rules; scanning it would report its own fixtures as damage.
  if (relative === 'tools/scan-text.mjs') continue
  for (const problem of scanText(readFileSync(file, 'utf8'))) {
    problems.push({ file: relative, ...problem })
  }
}

if (problems.length === 0) {
  console.log(`scan-text: ${String(scanned)} file(s) — no lost characters`)
} else {
  for (const problem of problems) {
    console.log(`  ${problem.file}:${String(problem.line)}  ${problem.id}  ${problem.text}`)
  }
  console.log(`scan-text: ${String(problems.length)} problem(s)`)
  process.exitCode = 1
}
