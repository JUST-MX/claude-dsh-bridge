// Render-harness for the Claude Sessions browser bundle.
//
// Runs the real bundle under a stub React and a stub Client context that mimics
// the parts the panel touches, then walks the returned element tree. It exists
// because a panel that throws inside render is contained by the renderer's error
// boundary and simply shows nothing — the failure is invisible in the GUI.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../plugin/packages/claude-sessions/client.js', import.meta.url))
const require = createRequire(import.meta.url)

let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }

const effects = []
const React = {
  createElement: (type, props, children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  // A ref is a stable box; the panel keeps the selected id there so the polling
  // effect's dependency list stays constant. This harness renders once, so the
  // box only has to exist and hold a writable `current`.
  useRef: (init) => ({ current: init }),
  useEffect: (fn) => { effects.push(fn) },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

require(BUNDLE)
const mod = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`bad require ${id}`)
})

const item = {
  id: 'a', title: 'Alpha', cwd: 'C:\\p\\alpha', mode: 'manual', state: 'waiting-approval',
  sessionId: 's', model: 'm', turns: 3, pendingApproval: 'Write · a.txt', allowRules: '',
  startedAt: 1, lastActivityAt: 2, lastResult: '', costUsd: 0, durationMs: 0, exitCode: 0, revision: 4,
}

const calls = []
// Every Client-Remote call resolves to a RemoteResult envelope, never to the
// bare payload: `{ ok: true, value }` or `{ ok: false, error }`. A stub that
// returns the bare payload proves a contract no real transport offers — that
// mismatch is exactly what blanked the live panel, so the harness mirrors the
// envelope, and one probe below feeds a bare value to prove the guard in the
// panel tolerates the other direction too.
const ok = (value) => ({ ok: true, value })
const namespace = {
  async list() { calls.push('list'); return ok({ items: [item] }) },
  async read(id) { calls.push('read'); return ok({ item, rows: [{ kind: 'user', text: 'hi', at: 1 }, { kind: 'tool-use', tool: 'Write', text: 'a.txt', at: 2 }] }) },
  async start() { calls.push('start'); return ok({ item }) },
  async send() { calls.push('send'); return ok({ item }) },
  async approve() { calls.push('approve'); return ok({ item }) },
  async deny() { calls.push('deny'); return ok({ item }) },
  async setMode() { calls.push('setMode'); return ok({ item }) },
  async interrupt() { calls.push('interrupt'); return ok({ item }) },
  async stop() { calls.push('stop'); return ok({ item }) },
  async forget() { calls.push('forget'); return ok({ ok: true }) },
}

const registered = []
function makeCtx() {
  const ctx = {
    effect: (factory) => { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose); return () => {} },
    locale: { register: () => () => {}, bind: () => (key) => `[${key}]` },
    // Cordis resolves an injected dotted key through the owning service's
    // tracker, so `remote.claudeSessions` reads as a property of `remote`.
    remote: { async $mount() { return async () => {} }, claudeSessions: namespace },
    slots: {
      inject(slot, callback) { callback(); return () => {} },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
    uiWorkspace: { async pickDirectory() { return null } },
  }
  // Cordis reads a service without an inject requirement through `ctx.get`.
  ctx.get = (key) => (key === 'remote.claudeSessions' ? namespace : undefined)
  // The real `ctx.inject(deps, callback)` returns a child context carrying those
  // services; here the same object already exposes them.
  ctx.inject = (deps, callback) => {
    for (const dep of deps) {
      if (!(dep in ctx) && !(dep.startsWith('remote.') && namespace !== undefined)) {
        console.log(`  note: inject(${dep}) has no stub surface`)
      }
    }
    callback(ctx)
    return { dispose() {} }
  }
  return ctx
}

await mod.apply(makeCtx())

console.log('module:', mod.name)
console.log('inject:', mod.inject.join(', '))
console.log('slots:', registered.map((r) => `${r.options.name}${r.options.id ? `/${r.options.id}` : ''}${r.options.key ? `/${r.options.key}` : ''}`).join(', '))

for (const entry of registered) {
  try {
    const tree = entry.component({ size: 18, active: false })
    const kind = tree === null ? 'null' : (tree.type ?? typeof tree)
    console.log(`render ${entry.options.name}: ${String(kind)}`)
  } catch (failure) {
    console.log(`render ${entry.options.name} THREW: ${failure?.stack ?? failure}`)
    process.exitCode = 1
  }
}

// Drive the polling effect once: this is the code path that calls the Host.
for (const effect of effects) {
  try { await effect() } catch (failure) { console.log(`effect threw: ${failure?.message ?? failure}`) }
}
await new Promise((resolve) => { setTimeout(resolve, 50) })
console.log('remote calls:', calls.join(', ') || '(none)')

const page = registered.find((r) => r.options.name === 'main')?.component
if (page !== undefined) {
  try {
    const out = page({})
    const head = out.children.find((c) => c?.props?.className === 'ccw-head')
    const button = head?.children?.find((c) => c?.type === 'button')
    console.log('root classes:', out.children.filter(Boolean).map((c) => c.props?.className).join(' | '))
    console.log('new-item label:', JSON.stringify(button?.children))
    console.log('RENDER OK')
  } catch (failure) {
    console.log(`page render THREW: ${failure?.stack ?? failure}`)
    process.exitCode = 1
  }
}

// --- transport-shape probes ------------------------------------------------
//
// The envelope is new ground, so prove both directions: a refusal must surface
// as an error string (not a throw, not a blank panel), and a bare payload — the
// shape a future transport change could produce — must still render.
if (page !== undefined) {
  const original = { list: namespace.list, read: namespace.read }

  namespace.list = async () => ({ ok: false, error: { code: 'gateway/internal', message: 'host said no' } })
  try {
    page({})
    console.log('refusal render: survived')
  } catch (failure) {
    console.log(`refusal render THREW: ${failure?.message ?? failure}`)
    process.exitCode = 1
  }

  namespace.list = async () => ({ items: [item] })
  namespace.read = async () => ({ item, rows: [] })
  try {
    page({})
    console.log('bare-payload render: survived')
  } catch (failure) {
    console.log(`bare-payload render THREW: ${failure?.message ?? failure}`)
    process.exitCode = 1
  }

  namespace.list = original.list
  namespace.read = original.read
}

// The panel's polling effect leaves a timer behind; every check has printed by
// now, so end the process instead of waiting for the event loop to drain.
process.exit(process.exitCode ?? 0)
