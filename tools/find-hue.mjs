// Find every literal colour in the theme bundle that sits in the violet/purple
// hue range.
//
// The panel wants a distinct accent for "final answer". The palette publishes
// families by name (amber, blue, deepseek, green, neutral, red) with no `violet`
// family, so the honest way to pick one is to look at the hex values rather than
// at the names.
//
// Run: node tools/find-hue.mjs 255 285
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const theme = readFileSync(join(here, '..', '.research', 'theme-client.js'), 'utf8')

const low = Number(process.argv[2] ?? 255)
const high = Number(process.argv[3] ?? 290)

/** Hue in degrees for one `#rrggbb`. */
function hue(hex) {
  const value = hex.replace('#', '')
  if (value.length !== 6) return null
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return null
  let h
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

/** The token each hex belongs to, so a choice is a token and not a literal. */
const owners = new Map()
for (const match of theme.matchAll(/(--dsw-[a-z0-9-]+):(#?[^;}"]+)/g)) {
  owners.set(match[2].trim().toLowerCase(), match[1])
}

const seen = new Map()
for (const match of theme.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
  const hex = match[0].toLowerCase()
  const h = hue(hex)
  if (h === null || h < low || h > high) continue
  if (!seen.has(hex)) seen.set(hex, owners.get(hex) ?? '(literal)')
}

for (const [hex, owner] of [...seen.entries()].sort()) console.log(`${hex}  ${owner}`)
if (seen.size === 0) console.log(`no literal colour with hue ${String(low)}–${String(high)}`)
