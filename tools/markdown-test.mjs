// Markdown rendering harness.
//
// The transcript used to print Claude's Markdown verbatim, so a table arrived as a
// row of `| --- |` pipes. The renderer in client-body.js is a small parser, and a
// parser is exactly the kind of code that looks right and is wrong at the edges:
// an unclosed fence, a pipe inside a paragraph, an asterisk that never closes.
// This mounts the real bundle and asserts the element tree it produces.
//
// The fixture machinery — state slots, effects with dependency comparison, a
// re-render on setState — is the same miniature React tools/click-through.mjs
// uses, because a parser assertion is worthless if the transcript never mounts.
//
// It also asserts what the parser must NOT touch. Tool output, shell transcripts
// and JSON blobs travel through the same component as prose, and turning a shell
// comment into a heading there would be a regression dressed up as a feature.
//
// Run: node tools/markdown-test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'plugin', 'packages', 'claude-sessions', 'client.js')

// ------------------------------------------------------------------ mini React
//
// Copied in shape from click-through.mjs: state per mount, effects compared by
// deps, `useCallback`/`useMemo` that actually memoise (a harness that does not is
// the classic source of a phantom "effect restarted" failure).
let instance = null
const cleanups = []

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
        instance.pending = true
      }
      return [states[slot], set]
    },
    useRef(initial) {
      const slot = cursor++
      if (!(slot in refs)) refs[slot] = { current: initial }
      return refs[slot]
    },
    useEffect(fn, list) {
      const slot = cursor++
      const prev = deps[slot]
      const changed = prev === undefined || list === undefined || list.length !== prev.length
        || list.some((value, index) => !Object.is(value, prev[index]))
      deps[slot] = list
      if (changed) effects.push({ slot, fn })
    },
    useMemo(fn, list) {
      const slot = cursor++
      const prev = refs[slot]
      const changed = prev === undefined || list === undefined || list.length !== prev.list.length
        || list.some((value, index) => !Object.is(value, prev.list[index]))
      if (!changed) return prev.value
      const value = fn()
      refs[slot] = { value, list }
      return value
    },
    useCallback(fn, list) {
      return this.useMemo(() => fn, list)
    },
    collectEffects() { return effects },
  }
}

const React = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => instance.hooks.useState(initial),
  useRef: (initial) => instance.hooks.useRef(initial),
  useEffect: (fn, list) => instance.hooks.useEffect(fn, list),
  useMemo: (fn, list) => instance.hooks.useMemo(fn, list),
  useCallback: (fn, list) => instance.hooks.useCallback(fn, list),
}

// ---------------------------------------------------------------- the fixture
const item = {
  id: 'a', title: 'Alpha', cwd: 'C:\\p\\alpha', mode: 'auto', state: 'running',
  sessionId: 's', model: 'm', turns: 1, pendingApproval: '', pendingQuestions: [], allowRules: '',
  startedAt: 1, lastActivityAt: 2, lastResult: '', costUsd: 0, durationMs: 0, exitCode: 0, revision: 1,
}

/** The transcript the next mount will read; each scenario replaces it. */
let rows = []
const ok = (value) => ({ ok: true, value })
const namespace = {
  async list() { return ok({ items: [item] }) },
  async read() { return ok({ item, rows }) },
  async start() { return ok({ item }) },
  async send() { return ok({ item }) },
  async approve() { return ok({ item }) },
  async deny() { return ok({ item }) },
  async answer() { return ok({ item }) },
  async rename() { return ok({ item }) },
  async setMode() { return ok({ item }) },
  async interrupt() { return ok({ item }) },
  async stop() { return ok({ item }) },
  async forget() { return ok({ ok: true }) },
}

const registered = []
const ctx = {
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return () => {}
  },
  locale: { register: () => () => {}, bind: () => (key) => `[${key}]` },
  remote: { async $mount() { return async () => {} }, claudeSessions: namespace },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
  uiWorkspace: { async pickDirectory() { return 'C:\\p' } },
  get: (key) => (key === 'remote.claudeSessions' ? namespace : undefined),
  inject: (deps, callback) => { callback(ctx); return { dispose() {} } },
}

let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
new Function('window', readFileSync(BUNDLE, 'utf8'))(globalThis.window)
const mod = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`bad require ${id}`)
})

