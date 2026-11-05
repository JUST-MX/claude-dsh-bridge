// Locale-coverage guard.
//
// The panel's text comes from `DICT` in `src/client-body.js`, which
// `tools/gen-locale.mjs` mirrors into `locale/en.json` and `locale/zh.json`.
// Two failures are invisible in every other harness:
//
// 1. A `t('key')` call with no matching entry renders the literal key on screen.
// 2. A declared entry nobody calls is dead weight that also hides typo'd keys,
//    because a typo looks exactly like another unused string.
//
// Run: node tools/check-locale.mjs

import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
const source = readFileSync(`${root}/plugin/packages/claude-sessions/src/client-body.js`, 'utf8')

/** Keys a call site asks for by literal: `t('modeAuto')`. */
const called = new Set()
for (const match of source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/g)) called.add(match[1])

/**
 * Keys reached indirectly. `kindLabel` maps a transcript row's `kind` to a
 * dictionary key through a table, so the call there is `t(key)` and the literal
 * `t('kindUser')` never appears. Those table entries are quoted strings, and the
 * table is the only place this panel does it, so they are collected by name.
 */
const indirect = new Set()
const table = /const KEYS = \{([\s\S]*?)\n  \}/.exec(source)
if (table !== null) {
  // Only the VALUES are dictionary keys; the names on the left are the Host's
  // raw `kind` strings and are not looked up.
  for (const match of table[1].matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) indirect.add(match[1])
}

/**
 * Keys reached through the COMMANDS table: the composer's menu maps each entry's
 * `key` to its description, so the call is `t(entry.key)` and the literal never
 * appears. Same reason as KEYS below — read the table rather than exempting the
 * names, which would let a typo in it go unnoticed.
 */
const commands = /const COMMANDS = \[([\s\S]*?)\n\]/.exec(source)
if (commands !== null) {
  for (const match of commands[1].matchAll(/key:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) indirect.add(match[1])
}

/** Read by the sidebar through `ctx.locale.bind`, never through `t()`. */
const EXEMPT = new Set(['panel'])

const referenced = new Set([...called, ...indirect, ...EXEMPT])

/** Keys the dictionary declares, taken from the generated en.json. */
const en = JSON.parse(readFileSync(`${root}/plugin/packages/claude-sessions/locale/en.json`, 'utf8'))
const zh = JSON.parse(readFileSync(`${root}/plugin/packages/claude-sessions/locale/zh.json`, 'utf8'))
const declared = new Set(Object.keys(en).filter((key) => key !== 'meta'))

const missing = [...called].filter((key) => !declared.has(key)).sort()
const dead = [...declared].filter((key) => !referenced.has(key)).sort()
const untranslated = [...declared].filter((key) => !(key in zh)).sort()

console.log(`check-locale: ${String(referenced.size)} key(s) referenced, ${String(declared.size)} declared`)

if (missing.length > 0) {
  console.log('  used but not declared (the panel would show the raw key):')
  for (const key of missing) console.log(`    ${key}`)
  process.exitCode = 1
}
if (dead.length > 0) {
  console.log('  declared but never used (or a typo at the call site):')
  for (const key of dead) console.log(`    ${key}`)
  process.exitCode = 1
}
if (untranslated.length > 0) {
  console.log('  declared in en.json but missing from zh.json:')
  for (const key of untranslated) console.log(`    ${key}`)
  process.exitCode = 1
}

if (process.exitCode === undefined) console.log('check-locale: every key is declared, used, and translated')
