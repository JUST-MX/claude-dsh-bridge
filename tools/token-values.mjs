// Print the concrete value of a few theme tokens, so a colour choice is based on
// the real palette instead of on a token's name.
//
// Run: node tools/token-values.mjs --dsw-alias-brand-primary --dsw-alias-bg-base
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const theme = readFileSync(join(here, '..', '.research', 'theme-client.js'), 'utf8')

const wanted = process.argv.slice(2)
if (wanted.length === 0) throw new Error('usage: node tools/token-values.mjs <token> [...]')

for (const token of wanted) {
  const values = new Set()
  const escaped = token.replace(/-/g, '\\-')
  const pattern = new RegExp(`${escaped}:([^;}"\\n]+)`, 'g')
  let match
  while ((match = pattern.exec(theme)) !== null) values.add(match[1].trim())
  console.log(`${token}`)
  if (values.size === 0) console.log('  (not declared)')
  for (const value of values) console.log(`  ${value}`)
}