// ------------------------------------------------------------------- mounting
const flush = async () => {
  for (let tick = 0; tick < 12; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let page = null

async function render() {
  for (let pass = 0; pass < 10; pass += 1) {
    instance.pending = false
    instance.hooks.beginRender()
    instance.tree = page({})
    for (const effect of instance.hooks.collectEffects()) {
      const outcome = effect.fn()
      if (typeof outcome === 'function') cleanups.push(outcome)
    }
    await flush()
    if (!instance.pending) break
  }
  return instance.tree
}

async function mount(transcript) {
  for (const dispose of cleanups.splice(0).reverse()) {
    try { dispose() } catch { /* a disposer that already ran is fine */ }
  }
  rows = transcript
  page = registered.find((entry) => entry.options.name === 'main')?.component
  if (page === undefined) throw new Error('the panel never registered into the `main` slot')
  instance = { hooks: createHooks(), tree: null, pending: false }
  await render()
  // Select the work item the way a reader does: the list row is a button.
  const row = findAll(instance.tree, 'ccw-row')[0]
  if (row === undefined) throw new Error('the rail has no row to click')
  await row.props.onClick()
  await flush()
  return render()
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.children, visit)
}

function findAll(tree, needle) {
  const found = []
  walk(tree, (node) => {
    const className = node.props?.className
    if (typeof className === 'string' && className.split(' ').includes(needle)) found.push(node)
  })
  return found
}

/** All text under a node, flattened — for assertions about what is on screen. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

await mod.apply(ctx)

const failures = []
let checks = 0
function check(label, okValue, detail) {
  checks += 1
  if (!okValue) failures.push(label)
  console.log(`${okValue ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ---------------------------------------------------------------- assertions
const TABLE = [
  '| 名称 | 数值 | 备注 |',
  '|:---|---:|:---:|',
  '| alpha | 1 | 第一个 |',
  '| beta | 22 | 第二个 |',
].join('\n')

{
  const tree = await mount([{ kind: 'user', text: 'show me', at: 1 }, { kind: 'result', text: TABLE, at: 2 }])
  const tables = findAll(tree, 'ccw-md-table')
  check('a table becomes a real table', tables.length === 1, `${String(tables.length)} table(s)`)
  const headers = findAll(tree, 'ccw-md-th')
  check('the header row keeps its cells', headers.length === 3 && textOf(headers[0]) === '名称',
    JSON.stringify(headers.map(textOf)))
  const cells = findAll(tree, 'ccw-md-td')
  check('the body has a cell per column per row', cells.length === 6, `${String(cells.length)} cell(s)`)
  const visible = cells.map(textOf).join(' ')
  check('the pipe characters are gone', visible.includes('alpha') && !visible.includes('|'),
    visible.slice(0, 80))
  const aligns = findAll(tree, 'ccw-md-td').map((node) => node.props.style?.textAlign ?? 'none')
  check('the separator row sets column alignment',
    aligns.includes('right') && aligns.includes('center'), JSON.stringify(aligns))
}

{
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 },
    { kind: 'assistant', text: '# Title\n\nsome **bold** and `code` and *it*', at: 2 }])
  const heading = findAll(tree, 'ccw-md-h')
  check('a heading becomes a heading element', heading.length === 1 && heading[0].type === 'h1',
    JSON.stringify(heading.map((node) => node.type)))
  check('inline bold becomes <strong>', findAll(tree, 'ccw-md-strong').length === 1)
  check('inline code becomes <code>', findAll(tree, 'ccw-md-code').length === 1)
  check('inline emphasis becomes <em>', findAll(tree, 'ccw-md-em').length === 1)
  check('the markup characters do not reach the screen',
    !textOf(tree).includes('**bold**') && textOf(tree).includes('bold'))
}

{
  const CODE = '```powershell\nGet-ChildItem | Where-Object { $_.Name }\n```'
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'result', text: CODE, at: 2 }])
  check('a fence becomes a code block', findAll(tree, 'ccw-md-pre').length === 1)
  check('the fence language is kept', textOf(findAll(tree, 'ccw-md-lang')[0]) === 'powershell',
    textOf(findAll(tree, 'ccw-md-lang')[0]))
  check('the code keeps its pipes verbatim',
    textOf(findAll(tree, 'ccw-md-codelines')[0]).includes('Get-ChildItem | Where-Object'),
    textOf(findAll(tree, 'ccw-md-codelines')[0]))
}

{
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 },
    { kind: 'result', text: '- one\n- two\n  - nested\n\n1. first\n2. second', at: 2 }])
  const lists = findAll(tree, 'ccw-md-list')
  check('bullets become a list', lists.some((node) => node.type === 'ul'),
    JSON.stringify(lists.map((node) => node.type)))
  check('numbers become an ordered list', lists.some((node) => node.type === 'ol'))
  check('nesting is expressed as an indent',
    findAll(tree, 'ccw-md-li').some((node) => node.props.style?.marginLeft !== undefined))
}

{
  // The safe failure: an unterminated fence keeps what arrived instead of eating
  // the rest of the answer.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'result', text: '```\nline one\nline two', at: 2 }])
  check('an unterminated fence keeps the text', textOf(findAll(tree, 'ccw-md-codelines')[0]).includes('line two'),
    textOf(findAll(tree, 'ccw-md-codelines')[0]))
}

{
  // A pipe in prose is not a table: without a separator row it stays a sentence.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'result', text: 'a | b\n\n- and a list', at: 2 }])
  check('pipes without a separator are not a table', findAll(tree, 'ccw-md-table').length === 0)
  check('the paragraph keeps the pipes literally', textOf(findAll(tree, 'ccw-md-p')[0]).includes('a | b'),
    textOf(findAll(tree, 'ccw-md-p')[0]))
  check('a paragraph followed by a list still splits', findAll(tree, 'ccw-md-list').length === 1)
}

{
  // Tool output and CLI errors are NOT prose. A shell comment is not a heading,
  // and a glob in a path is not emphasis.
  const SHELL = '# install the tool\ncd C:\\path\\*\\src\nrm -rf */bin'
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'tool-result', text: SHELL, at: 2 }])
  check('tool output keeps no markdown blocks', findAll(tree, 'ccw-md').length === 0,
    `${String(findAll(tree, 'ccw-md-h').length)} heading(s)`)
  check('tool output keeps its literal text', textOf(tree).includes('# install the tool'))
}

