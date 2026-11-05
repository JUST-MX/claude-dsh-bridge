// Theme-token guard.
//
// The panel styles itself entirely with `var(--dsw-alias-…)` custom properties.
// A typo in one of those names does not fail anything: CSS silently falls back to
// `inherit`, so the panel renders in the wrong colour and every existing harness
// still passes — the same blind spot that let a `?` reach the screen.
//
// This reads the tokens the live Theme service publishes and checks every
// `var(--name)` the Client half writes against them.
//
// Run: node tools/check-theme.mjs

import { readFileSync } from 'node:fs'

// Read the palette from the theme bundle itself rather than keeping a hand-copied
// list. The hand-copied one drifted: it held 18 aliases while the bundle publishes
// 403 properties, so using a real but unlisted token failed the guard and the
// failure had nothing to do with the code under test.
const theme = readFileSync(new URL('../.research/theme-client.js', import.meta.url), 'utf8')
const TOKENS = new Set(theme.match(/--dsw-[a-z0-9-]+(?=\s*:)/g) ?? [])

const path = new URL('../plugin/packages/claude-sessions/src/client-body.js', import.meta.url)
const source = readFileSync(path, 'utf8')

// The panel is allowed to declare its OWN custom property — item 2 of the review
// needs a violet accent, and the palette publishes no violet alias. A local
// property is fine as long as the same file defines it, in both themes; what
// would be a bug is reading a name nobody defines, which is what this guard is
// for. So `--ccw-…` names are checked against the CSS declarations instead of
// against the published list.
const local = new Set()
for (const match of source.matchAll(/^\s*(--ccw-[a-z0-9-]+)\s*:/gm)) local.add(match[1])

const used = new Set()
for (const match of source.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(match[1])

const unknown = [...used].filter((name) => !TOKENS.has(name) && !local.has(name)).sort()

// A published token the panel does not use is fine; reporting all 403 would bury
// the one line that matters.
console.log(`check-theme: ${String(used.size)} token(s) used, ${String(TOKENS.size)} published, ${String(local.size)} local`)

if (unknown.length > 0) {
  console.log('  unknown (CSS falls back silently, so nothing else would catch this):')
  for (const name of unknown) console.log(`    ${name}`)
  process.exitCode = 1
}

// A local property that only ever appears on the reading side is the same bug in
// a different costume: every `var(--ccw-x)` must have a `--ccw-x:`.
const undeclaredLocal = [...used].filter((name) => name.startsWith('--ccw-') && !local.has(name)).sort()

if (undeclaredLocal.length > 0) {
  console.log('  read but never declared by this panel:')
  for (const name of undeclaredLocal) console.log(`    ${name}`)
  process.exitCode = 1
}

if (process.exitCode === undefined) console.log('check-theme: every token the panel uses is published')
