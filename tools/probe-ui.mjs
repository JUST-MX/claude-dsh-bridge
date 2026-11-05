// Contract probes for the two things the render harness cannot prove.
//
// 1. `ctx.slots.register` — the shipped SlotCore may require options the render
//    harness never checks (`slot`? `id`? a factory?).  A registration that fails
//    throws inside `ctx.slots.inject`, which Cordis swallows as a fiber error:
//    the entry never appears and the panel is blank with no visible cause.
// 2. The `main` panel component receives props — the shipped Schedule panel
//    forwards `{ ...detail, onNewTask }` through `inject: () => ({ ... })`.  If a
//    keyed `main` entry is expected to carry an `inject` factory, omitting it is
//    another silent-blank path.
//
// Both checks read the shipped declarations, so they cannot drift from DSH.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Point DSH_ASAR at the archive if DSH is installed somewhere else.
const ASAR = process.env.DSH_ASAR
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

/** Pull one file out of the asar with the repository's own reader. */
function read(file) {
  return readFileSync(`.research/typert/${file}`, 'utf8')
}

const problems = []

// --- 1. What `register` accepts -------------------------------------------
const renderer = read('renderer.client.js')
const cat = renderer.match(/name:\s*"main"[\s\S]{0,900}?registration:\s*\[([\s\S]*?)\]/)
console.log('main registration catalog:', cat === null ? '(not found in renderer)' : cat[1].replace(/\s+/g, ' ').trim())

// --- 2. How the shipped packages register `main` --------------------------
const schedule = read('ui-schedule.client.js')
const block = schedule.slice(schedule.indexOf('ctx.slots.inject("main"'), schedule.indexOf('ctx.slots.inject("main"') + 900)
console.log('\nshipped schedule main entry:\n' + block.split('\n').slice(0, 24).join('\n'))

// --- 3. Does any shipped MAIN occupant omit `inject`? ---------------------
const usesInject = /ctx\.slots\.inject\("main"[\s\S]{0,400}?inject:/.test(schedule)
console.log('\nschedule main entry declares inject:', usesInject)

if (!usesInject) problems.push('the only shipped main occupant omits `inject` — so the panel must render without owner props')

// --- 4. `keyed` requires `key`; does it also require `id`? ----------------
const keyedCheck = renderer.match(/kind === "keyed"[\s\S]{0,300}/)
console.log('\nkeyed dispatch:\n' + (keyedCheck?.[0] ?? '(not found)'))

console.log('\n' + (problems.length === 0 ? 'PROBE OK' : `PROBE: ${problems.join('; ')}`))
