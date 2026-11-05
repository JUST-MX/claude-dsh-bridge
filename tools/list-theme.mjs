// Report which theme tokens exist, grouped by family.
//
// The panel may only use tokens the theme actually publishes: a misspelled
// `var(--dsw-…)` falls back silently and the element renders unstyled, which no
// other guard can see. This reads the extracted theme bundle and prints the
// families, so choosing a colour is a lookup rather than a guess.
//
// Run: node tools/list-theme.mjs [filter]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const theme = readFileSync(join(here, '..', '.research', 'theme-client.js'), 'utf8')
const filter = (process.argv[2] ?? '').toLowerCase()

const families = new Map()
for (const match of theme.matchAll(/--dsw-(static|alias)-[a-z0-9-]+/g)) {
  const token = match[0]
  if (filter !== '' && !token.includes(filter)) continue
  const parts = token.split('-')
  const family = parts.slice(0, 4).join('-')
  if (!families.has(family)) families.set(family, new Set())
  families.get(family).add(token)
}

for (const family of [...families.keys()].sort()) {
  const tokens = [...families.get(family)].sort()
  console.log(`${family}  (${String(tokens.length)})`)
  console.log(`  ${tokens.join('  ')}`)
}
