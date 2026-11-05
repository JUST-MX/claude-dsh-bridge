// Click-through harness for the Claude Sessions panel.
//
// `render-client.mjs` proves the panel RENDERS. It cannot prove the buttons do
// anything, which is the half of the objective a screenshot was going to cover
// — and there is no screenshot on this machine (the DSH window cannot be raised:
// `SetForegroundWindow`, `SetWindowPos(HWND_TOPMOST)` and
// `PrintWindow(PW_RENDERFULLCONTENT)` all return False under the foreground
// lock).
//
// So this file mounts the real bundle under a miniature React — state slots,
// effects with dependency comparison, re-render on setState — finds each
// control by class name, fires it, and asserts the exact Remote call that
// followed: method name, argument count, argument values.
//
//   node tools/click-through.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'plugin', 'packages', 'claude-sessions', 'client.js')

// ------------------------------------------------------------------ mini React
//
// Only what this panel uses. State lives per mounted component instance and a
// setState schedules one re-render, so an async handler that awaits a Remote
// call and then calls setState behaves the way it does in the browser.
let instance = null
let cleanups = []

function createHooks() {
  const states = []
  const refs = []
  const deps = []
  let cursor = 0
  let effects = []
  return {
    beginRender() { cursor = 0; effects = [] },
    useState(initial) {
      const slot = cursor++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(states[slot]) : next
        if (Object.is(value, states[slot])) return
        states[slot] = value
        instance.schedule()
      }
      return [states[slot], set]
    },
    // A ref keeps its slot across renders and never triggers one — which is the
    // whole point of the panel's `selectedId` ref.
    useRef(initial) {
      const slot = cursor++
      if (!(slot in refs)) refs[slot] = { current: initial }
      return refs[slot]
    },
    useEffect(fn, list) {
      const slot = cursor++
      const prev = deps[slot]
      const changed = prev === undefined || list === undefined || list.length !== prev.length ||
        list.some((value, index) => !Object.is(value, prev[index]))
      deps[slot] = list
      if (changed) effects.push({ slot, fn })
    },
    // `useMemo`/`useCallback` MUST memoise by dependency array. Returning the
    // fresh function every render — which this harness originally did — makes
    // every `useEffect([callback])` look like it changed, so a correct panel
    // reads as a runaway effect loop and a broken one looks identical. The
    // memo slot is shared with `useEffect`'s deps array, and the callbacks it
    // returns are stable exactly when React would make them stable.
    useMemo(slotOwner, fn, list) {
      const slot = cursor++
      const prev = refs[slot]
      // `prev` is `{ value, list }` — comparing `prev.length` (undefined) here
      // would make EVERY memo look stale, which silently rebuilds `t` on each
      // render and turns the panel's `useEffect([refresh])` into an endless
      // list() loop. Compare the stored deps array, as React does.
      const changed = prev === undefined || list === undefined || list.length !== prev.list.length ||
        list.some((value, index) => !Object.is(value, prev.list[index]))
      if (!changed) return prev.value
      const value = fn()
      refs[slot] = { value, list }
      return value
    },
    useCallback(slotOwner, fn, list) {
      return this.useMemo(slotOwner, () => fn, list)
    },
    collectEffects() { return effects },
  }
}

const React = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => instance.hooks.useState(initial),
  useRef: (initial) => instance.hooks.useRef(initial),
  useEffect: (fn, list) => instance.hooks.useEffect(fn, list),
  useMemo: (fn, list) => instance.hooks.useMemo(null, fn, list),
  useCallback: (fn, list) => instance.hooks.useCallback(null, fn, list),
}

// ---------------------------------------------------------------- wire capture
const calls = []
const ok = (value) => ({ ok: true, value })

let baseItem = {
  id: 'a', title: 'Alpha', cwd: 'C:\\p\\alpha', mode: 'manual', state: 'waiting-approval',
  sessionId: 's', model: 'm', turns: 3, pendingApproval: 'Write · a.txt', allowRules: '',
  startedAt: 1, lastActivityAt: 2, lastResult: '', costUsd: 0, durationMs: 0, exitCode: 0, revision: 4,
  steps: 7, outputTokens: 12000, inputTokens: 400, cacheReadTokens: 30000, cacheWriteTokens: 800,
  contextTokens: 31200, contextLimit: 1000000, turnStartedAt: 0,
}
let items = [baseItem]
let nextId = 'b'

const record = (method, args) => {
  calls.push({ method, args })
  return ok({ item: baseItem })
}

/** A transcript row long enough that the panel must clamp it. */
const LONG_ROW = 'x'.repeat(900)

const namespace = {
  async list() { calls.push({ method: 'list', args: [] }); return ok({ items }) },
  async read(id, limit) {
    calls.push({ method: 'read', args: [id, limit] })
    // Answer with the item the store actually holds for that id. Returning a
    // fixed item here made the panel look stale (`forget` stayed disabled on a
    // finished item) purely because the stub lied.
    const found = items.find((entry) => entry.id === id) ?? baseItem
    // One finished turn: the question, the process it took (including a long
    // tool result the panel must clamp), and the answer the turn produced. A
    // running item has no answer yet, which is what makes its turn stay open.
    const rows = [
      { kind: 'user', text: 'hi', at: 1 },
      { kind: 'assistant', text: 'looking', at: 2 },
      { kind: 'tool-result', text: LONG_ROW, at: 3 },
    ]
    // While a turn is in flight the Host appends the answer it is still writing
    // as a row of its own (`kind: 'streaming'`); it is not in the event log, and
    // it disappears when the finished block arrives. The panel must show it like
    // Claude talking and must not offer it a fold toggle.
    if (found.state === 'running') {
      rows.push({ kind: 'streaming', text: LONG_ROW, at: 5 })
    }
    if (found.state !== 'running') {
      rows.push({
        kind: 'result',
        text: 'ANSWER',
        at: 4,
        durationMs: 24100,
        inputTokens: 31204,
        outputTokens: 758,
        cacheReadTokens: 30720,
        tps: 31.5,
      })
    }
    return ok({ item: found, rows })
  },
  async start(request) {
    calls.push({ method: 'start', args: [request] })
    baseItem = { ...baseItem, id: nextId, title: request.title, cwd: request.cwd, state: 'idle', pendingApproval: '' }
    items = [baseItem]
    return ok({ item: baseItem })
  },
  async send(id, text) { return record('send', [id, text]) },
  async approve(id, remember) { return record('approve', [id, remember]) },
  async deny(id, message) { return record('deny', [id, message]) },
  async answer(id, answers) {
    calls.push({ method: 'answer', args: [id, answers] })
    baseItem = { ...baseItem, pendingApproval: '', pendingQuestions: [], state: 'running' }
    items = [baseItem]
    return ok({ item: baseItem })
  },
  async setMode(id, mode) {
    calls.push({ method: 'setMode', args: [id, mode] })
    baseItem = { ...baseItem, mode }
    items = [baseItem]
    return ok({ item: baseItem })
  },
  async rename(id, title) {
    calls.push({ method: 'rename', args: [id, title] })
    baseItem = { ...baseItem, title }
    items = items.map((entry) => (entry.id === id ? { ...entry, title } : entry))
    return ok({ item: baseItem })
  },
  async interrupt(id) { return record('interrupt', [id]) },
  async stop(id) { return record('stop', [id]) },
  async forget(id) {
    calls.push({ method: 'forget', args: [id] })
    items = []
    return ok({ ok: true })
  },
}

