// Which stdio combinations may a sandboxed child use here?
//
// The panel's Host half talks to `claude` over pipes without trouble, because it
// runs inside the DSH process. Everything this workspace shells out to runs under
// the file sandbox instead, where `spawn` with the default `stdio: 'pipe'`
// reports EPERM. Writing an interactive probe therefore needs to know exactly
// which slots may be pipes — that is what this file measures, one combination at
// a time, so a failure names the slot rather than the whole call.
//
// Run: node tools/probe-stdio.mjs
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '.research', 'stdio')
mkdirSync(outDir, { recursive: true })

const NODE = process.execPath

/** Run one `node -e` with the given stdio shape and report what happened. */
function attempt(label, shape, files) {
  const handles = files.map((name) => openSync(join(outDir, name), 'w'))
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(NODE, ['-e', "process.stdout.write('ok'); process.exit(0)"], {
        stdio: shape(handles),
      })
    } catch (failure) {
      for (const handle of handles) closeSync(handle)
      resolve({ label, ok: false, why: `throw ${failure.code ?? failure.message}` })
      return
    }
    child.on('error', (failure) => {
      for (const handle of handles) closeSync(handle)
      resolve({ label, ok: false, why: `error ${failure.code ?? failure.message}` })
    })
    child.on('exit', (code) => {
      for (const handle of handles) closeSync(handle)
      resolve({ label, ok: code === 0, why: `exit ${String(code)}` })
    })
  })
}

const results = []
results.push(await attempt('all pipes', () => ['pipe', 'pipe', 'pipe'], []))
results.push(await attempt('stdin pipe + files', () => ['pipe', 'pipe', 'pipe'], ['a.out', 'a.err']))
results.push(await attempt('stdin pipe only', (h) => ['pipe', h[0], h[1]], ['b.out', 'b.err']))
results.push(await attempt('all files', (h) => [h[0], h[1], h[2]], ['c.in', 'c.out', 'c.err']))
results.push(await attempt('ignore all', () => ['ignore', 'ignore', 'ignore'], []))

for (const result of results) console.log(`${result.ok ? 'OK  ' : 'FAIL'}  ${result.label.padEnd(24)} ${result.why}`)