{
  // A streaming row is mid-sentence by definition; parsing it would reflow a table
  // on every poll.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'streaming', text: '| a | b |\n|---|', at: 2 }])
  check('a streaming row is not parsed', findAll(tree, 'ccw-md').length === 0)
}

{
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'result', text: '**a** `b*c*`', at: 2 }])
  check('an asterisk inside a code span stays literal', textOf(findAll(tree, 'ccw-md-code')[0]) === 'b*c*',
    textOf(findAll(tree, 'ccw-md-code')[0]))
  check('a one-line answer with emphasis is still Markdown', findAll(tree, 'ccw-md').length === 1)
}

{
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 }, { kind: 'result', text: 'ok', at: 2 }])
  check('a plain answer stays one text span', findAll(tree, 'ccw-md').length === 0
    && findAll(tree, 'ccw-log-text').some((node) => node.children === 'ok'))
}

{
  // Identifiers must survive as text. `__init__.py` and `my_file_name` are not
  // emphasis, and this is the one place a "helpful" Markdown renderer turns a
  // developer's file name into italics.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 },
    { kind: 'result', text: 'edit __init__.py and my_file_name first', at: 2 }])
  check('underscores in identifiers are not emphasis', findAll(tree, 'ccw-md-em').length === 0
    && textOf(tree).includes('__init__.py') && textOf(tree).includes('my_file_name'))
}

{
  // A path full of underscores and a glob stay literal even inside a Markdown
  // block, because inline parsing only consumes what the INLINE regex matches.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 },
    { kind: 'result', text: '- run `npm test`\n- then open src\\my_file_name.js', at: 2 }])
  check('a path inside a list item keeps its underscores',
    textOf(findAll(tree, 'ccw-md-li')[1] ?? '').includes('my_file_name'),
    textOf(findAll(tree, 'ccw-md-li')[1] ?? ''))
}

{
  // A quote, and a heading level the transcript has not seen before.
  const tree = await mount([{ kind: 'user', text: 'q', at: 1 },
    { kind: 'result', text: '> quoted **text**\n\n### third', at: 2 }])
  check('a quote becomes a blockquote', findAll(tree, 'ccw-md-quote').length === 1)
  check('the quote renders its own blocks', textOf(findAll(tree, 'ccw-md-quote')[0]).includes('quoted'))
  check('a level-3 heading is an h3', findAll(tree, 'ccw-md-h')[0]?.type === 'h3',
    String(findAll(tree, 'ccw-md-h')[0]?.type))
}

// -------------------------------------------------------------------- report
// The panel's polling effect keeps a `setTimeout` alive, so the process would sit
// there after the last assertion. Tear the mount down, then exit explicitly.
for (const dispose of cleanups.splice(0).reverse()) {
  try { dispose() } catch { /* a disposer that already ran is fine */ }
}

console.log('')
if (failures.length === 0) {
  console.log(`${checks}/${checks} checks passed`)
  console.log('MARKDOWN OK')
  process.exit(0)
} else {
  console.log(`${checks - failures.length}/${checks} checks passed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