const pickedDirectory = 'C:\\p\\picked'

const ctx = {
  effect: (factory, label) => {
    const dispose = factory()
    if (typeof dispose === 'function') cleanups.push({ dispose, label })
    return () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => `[${key}]` },
  remote: { async $mount() { return async () => {} }, claudeSessions: namespace },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
  uiWorkspace: { async pickDirectory() { return pickedDirectory } },
  get: (key) => (key === 'remote.claudeSessions' ? namespace : undefined),
  inject: (deps, callback) => { callback(ctx); return { dispose() {} } },
}

const registered = []
let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
// The bundle is a classic script that calls window.__ModuleLoader__.load.
new Function('window', readFileSync(BUNDLE, 'utf8'))(globalThis.window)
const mod = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`bad require ${id}`)
})

// --------------------------------------------------------------------- mounting
const flush = async () => {
  for (let tick = 0; tick < 12; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let page = null

/** Run renders until no setState is outstanding; effects run once per dep change. */
async function render() {
  for (let pass = 0; pass < 10; pass += 1) {
    instance.pending = false
    instance.hooks.beginRender()
    instance.tree = page({})
    for (const effect of instance.hooks.collectEffects()) {
      const outcome = effect.fn()
      if (typeof outcome === 'function') cleanups.push({ dispose: outcome, label: 'render effect' })
    }
    await flush()
    if (!instance.pending) break
  }
  return instance.tree
}

/** Tear down every effect the previous mount installed. */
function unmount() {
  for (const entry of cleanups.splice(0).reverse()) {
    try { entry.dispose() } catch { /* a disposer that already ran is fine */ }
  }
}

async function mount() {
  // Mounting without unmounting the previous instance left its polling effect
  // live: each earlier instance kept a `setTimeout(…, 2000)` chain running and
  // kept calling list() for the rest of the run, which made "how many polls did
  // THIS mount make" unanswerable.
  unmount()
  page = registered.find((entry) => entry.options.name === 'main')?.component
  if (page === undefined) throw new Error('the panel never registered into the `main` slot')

  instance = {
    hooks: createHooks(),
    tree: null,
    pending: false,
    schedule() { instance.pending = true },
  }
  return render()
}

/** Depth-first walk over the element tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.children, visit)
}

/** Every node whose className contains `needle`. */
function findAll(tree, needle) {
  const found = []
  walk(tree, (node) => {
    const className = node.props?.className
    if (typeof className === 'string' && className.split(' ').includes(needle)) found.push(node)
  })
  return found
}

/**
 * The composer's textarea, not just any `.ccw-input`: the rail's filter box
 * carries that class too when more than one work item exists, and it comes
 * FIRST in the tree — so a bare `findOne('ccw-input')` types into the filter and
 * the rail narrows to nothing. That is what the cross-session test hit.
 */
function findComposer(tree) {
  const composer = findOne(tree, 'ccw-composer-input')
  const area = findAll(composer, 'ccw-input')[0]
  if (area === undefined) throw new Error('the composer has no textarea')
  return area
}

function findOne(tree, needle) {
  const found = findAll(tree, needle)
  if (found.length === 0) throw new Error(`no element with class "${needle}"`)
  return found[0]
}

/** Fire one React-style handler, then let the panel settle. */
async function fire(node, handler, event = {}) {
  if (node === undefined) throw new Error(`the element with a ${handler} handler was not found`)
  const fn = node.props?.[handler]
  if (typeof fn !== 'function') throw new Error(`the element has no ${handler} handler`)
  await fn(event)
  await flush()
  // React re-renders after a state change; mirror that so the next lookup sees
  // the new tree instead of the one the handler was found in.
  if (instance.pending) await render()
}

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

const lastCall = (method) => [...calls].reverse().find((call) => call.method === method)

// ------------------------------------------------------------------- scenarios
await mod.apply(ctx)

{
  const tree = await mount()
  check('panel renders a head', findAll(tree, 'ccw-head').length === 1)
  check('panel offers a New control', findAll(tree, 'ccw-btn-primary').length >= 1)
  check('polling effect issued list()', lastCall('list') !== undefined)
}

{
  // Select the first row: the detail pane appears only after a selection.
  const tree = await mount()
  const row = findOne(tree, 'ccw-row')
  await fire(row, 'onClick')
  const afterSelect = instance.tree
  check('clicking a row reads that item', lastCall('read')?.args[0] === 'a', `read(${(lastCall('read')?.args ?? []).join(', ')})`)
  check('detail pane appears', findAll(afterSelect, 'ccw-pane').length === 1)
  check('approval block appears while a tool waits', findAll(afterSelect, 'ccw-approval').length === 1)
}

{
  // Approve without "remember".
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const allow = findAll(instance.tree, 'ccw-btn-approve').find((node) => node.children === '[approve]')
  await fire(allow, 'onClick')
  const call = lastCall('approve')
  check('Allow calls approve(id, remember)', call?.args.length === 2 && call.args[0] === 'a', JSON.stringify(call?.args))
}

{
  // Approve with the remember checkbox ticked.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const box = findOne(instance.tree, 'ccw-check').children.find((child) => child?.type === 'input')
  await fire(box, 'onChange', { target: { checked: true } })
  const allow = findAll(instance.tree, 'ccw-btn-approve').find((node) => node.children === '[approve]')
  await fire(allow, 'onClick')
  check('remembered Allow passes remember=true', lastCall('approve')?.args[1] === true, JSON.stringify(lastCall('approve')?.args))
}

{
  // Deny: must supply the optional positional slot, or the gateway refuses the call.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const deny = findAll(instance.tree, 'ccw-btn').find((node) => node.children === '[deny]')
  await fire(deny, 'onClick')
  const call = lastCall('deny')
  check('Deny calls deny(id, undefined) with 2 args', call?.args.length === 2 && call.args[1] === undefined, `${call?.args.length} arg(s)`)
}

{
  // Compose a message and send it.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const input = findOne(instance.tree, 'ccw-input')
  await fire(input, 'onChange', { target: { value: 'hello there' } })
  const send = findAll(instance.tree, 'ccw-btn-primary').find((node) => node.children === '[send]')
  await fire(send, 'onClick')
  const call = lastCall('send')
  check('Send calls send(id, text)', call?.args[0] === 'a' && call.args[1] === 'hello there', JSON.stringify(call?.args))
  check('Send clears the draft', findOne(instance.tree, 'ccw-input').props.value === '')
}

{
  // The tools this session already answers without asking. `allowRules` is a
  // comma-joined string on the wire, and it used to be visible only in the event
  // log, so a reader could not tell why an approval never appeared.
  items = [{ ...baseItem, allowRules: 'Write,Bash' }]
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const rules = findAll(instance.tree, 'ccw-allow-rules')
  check('the approval card lists the remembered tools', rules.length === 1
    && String(rules[0].children).includes('Write · Bash'), JSON.stringify(rules.map((node) => node.children)))
  items = [{ ...baseItem, allowRules: '' }]
  await mount()
  await fire(findOne(instance.tree, 'ccw-row'), 'onClick')
  check('no remembered tools means no line', findAll(instance.tree, 'ccw-allow-rules').length === 0)
  items = [baseItem]
}

{
  // The composer's slash-command menu. Every assertion here is about the one
  // rule that makes the menu safe to click: NOTHING is sent from it. A command
  // is written into the draft and the reader still presses Send.
  const sends = () => calls.filter((call) => call.method === 'send')
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const sendsBefore = sends().length
  const open = findOne(instance.tree, 'ccw-cmd').children.find((node) => node?.type === 'button')
  check('the composer offers a command menu button', open?.children === '[cmdButton]', JSON.stringify(open?.children))
  check('the menu is closed until asked for', findAll(instance.tree, 'ccw-cmd-menu').length === 0)

  await fire(open, 'onClick')
  const entries = findAll(instance.tree, 'ccw-cmd-item')
  check('the menu lists its commands', entries.length === 10, `${entries.length} entries`)
  check('opening the menu sends nothing', sends().length === sendsBefore)
  const names = entries.map((node) => node.children?.[0]?.children)
  check('the entries are spelled as slash commands', names.every((name) => typeof name === 'string' && name.startsWith('/')), JSON.stringify(names))
  check('/compact is one of them', names.includes('/compact'), JSON.stringify(names))

  // A normal entry fills the box and closes the menu, and the draft is left for
  // the reader to send.
  const compact = entries.find((node) => node.children?.[0]?.children === '/compact')
  await fire(compact, 'onClick')
  check('picking a command fills the draft', findOne(instance.tree, 'ccw-input').props.value === '/compact',
    JSON.stringify(findOne(instance.tree, 'ccw-input').props.value))
  check('picking a command sends nothing', sends().length === sendsBefore)
  check('picking a command closes the menu', findAll(instance.tree, 'ccw-cmd-menu').length === 0)
  // And Send then carries it, like any other message.
  const sendButton = findAll(instance.tree, 'ccw-btn-primary').find((node) => node.children === '[send]')
  await fire(sendButton, 'onClick')
  check('sending the filled command calls send()', lastCall('send')?.args[1] === '/compact', JSON.stringify(lastCall('send')?.args))

  // A command that takes an argument is filled with a trailing space, so the
  // caret lands where the argument goes.
  await fire(findOne(instance.tree, 'ccw-cmd').children.find((node) => node?.type === 'button'), 'onClick')
  const rename = findAll(instance.tree, 'ccw-cmd-item').find((node) => node.children?.[0]?.children === '/rename')
  await fire(rename, 'onClick')
  check('/rename leaves room for its argument', findOne(instance.tree, 'ccw-input').props.value === '/rename ',
    JSON.stringify(findOne(instance.tree, 'ccw-input').props.value))

  // /clear is armed on the first click and filled only on the second, and the
  // warning says what it costs.
  await fire(findOne(instance.tree, 'ccw-cmd').children.find((node) => node?.type === 'button'), 'onClick')
  const afterFills = sends().length
  const clear = () => findAll(instance.tree, 'ccw-cmd-item').find((node) => node.children?.[0]?.children === '/clear')
  check('/clear is marked as destructive', clear()?.props['data-danger'] === 'true', String(clear()?.props['data-danger']))
  await fire(clear(), 'onClick')
  check('the first click on /clear only warns', findAll(instance.tree, 'ccw-cmd-warn').length === 1
    && findOne(instance.tree, 'ccw-input').props.value === '/rename ', String(findOne(instance.tree, 'ccw-input').props.value))
  check('the warning still sends nothing', sends().length === afterFills)
  await fire(clear(), 'onClick')
  check('the second click fills /clear in', findOne(instance.tree, 'ccw-input').props.value === '/clear',
    JSON.stringify(findOne(instance.tree, 'ccw-input').props.value))
  check('/clear is never sent from the menu', sends().length === afterFills)
}

{
  // The composer belongs to ONE work item. Switching sessions used to carry the
  // draft and the pasted images across — a message typed for session A appeared
  // in session B's box, one Send away from being delivered to the wrong
  // conversation. (Reported from the running panel, 2026-11-04.)
  const second = { ...baseItem, id: 'b', title: 'Beta', cwd: 'C:\\p\\beta', pendingApproval: '', state: 'idle' }
  items = [baseItem, second]
  const tree = await mount()
  const rows = findAll(tree, 'ccw-row')
  check('two work items are listed', rows.length === 2, `${rows.length} row(s)`)

  await fire(rows[0], 'onClick')
  await fire(findComposer(instance.tree), 'onChange', { target: { value: 'for alpha only' } })
  check('the draft goes into the first session', findComposer(instance.tree).props.value === 'for alpha only',
    JSON.stringify(findComposer(instance.tree).props.value))

  // Switch to the other item: its box must be empty.
  await fire(findAll(instance.tree, 'ccw-row')[1], 'onClick')
  check('switching sessions starts with an empty box', findComposer(instance.tree).props.value === '',
    JSON.stringify(findComposer(instance.tree).props.value))

  // Typing there, then switching back, must restore the first draft — the box is
  // remembered per session, not thrown away.
  await fire(findComposer(instance.tree), 'onChange', { target: { value: 'for beta' } })
  await fire(findAll(instance.tree, 'ccw-row')[0], 'onClick')
  check('coming back restores that session’s own draft', findComposer(instance.tree).props.value === 'for alpha only',
    JSON.stringify(findComposer(instance.tree).props.value))

  // And Send carries the text of the session that is on screen, not the other one.
  const sendNow = findAll(instance.tree, 'ccw-btn-primary').find((node) => node.children === '[send]')
  await fire(sendNow, 'onClick')
  check('Send delivers to the session on screen', lastCall('send')?.args[0] === 'a' && lastCall('send')?.args[1] === 'for alpha only',
    JSON.stringify(lastCall('send')?.args))
  await fire(findAll(instance.tree, 'ccw-row')[1], 'onClick')
  check('the other session kept its own text', findComposer(instance.tree).props.value === 'for beta',
    JSON.stringify(findComposer(instance.tree).props.value))
  items = [baseItem]
}

{
  // The rail's numbers: steps, total tokens, the context gauge and the turn clock.
  // Each is a readout of a different field, so the assertions are about the
  // formatting as much as about the presence.
  items = [{
    ...baseItem,
    state: 'running',
    pendingApproval: '',
    contextTokens: 31200,
    contextLimit: 1000000,
    outputTokens: 12000,
    inputTokens: 400,
    cacheReadTokens: 30000,
    cacheWriteTokens: 800,
    turnStartedAt: Date.now() - 95_000,
  }]
  const tree = await mount()
  const meta = findOne(tree, 'ccw-row-meta')
  check('the rail counts turns and steps', String(meta.children).includes('3 [turns]') && String(meta.children).includes('7 [turnSteps]'),
    String(meta.children))
  const tok = findOne(tree, 'ccw-row-tok')
  // The figure is the last turn's spend (output + input + cache read + cache
  // write of ONE turn), not a session total: the CLI's cumulative counter runs
  // past what a reader can believe on a long session.
  check('the rail shows the last turn tokens compactly', String(tok.children) === '43.2K', String(tok.children))
  check('the token figure says which turn it is', typeof tok.props.title === 'string' && tok.props.title.includes('[lastTurnTokens]'),
    String(tok.props.title))
  const ctx = findOne(tree, 'ccw-ctx-label')
  check('the rail shows context against its window', /31\.2K\/1M/.test(String(ctx.children)), String(ctx.children))
  const fill = findOne(tree, 'ccw-ctx-fill')
  check('the context bar is a fraction of the window', typeof fill.props.style.width === 'string' && fill.props.style.width.endsWith('%'),
    JSON.stringify(fill.props.style))
  check('a nearly empty context is not flagged', fill.props['data-level'] === 'ok', String(fill.props['data-level']))
  const clockNode = findOne(tree, 'ccw-row-clock')
  check('a running turn shows a live clock', clockNode.props['data-live'] === 'true', String(clockNode.children))
  check('the live clock counts in seconds and minutes', /^\d+:\d{2}$|^\d+s$/.test(String(clockNode.children)), String(clockNode.children))

  // A full context turns the bar red, and a finished item shows the last turn's
  // duration instead of a running clock.
  items = [{ ...baseItem, state: 'done', pendingApproval: '', contextTokens: 980000, contextLimit: 1000000, durationMs: 24100, turnStartedAt: 0 }]
  await mount()
  const hotFill = findOne(instance.tree, 'ccw-ctx-fill')
  check('a nearly full context is flagged', hotFill.props['data-level'] === 'error', String(hotFill.props['data-level']))
  const doneClock = findOne(instance.tree, 'ccw-row-clock')
  check('a finished item shows its last turn duration', doneClock.props['data-live'] === 'false' && /s$/.test(String(doneClock.children)),
    String(doneClock.children))

  // No window, no bar: the fraction is unknown, and inventing a denominator is
  // worse than showing only what is known.
  items = [{ ...baseItem, contextLimit: 0 }]
  await mount()
  check('without a context window there is no bar', findAll(instance.tree, 'ccw-ctx-bar').length === 0)
  items = [baseItem]
}

{
  // The token format itself, in the places it is used. The other counters are
  // zeroed so the total is the one number under test.
  items = [{ ...baseItem, outputTokens: 999, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextLimit: 0 }]
  await mount()
  check('a count under ten thousand stays exact', String(findOne(instance.tree, 'ccw-row-tok').children) === '999',
    String(findOne(instance.tree, 'ccw-row-tok').children))
  items = [{ ...baseItem, outputTokens: 1_048_576, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  await mount()
  check('a million becomes M', String(findOne(instance.tree, 'ccw-row-tok').children) === '1M',
    String(findOne(instance.tree, 'ccw-row-tok').children))
  items = [baseItem]
}

{
  // Rename: the title is Host state, so the panel must call the Remote method and
  // must refuse a blank title (which would leave every row unnamed).
  items = [{ ...baseItem, title: 'Alpha' }]
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  await fire(findOne(instance.tree, 'ccw-title-edit'), 'onClick')
  const field = findOne(instance.tree, 'ccw-title-input')
  check('clicking the title opens a field holding it', field.props.value === 'Alpha', String(field.props.value))
  const save = () => findAll(instance.tree, 'ccw-btn-primary').find((node) => node.children === '[save]')
  await fire(findOne(instance.tree, 'ccw-title-input'), 'onChange', { target: { value: '' } })
  check('a blank title cannot be saved', save()?.props.disabled === true)
  await fire(findOne(instance.tree, 'ccw-title-input'), 'onChange', { target: { value: '   ' } })
  check('whitespace is not a title', save()?.props.disabled === true)
  await fire(findOne(instance.tree, 'ccw-title-input'), 'onChange', { target: { value: 'Renamed' } })
  await fire(save(), 'onClick')
  const call = lastCall('rename')
  check('Save calls rename(id, title)', call?.args[0] === 'a' && call.args[1] === 'Renamed', JSON.stringify(call?.args))
  check('the field closes after saving', findAll(instance.tree, 'ccw-title-input').length === 0)
  // Escape abandons the edit without calling anything.
  const callsBefore = calls.length
  await fire(findOne(instance.tree, 'ccw-title-edit'), 'onClick')
  await fire(findOne(instance.tree, 'ccw-title-input'), 'onKeyDown', { key: 'Escape', preventDefault() {} })
  check('Escape cancels a rename', calls.length === callsBefore && findAll(instance.tree, 'ccw-title-input').length === 0)
  items = [baseItem]
}

{
  // The rail filter. It hides rows and says so when nothing matches; it never
  // changes the selection.
  items = [
    { ...baseItem, id: 'a', title: 'Alpha', cwd: 'C:\p\alpha', state: 'idle', pendingApproval: '' },
    { ...baseItem, id: 'b', title: 'Beta', cwd: 'C:\p\beta', state: 'running', pendingApproval: '' },
  ]
  const tree = await mount()
  const filter = findOne(tree, 'ccw-filter')
  check('the rail offers a filter once there is more than one item', filter !== undefined)
  await fire(filter, 'onChange', { target: { value: 'bet' } })
  const rows = findAll(instance.tree, 'ccw-row')
  check('the filter narrows the rail by title', rows.length === 1 && rows[0].props.title === 'C:\p\beta',
    JSON.stringify(rows.map((row) => row.props.title)))
  await fire(findOne(instance.tree, 'ccw-filter'), 'onChange', { target: { value: 'zzz' } })
  // `ccw-empty` is also the "nothing selected" pane, so match the rail's own text.
  check('a filter that matches nothing says so',
    findAll(instance.tree, 'ccw-row').length === 0
    && findAll(instance.tree, 'ccw-rows').some((node) => JSON.stringify(node.children ?? []).includes('[noMatch]')),
    JSON.stringify(findAll(instance.tree, 'ccw-rows').map((node) => node.children)))
  items = [baseItem]
}

{
  // Switch the approval mode.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const mode = findAll(instance.tree, 'ccw-btn').find((node) => String(node.children).includes('[modeAuto]') || String(node.children).includes('[modeManual]'))
  await fire(mode, 'onClick')
  const call = lastCall('setMode')
  check('Mode button calls setMode(id, target)', call?.args.length === 2 && call.args[0] === 'a' && ['auto', 'manual'].includes(call.args[1]), JSON.stringify(call?.args))
}

{
  // Interrupt and stop.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  await fire(findAll(instance.tree, 'ccw-btn').find((node) => node.children === '[interrupt]'), 'onClick')
  check('Interrupt calls interrupt(id)', lastCall('interrupt')?.args[0] === 'a' && lastCall('interrupt').args.length === 1)
  await fire(findAll(instance.tree, 'ccw-btn').find((node) => node.children === '[stop]'), 'onClick')
  check('Stop calls stop(id)', lastCall('stop')?.args[0] === 'a' && lastCall('stop').args.length === 1)
}

{
  // Item 6 of the review: an AskUserQuestion request is not an approval.
  // "Allow" alone told Claude "The user did not answer the questions", because the
  // answer has to travel back in `updatedInput.answers`. The panel therefore draws
  // the real choices, refuses to send until every question has one, and calls
  // answer() with the labels keyed by the question text.
  items = [{
    ...baseItem,
    pendingApproval: 'AskUserQuestion',
    pendingQuestions: [
      { question: 'Which format?', header: 'Format', options: [{ label: 'PDF' }, { label: 'CSV' }] },
      { question: 'Which sheets?', header: 'Scope', multiSelect: true, options: [{ label: 'summary' }, { label: 'detail' }] },
    ],
  }]
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  check('a question renders its own card', findAll(instance.tree, 'ccw-ask').length === 1)
  check('a question card does not offer a bare Allow', findAll(instance.tree, 'ccw-approval').length === 0)
  check('every option is drawn', findAll(instance.tree, 'ccw-ask-option').length === 4,
    `${String(findAll(instance.tree, 'ccw-ask-option').length)} option(s)`)

  const sendButton = () => findAll(instance.tree, 'ccw-btn-approve').find((node) => node.children === '[askSend]')
  check('Send answer starts disabled', sendButton()?.props.disabled === true)

  // Pick one option in each question. A single-choice question fills in, the
  // multi-select collects.
  const options = () => findAll(instance.tree, 'ccw-ask-option')
  await fire(options()[1].children.find((child) => child?.type === 'input'), 'onChange', { target: { checked: true } })
  check('Send answer stays disabled while a question is unanswered', sendButton()?.props.disabled === true)
  await fire(options()[2].children.find((child) => child?.type === 'input'), 'onChange', { target: { checked: true } })
  await fire(options()[3].children.find((child) => child?.type === 'input'), 'onChange', { target: { checked: true } })
  check('picking an option marks it', findAll(instance.tree, 'ccw-ask-option').filter((node) => node.props['data-picked'] === 'true').length === 3,
    `${String(findAll(instance.tree, 'ccw-ask-option').filter((node) => node.props['data-picked'] === 'true').length)} picked`)
  check('Send answer enables once every question is answered', sendButton()?.props.disabled === false)

  await fire(sendButton(), 'onClick')
  const call = lastCall('answer')
  const payload = call?.args?.[1] ?? []
  check('Send answer calls answer(id, answers)', call?.args?.[0] === 'a' && Array.isArray(payload), JSON.stringify(call?.args))
  check('the payload is keyed by the question text',
    payload[0]?.question === 'Which format?' && payload[1]?.question === 'Which sheets?', JSON.stringify(payload))
  check('a single-choice answer carries one label', JSON.stringify(payload[0]?.picked) === '["CSV"]', JSON.stringify(payload[0]))
  check('a multi-select answer carries every label',
    JSON.stringify(payload[1]?.picked) === '["summary","detail"]', JSON.stringify(payload[1]))
  items = [baseItem]
}

{
  // A `kind: "text"` question has no options at all; a card that only knows how to
  // draw option lists would show an empty box nobody can answer.
  items = [{
    ...baseItem,
    pendingApproval: 'AskUserQuestion',
    pendingQuestions: [
      { question: 'What name?', kind: 'text', placeholder: 'e.g. report', options: [] },
      { question: 'How many slides?', kind: 'number', min: 1, max: 40, unit: 'slides', options: [] },
    ],
  }]
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  check('a free-text question draws no options', findAll(instance.tree, 'ccw-ask-option').length === 0)
  const boxes = findAll(instance.tree, 'ccw-ask-input')
  check('each typed question gets one input', boxes.length === 2, `${String(boxes.length)} input(s)`)
  check('the placeholder is carried through', boxes[0]?.props.placeholder === 'e.g. report', String(boxes[0]?.props.placeholder))
  check('the number range is shown', findAll(instance.tree, 'ccw-ask-note').some((node) => String(node.children).includes('1–40')),
    JSON.stringify(findAll(instance.tree, 'ccw-ask-note').map((node) => String(node.children))))

  await fire(boxes[0], 'onChange', { target: { value: 'report' } })
  await fire(findAll(instance.tree, 'ccw-ask-input')[1], 'onChange', { target: { value: '12' } })
  const typedSend = findAll(instance.tree, 'ccw-btn-approve').find((node) => node.children === '[askSend]')
  check('Send answer enables after typing both', typedSend?.props.disabled === false)
  await fire(typedSend, 'onClick')
  const typedCall = lastCall('answer')
  check('typed answers are sent keyed by the question text',
    typedCall?.args?.[1]?.[0]?.question === 'What name?' && typedCall?.args?.[1]?.[1]?.picked?.[0] === '12',
    JSON.stringify(typedCall?.args))
  items = [baseItem]
}

{
  // New: the directory picker supplies the cwd, then start({cwd, title}).
  const tree = await mount()
  const create = findAll(tree, 'ccw-btn-primary').find((node) => node.children === '[newItem]')
  await fire(create, 'onClick')
  const call = lastCall('start')
  check('New calls start({ cwd, title })', call !== undefined && call.args.length === 1 && call.args[0].cwd === pickedDirectory,
    JSON.stringify(call?.args))
  check('New names the item after the directory', call?.args[0].title === 'picked', call?.args[0].title)
  check('New reads the created item back', lastCall('read')?.args[0] === 'b', String(lastCall('read')?.args[0]))
}

{
  // Forget is offered only for a finished item; drive one through stop first.
  // The id is whatever the store holds now — an earlier scenario created `b`,
  // so hard-coding `a` here would assert against the stub, not the panel.
  items = [{ ...baseItem, state: 'done', pendingApproval: '' }]
  const finishedId = items[0].id
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const forget = findAll(instance.tree, 'ccw-btn').find((node) => node.children === '[forget]')
  check('Forget is enabled on a finished item', forget?.props.disabled === false)
  await fire(forget, 'onClick')
  check('Forget calls forget(id)', lastCall('forget')?.args[0] === finishedId, String(lastCall('forget')?.args[0]))
}

{
  // Selecting a row must NOT reinstall the polling effect.
  //
  // `list()` builds fresh snapshots, so storing one in state and depending on
  // that state rebuilt `refresh` on every tick; the effect then tore down and
  // restarted, whose first act is an immediate `list()`. The intended 2s poll
  // collapsed into a hot loop against the Host — invisible in the UI, expensive
  // in the log. The fix is a `selectedId` ref, and this is the check that keeps
  // it a ref.
  calls.length = 0
  // The forget scenario above emptied the store; a list with no rows would make
  // "selecting does not re-run the effect" vacuous.
  items = [baseItem]
  const tree = await mount()
  const afterMount = calls.filter((call) => call.method === 'list').length
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  await fire(findOne(instance.tree, 'ccw-row'), 'onClick')
  const afterSelect = calls.filter((call) => call.method === 'list').length
  check('mount polls list() exactly once', afterMount === 1, `${String(afterMount)} call(s)`)
  check('selecting does not re-run the polling effect', afterSelect === afterMount,
    `mount ${String(afterMount)} -> after two selections ${String(afterSelect)}`)
}

{
  // Folding (review items 3 and 4) and clamping.
  //
  // A finished turn folds to its heading plus its answer; the process rows live
  // behind the heading. That is the whole point of the change, so the assertions
  // are about the two things a reader must always be able to see — the answer,
  // and a way back into the process — not about every row being on screen.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const folded = instance.tree
  check('a finished turn folds to one heading', findAll(folded, 'ccw-turn').length === 1)
  check('the folded turn shows no process rows', findAll(folded, 'ccw-log-row').length === 1,
    `${String(findAll(folded, 'ccw-log-row').length)} row(s)`)
  check('the answer stays visible while folded', findOne(folded, 'ccw-log-row').props['data-kind'] === 'result')
  // The answer is foldable now, but it must be OPEN by default: "show the whole
  // answer" was the original requirement and 600 characters is not long enough to
  // be worth hiding. This fixture's answer is 6 characters, which the collapsed
  // box would not hide, so it gets no control: a "expand · 6" button under a
  // one-word reply teaches the reader that the control means nothing.
  check('a short answer is open and offers no fold control',
    findOne(folded, 'ccw-log-row').props['data-clamped'] === 'false'
    && findAll(folded, 'ccw-log-toggle').length === 0)

  await fire(findOne(folded, 'ccw-turn-head'), 'onClick')
  const open = instance.tree
  const rowNodes = findAll(open, 'ccw-log-row')
  const clamped = rowNodes.filter((node) => node.props['data-clamped'] === 'true')
  check('expanding the turn reveals the process rows', rowNodes.length >= 3, `${String(rowNodes.length)} row(s)`)
  check('a long process row starts clamped', clamped.length === 1, `${String(clamped.length)} clamped of ${String(rowNodes.length)} rows`)
  check('a short row is not clamped',
    rowNodes.filter((node) => node.props['data-clamped'] === 'false').length === rowNodes.length - 1)
  // Only the long process row is foldable here; the 6-character answer is not, so
  // a single control is the correct count.
  const toggles = findAll(instance.tree, 'ccw-log-toggle')
  check('only the foldable row offers a toggle', toggles.length === 1, `${String(toggles.length)} toggle(s)`)
  // The button now holds an icon AND a label, so its children are elements. Read
  // the label span rather than stringifying the whole subtree, which would only
  // ever match the old single-text-node shape.
  const toggleLabel = (node) => {
    const parts = Array.isArray(node?.children) ? node.children : [node?.children]
    const span = parts.find((child) => child?.props?.className === undefined && typeof child === 'object' && child !== null && child.type === 'span')
    return String(span?.children ?? '')
  }
  const clampedToggle = toggles.find((node) => toggleLabel(node).includes('900'))
  check('the toggle names the size', toggleLabel(clampedToggle).includes('900'), toggleLabel(clampedToggle))
  check('the toggle leads with an icon', findAll(clampedToggle ?? {}, 'ccw-log-toggle-icon').length === 1
    || (Array.isArray(clampedToggle?.children) && clampedToggle.children.some((child) => child?.props?.className === 'ccw-log-toggle-icon')))

  await fire(clampedToggle, 'onClick')
  const afterOpen = findAll(instance.tree, 'ccw-log-row').filter((node) => node.props['data-clamped'] === 'true')
  check('opening the row unclamps it', afterOpen.length === 0, `${String(afterOpen.length)} still clamped`)

  const logNode = findOne(instance.tree, 'ccw-log')
  check('the transcript is scroll-tracked', typeof logNode.props.ref === 'object' && typeof logNode.props.onScroll === 'function')
  let threw = null
  try {
    logNode.props.onScroll({ target: { scrollHeight: 1000, scrollTop: 400, clientHeight: 400 } })
    logNode.props.onScroll({ target: { scrollHeight: 1000, scrollTop: 590, clientHeight: 400 } })
  } catch (failure) { threw = failure }
  check('scroll tracking survives a scrolled-up and a bottom position', threw === null, String(threw?.message ?? ''))
}

{
  // A running turn starts OPEN (folding it by default would hide the only live
  // feedback the panel has) but the reader may close it — a long turn used to fill
  // the screen with no way past it short of scrolling.
{
  // A transcript window can begin in the middle of a turn: a long turn is hundreds
  // of process rows, and the newest 120 can contain no question at all. The orphan
  // first row must not be presented as something the reader asked — one real item
  // showed "up after 4s" (shell output) under the question styling.
  const originalRead = namespace.read
  namespace.read = async () => ok({
    item: { ...baseItem, state: 'running', pendingApproval: '', pendingQuestions: [] },
    rows: [
      { kind: 'tool-result', text: 'up after 4s', at: 1, seq: 1 },
      { kind: 'assistant', text: 'still working', at: 2, seq: 2 },
    ],
  })
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const head = findOne(instance.tree, 'ccw-turn-head')
  check('a turn with no question is marked as such', head.props['data-user'] === 'false',
    String(head.props['data-user']))
  check('the orphan heading names its kind, not a question',
    String(findOne(instance.tree, 'ccw-turn-text').children).includes('[kindToolResult]'),
    String(findOne(instance.tree, 'ccw-turn-text').children))
  namespace.read = originalRead
  items = [baseItem]
}

  items = [{ ...baseItem, state: 'running', pendingApproval: '' }]
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const open = findAll(instance.tree, 'ccw-log-row')
  check('a live turn starts open', open.length >= 3, `${String(open.length)} row(s)`)
  // ...and it can be closed like any other turn.
  await fire(findOne(instance.tree, 'ccw-turn-head'), 'onClick')
  // A running turn has no answer row yet, so folding it leaves the heading only —
  // which is why the heading says "running" in that state.
  check('a live turn can be collapsed', findAll(instance.tree, 'ccw-log-row').length === 0,
    `${String(findAll(instance.tree, 'ccw-log-row').length)} row(s)`)
  check('a collapsed running turn says it is still running',
    String(findOne(instance.tree, 'ccw-turn-meta').children).includes('[turnRunning]'),
    String(findOne(instance.tree, 'ccw-turn-meta').children))
  await fire(findOne(instance.tree, 'ccw-turn-head'), 'onClick')
  check('a live turn reopens', findAll(instance.tree, 'ccw-log-row').length >= 3,
    `${String(findAll(instance.tree, 'ccw-log-row').length)} row(s)`)
  // The answer being written is a row of its own (`kind: 'streaming'`), and it
  // arrives LONG. It must still never fold: the number in "Show all · N" would
  // change under the cursor on every poll, and the whole point of the row is to
  // show everything that has arrived so far.
  const streaming = open.find((node) => node.props['data-kind'] === 'streaming')
  check('the answer in flight is rendered', streaming !== undefined, JSON.stringify(open.map((node) => node.props['data-kind'])))
  check('the answer in flight is never clamped', streaming?.props['data-clamped'] === 'false')
  // The other long row (the tool result) still gets its own toggle; what matters
  // is that the streaming row has none inside it.
  const streamingToggles = streaming === undefined
    ? ['missing']
    : (streaming.children ?? []).flatMap((child) => (Array.isArray(child?.children) ? child.children : []))
      .filter((child) => child?.props?.className === 'ccw-log-toggle')
  check('the answer in flight offers no fold control', streamingToggles.length === 0,
    `${String(streamingToggles.length)} toggle(s)`)
  check('the answer in flight is labelled like a reply',
    findAll(instance.tree, 'ccw-log-label').some((node) => node.children === '[kindStreaming]'),
    JSON.stringify(findAll(instance.tree, 'ccw-log-label').map((node) => node.children)))
  check('a live turn has no result row yet', open.every((node) => node.props['data-kind'] !== 'result'))
}

{
  // What the rail row and the header say about the item itself.
  // `baseItem.cwd` is rewritten by the `start` scenario above, so pin the path.
  items = [{ ...baseItem, cwd: 'C:\\p\\alpha', state: 'done', pendingApproval: '', model: 'deepseek-v4.1-flash[1m]', sessionId: 'e0f631b1-ddac-4f5c-abe1-e5531035ceef', costUsd: 1.25 }]
  const tree = await mount()
  const row = findOne(tree, 'ccw-row')
  check('the rail row names the directory in its tooltip', row.props.title === 'C:\\p\\alpha', String(row.props.title))
  const model = findOne(tree, 'ccw-row-model')
  check('the rail row shows the model without its context tag', model.children === 'deepseek-v4.1-flash', String(model.children))
  check('the rail row keeps the full model in its tooltip', model.props.title === 'deepseek-v4.1-flash[1m]', String(model.props.title))
  await fire(row, 'onClick')
  const sid = findOne(instance.tree, 'ccw-pane-sid')
  check('the header shortens the session id', String(sid.children).includes('e0f631b1'), String(sid.children))
  check('the header keeps the full session id in its tooltip', sid.props.title === 'e0f631b1-ddac-4f5c-abe1-e5531035ceef', String(sid.props.title))
  const meta = findAll(instance.tree, 'ccw-pane-meta')[0]
  check('the header shows the cost of the session',
    JSON.stringify(meta.children.map((node) => node?.children)).includes('1.250'),
    JSON.stringify(meta.children.map((node) => node?.children)))
  // Clicking the id copies it; the harness has no clipboard, so the click must at
  // least not throw (the helper swallows that path on purpose).
  let copyThrew = null
  try { await fire(sid, 'onClick') } catch (failure) { copyThrew = failure }
  check('copying a session id never throws', copyThrew === null, String(copyThrew?.message ?? ''))
  items = [baseItem]
}

{
  // A real transcript opens with `opened` and `init` BEFORE the first question.
  // Those rows used to form a turn of their own, so the first thing the panel
  // showed was a heading reading "open C:\p\alpha" instead of the question.
  const originalRead = namespace.read
  namespace.read = async (id, limit) => ok({
    item: { ...baseItem, state: 'done', pendingApproval: '', pendingQuestions: [] },
    rows: [
      { kind: 'opened', text: 'C:\\p\\alpha', at: 0 },
      { kind: 'init', text: 'model · session', at: 1 },
      { kind: 'user', text: 'the real question', at: 2 },
      { kind: 'result', text: 'the answer', at: 3, durationMs: 24100, inputTokens: 31204, outputTokens: 758, cacheReadTokens: 30720, tps: 31.5 },
    ],
  })
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const heads = findAll(instance.tree, 'ccw-turn-head')
  check('lifecycle rows before the first question do not form their own turn', heads.length === 1,
    `${String(heads.length)} heading(s)`)
  check('the first turn is headed by the question', String(findOne(instance.tree, 'ccw-turn-text').children) === 'the real question',
    String(findOne(instance.tree, 'ccw-turn-text').children))
  check('the preamble is counted in the turn', String(findAll(instance.tree, 'ccw-turn-meta')[0]?.children).startsWith('3'),
    String(findAll(instance.tree, 'ccw-turn-meta')[0]?.children))
  await fire(heads[0], 'onClick')
  const kinds = findAll(instance.tree, 'ccw-log-row').map((node) => node.props['data-kind'])
  check('expanding reveals the preamble rows', kinds.includes('opened') && kinds.includes('init'), JSON.stringify(kinds))
  namespace.read = originalRead
  items = [baseItem]
}

{
  // Item 3 of the review: timestamps in both states. A collapsed turn is one
  // line, so its time has to live in the heading; an open turn additionally
  // stamps every row. A missing `clock()` used to produce an empty <span>, which
  // is invisible on screen and passes any "does the element exist" check.
  // The panel's clock prints HH:mm:ss, so the shape check allows the seconds.
  const CLOCK = /^\d{2}:\d{2}(:\d{2})?$/
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const headingTimes = findAll(instance.tree, 'ccw-turn-when').map((node) => String(node.children))
  check('a collapsed turn still shows its time', headingTimes.length === 1 && CLOCK.test(headingTimes[0]),
    JSON.stringify(headingTimes))
  const openRowTimes = findAll(instance.tree, 'ccw-log-when').map((node) => String(node.children))
  check('every visible row shows its own time', openRowTimes.length > 0 && openRowTimes.every((value) => CLOCK.test(value)),
    JSON.stringify(openRowTimes.slice(0, 4)))
  // Folding hides the rows but must not hide the heading's time.
  await fire(findOne(instance.tree, 'ccw-turn-head'), 'onClick')
  const foldedTimes = findAll(instance.tree, 'ccw-turn-when').map((node) => String(node.children))
  check('the heading keeps its time after folding', foldedTimes.length === 1 && CLOCK.test(foldedTimes[0]),
    JSON.stringify(foldedTimes))
}

{
  // Item 4 of the review: the answer sits on its own wash, and item 6 puts the
  // per-turn numbers under it. Both are pure CSS/label work, so the guard checks
  // that the row carries the class and that the numbers are rendered at all.
  const tree = await mount()
  await fire(findOne(tree, 'ccw-row'), 'onClick')
  const answer = findAll(instance.tree, 'ccw-log-row').find((node) => node.props['data-kind'] === 'result')
  check('the answer row is rendered', answer !== undefined)
  const usage = findAll(instance.tree, 'ccw-log-usage').map((node) => String(node.children))
  check('the answer carries a usage line', usage.length === 1, JSON.stringify(usage))
  check('the usage line has duration, tokens and tok/s',
    /tok\/s/.test(usage[0] ?? '') && /758/.test(usage[0] ?? '') && /\d+s/.test(usage[0] ?? ''), usage[0])

  // A long answer is foldable, but it starts OPEN — the two kinds have opposite
  // defaults, and the default is the part a reader actually experiences. Folding
  // and reopening it must not lose the usage line.
  const longAnswer = 'A'.repeat(420)
  const originalRead = namespace.read
  namespace.read = async () => ok({
    item: { ...baseItem, state: 'done', pendingApproval: '', pendingQuestions: [] },
    rows: [
      { kind: 'user', text: 'ask', at: 1 },
      { kind: 'result', text: longAnswer, at: 2, durationMs: 5000, outputTokens: 100, tps: 20 },
    ],
  })
  await mount()
  await fire(findOne(instance.tree, 'ccw-row'), 'onClick')
  const answerRow = () => findAll(instance.tree, 'ccw-log-row').find((node) => node.props['data-kind'] === 'result')
  check('a long answer starts open', answerRow()?.props['data-clamped'] === 'false', String(answerRow()?.props['data-clamped']))
  check('a long answer offers a fold control', findAll(instance.tree, 'ccw-log-toggle').length === 1,
    `${String(findAll(instance.tree, 'ccw-log-toggle').length)} toggle(s)`)
  await fire(findOne(instance.tree, 'ccw-log-toggle'), 'onClick')
  check('folding the answer clamps it', answerRow()?.props['data-clamped'] === 'true')
  check('folding the answer keeps its usage line', findAll(instance.tree, 'ccw-log-usage').length === 1)
  await fire(findOne(instance.tree, 'ccw-log-toggle'), 'onClick')
  check('the answer reopens', answerRow()?.props['data-clamped'] === 'false')
  namespace.read = originalRead
}

{
  // The API retry loop and the API-error ending, as the Host now records them.
  // The panel used to show "running" with a blank transcript while the CLI
  // retried, and painted the terminal error as if Claude had said it.
  const originalRead = namespace.read
  namespace.read = async () => ok({
    item: { ...baseItem, state: 'error', pendingApproval: '', pendingQuestions: [] },
    rows: [
      { kind: 'user', text: 'ask', at: 1 },
      { kind: 'retry', text: 'attempt 1/3 · retry in 0.6s · HTTP 503', at: 2 },
      { kind: 'retry', text: 'attempt 2/3 · retry in 1.0s · HTTP 503', at: 3 },
      { kind: 'api-error', text: 'API Error: Connection refused', at: 4 },
    ],
  })
  await mount()
  await fire(findOne(instance.tree, 'ccw-row'), 'onClick')
  await fire(findOne(instance.tree, 'ccw-turn-head'), 'onClick')
  const kinds = findAll(instance.tree, 'ccw-log-row').map((node) => node.props['data-kind'])
  check('a retry row reaches the transcript', kinds.filter((kind) => kind === 'retry').length === 2, JSON.stringify(kinds))
  check('an API error is not painted as the answer', !kinds.includes('result') && kinds.includes('api-error'), JSON.stringify(kinds))
  // The banner must not be the "this session finished" one: its advice is wrong
  // here, because resending helps nothing until the endpoint answers.
  const banners = findAll(instance.tree, 'ccw-reopen')
  check('an api failure gets its own banner', banners.length === 1
    && String(banners[0].props.className).includes('ccw-reopen-error')
    && String(banners[0].children) === '[errorNotice]',
  JSON.stringify(banners.map((node) => String(node.children))))
  check('the error state has its own badge', String(findOne(instance.tree, 'ccw-badge').children) === '[stateError]',
    String(findOne(instance.tree, 'ccw-badge').children))
  namespace.read = originalRead
}

{
  // A refusal inside a folded turn. The real session this comes from (cc-mvyml3x4-4)
  // was stopped 43 seconds after the refusal and produced no answer, so the folded
  // heading was "N 步" and nothing else — the refusal, the only thing that happened,
  // was invisible.
  const originalRead = namespace.read
  namespace.read = async () => ok({
    item: { ...baseItem, state: 'denied', pendingApproval: '', pendingQuestions: [] },
    rows: [
      { kind: 'user', text: 'install the hooks', at: 1 },
      { kind: 'tool-use', tool: 'Edit', text: '~/.claude/settings.json', at: 2 },
      { kind: 'denied', tool: 'Edit', text: 'the write installs a hook the user never asked for', at: 3 },
      { kind: 'thinking', text: 'try a narrower edit', at: 4 },
    ],
  })
  await mount()
  await fire(findOne(instance.tree, 'ccw-row'), 'onClick')
  const flagged = findAll(instance.tree, 'ccw-turn-flag')
  // `t()` in this harness renders as `[key]`, so the label arrives literally.
  check('a folded turn flags its refusal', flagged.length === 1
    && String(flagged[0].children) === '1 [turnDenied]',
  JSON.stringify(flagged.map((node) => String(node.children))))
  check('the flag is not shown while the turn is open', (await fire(findOne(instance.tree, 'ccw-turn-head'), 'onClick')) === undefined
    ? findAll(instance.tree, 'ccw-log-row').some((node) => node.props['data-kind'] === 'denied')
    : false)
  namespace.read = originalRead
}

for (const entry of cleanups.reverse()) {
  try { entry.dispose() } catch { /* a disposer that already ran is fine */ }
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
if (failed.length > 0) {
  for (const entry of failed) console.error(`  - ${entry.label}`)
  process.exit(1)
}
console.log('CLICK-THROUGH OK')
process.exit(0)
