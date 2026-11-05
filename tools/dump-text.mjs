// Dump every string the panel would put on screen, in both locales.
//
// The machine cannot screenshot the DSH window (`SetForegroundWindow`,
// `SetWindowPos(HWND_TOPMOST)` and `PrintWindow(PW_RENDERFULLCONTENT)` all return
// False under the foreground lock), so "look at the Chinese UI" has to be done by
// reading the words instead of the pixels. This mounts the real bundle, renders
// it in each state that has distinct text, and prints every text node with its
// origin, so a wrong or untranslated string is visible in a transcript rather
// than only in a screenshot nobody can take.
//
// Run: node tools/dump-text.mjs [en|zh]

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'plugin', 'packages', 'claude-sessions', 'client.js')
const LOCALE = join(here, '..', 'plugin', 'packages', 'claude-sessions', 'locale')

const wanted = (process.argv[2] ?? 'zh').toLowerCase()
if (!['en', 'zh'].includes(wanted)) throw new Error(`unknown locale "${wanted}"; use en or zh`)

/** A dictionary loaded from the generated JSON, which is the file the app ships. */
const dictionary = JSON.parse(readFileSync(join(LOCALE, `${wanted}.json`), 'utf8'))

// ------------------------------------------------------------------ mini React
//
// Only what the panel uses. State persists per mount so a click can move the
// panel into the next state; effects are collected and run once.
let instance = null
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
      const changed = prev === undefined || list === undefined || list.length !== prev.length ||
        list.some((value, index) => !Object.is(value, prev[index]))
      deps[slot] = list
      if (changed) effects.push(fn)
    },
    useMemo(fn, list) {
      const slot = cursor++
      const prev = refs[slot]
      const changed = prev === undefined || list === undefined || list.length !== prev.list.length ||
        list.some((value, index) => !Object.is(value, prev.list[index]))
      if (!changed) return prev.value
      const value = fn()
      refs[slot] = { value, list }
      return value
    },
    useCallback(fn, list) { return this.useMemo(() => fn, list) },
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

// --------------------------------------------------------------- fake services

let items = []
const ok = (value) => ({ ok: true, value })

const baseItem = {
  id: 'demo', title: wanted === 'zh' ? '示例工作项' : 'Demo item', cwd: 'C:\\work\\demo',
  mode: 'manual', state: 'waiting-approval', sessionId: 's-1', model: 'deepseek-v4.1-flash',
  turns: 3, pendingApproval: 'Write · C:\\work\\demo\\report.md', allowRules: '',
  startedAt: 1793260000000, lastActivityAt: 1793260120000, lastResult: 'done',
  costUsd: 0.02, durationMs: 1200, exitCode: 0, revision: 5,
  // The rail's figures, so the dump shows them the way the panel draws them.
  steps: 7, outputTokens: 12000, inputTokens: 400, cacheReadTokens: 30000, cacheWriteTokens: 800,
  contextTokens: 31200, contextLimit: 1000000, turnStartedAt: 0,
}

const rows = [
  // A real transcript starts with these two, BEFORE the first question. They used
  // to become a turn of their own, so the first heading read "open C:\work\demo"
  // instead of what the human actually asked.
  { kind: 'opened', text: 'C:\\work\\demo', at: 1793259990000 },
  { kind: 'init', text: 'deepseek-v4.1-flash · s-1', at: 1793259995000 },
  { kind: 'user', text: wanted === 'zh' ? '帮我把报表写出来' : 'write the report', at: 1793260000000 },
  // The API retry loop, as the Host now records it. Before this row existed a
  // dead endpoint looked exactly like a slow answer.
  {
    kind: 'retry',
    text: 'attempt 1/3 · retry in 0.6s · HTTP 503',
    at: 1793260020000,
  },
  { kind: 'approval-answered', tool: 'Write', text: 'allow (always Write)', at: 1793260060000 },
  // A refusal the classifier issued mid-turn. The turn then succeeded anyway, so
  // the folded heading is the only place this is visible at all — the fixture
  // keeps it here precisely so the dump shows the flag.
  {
    kind: 'denied',
    tool: 'Edit',
    text: wanted === 'zh'
      ? '[Self Modification] 这次写入会装上一个用户没要求的 hook'
      : '[Self Modification] the write installs a hook the user never asked for',
    at: 1793260065000,
  },
  { kind: 'tool-result', text: 'File created successfully', at: 1793260070000 },
  // The answer. A finished turn folds its process rows but must keep this one
  // open — that is the whole product of the turn. The usage fields ride on it so
  // the dump also shows the numbers the Host now reports.
  {
    kind: 'result',
    text: wanted === 'zh' ? '报表已写好，放在 report.md。' : 'Report written to report.md.',
    at: 1793260080000,
    durationMs: 24100,
    inputTokens: 31204,
    outputTokens: 758,
    cacheReadTokens: 30720,
    tps: 31.5,
  },
]

const namespace = {
  async list() { return ok({ items }) },
  async read() { return ok({ item: items[0] ?? baseItem, rows }) },
  async start() { return ok({ item: baseItem }) },
  async send() { return ok({ item: baseItem }) },
  async approve() { return ok({ item: baseItem }) },
  async deny() { return ok({ item: baseItem }) },
  async setMode() { return ok({ item: baseItem }) },
  async interrupt() { return ok({ item: baseItem }) },
  async stop() { return ok({ item: baseItem }) },
  async forget() { return ok({ ok: true }) },
}

const registered = []
const ctx = {
  effect: (factory) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } },
  // The REAL dictionary from locale/<lang>.json — that is the file the app loads.
  locale: {
    register: () => () => {},
    bind: () => (key) => (key in dictionary ? dictionary[key] : `<missing:${key}>`),
  },
  remote: { async $mount() { return async () => {} }, claudeSessions: namespace },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
  uiWorkspace: { async pickDirectory() { return 'C:\\work\\picked' } },
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

// ---------------------------------------------------------------- text walking

/** Collect every string that would be drawn, in document order. */
function textOf(tree) {
  const out = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (typeof node !== 'object') return
    // A <style> element carries CSS, not text the user reads.
    if (node.type === 'style') return
    // Markdown blocks are drawn as a grid and as line-separated code, so the dump
    // has to say where one cell or line ends — otherwise a table reads as one
    // run-on sentence and looks correct.
    if (node.type === 'tr') {
      visit(node.children)
      out.push('--- row ---')
      return
    }
    if (node.type === 'ul' || node.type === 'ol') {
      out.push(node.type === 'ol' ? '--- numbered list ---' : '--- bullet list ---')
      visit(node.children)
      return
    }
    if (node.type === 'pre') {
      visit(node.children)
      out.push('--- end of code ---')
      return
    }
    if (node.type === 'input' || node.type === 'textarea') {
      const placeholder = node.props?.placeholder
      if (typeof placeholder === 'string' && placeholder !== '') out.push(`[placeholder] ${placeholder}`)
      const value = node.props?.value
      if (typeof value === 'string' && value !== '') out.push(`[value] ${value}`)
      return
    }
    if (node.type === 'button') {
      const label = node.props?.disabled === true ? `[disabled] ` : ''
      visit(node.children)
      if (out.length > 0) out[out.length - 1] = `${label}${out[out.length - 1]}`
      return
    }
    visit(node.children)
  }
  visit(tree)
  return out
}

const flush = async () => {
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let page = null
async function render() {
  for (let pass = 0; pass < 8; pass += 1) {
    instance.pending = false
    instance.hooks.beginRender()
    instance.tree = page({ size: 18, active: false })
    for (const effect of instance.hooks.collectEffects()) {
      const outcome = effect()
      if (typeof outcome === 'function') outcome()
    }
    await flush()
    if (!instance.pending) break
  }
  return instance.tree
}

function mount() {
  page = registered.find((entry) => entry.options.name === 'main')?.component
  if (page === undefined) throw new Error('the panel never registered into the `main` slot')
  instance = { hooks: createHooks(), tree: null, pending: false }
  return render()
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.children, visit)
}

function findFirst(tree, needle) {
  let found = null
  walk(tree, (node) => {
    if (found !== null) return
    if (String(node.props?.className ?? '').split(' ').includes(needle)) found = node
  })
  return found
}

// ------------------------------------------------------------------- the dump

await mod.apply(ctx)

const label = registered.find((entry) => entry.options.name === 'sidebar.panellist')
const sidebarText = label === undefined ? '<none>' : label.component({ size: 18, active: false })
const sidebarLabel = label?.options?.label?.() ?? '<none>'

console.log(`=== locale: ${wanted} ===`)
console.log(`package meta title: ${dictionary.meta?.title ?? '<none>'}`)
console.log(`package meta description: ${dictionary.meta?.description ?? '<none>'}`)
console.log(`sidebar label: ${String(sidebarLabel)}  (icon renders: ${sidebarText?.type ?? 'none'})`)
console.log('')

const SCENARIOS = [
  ['empty list, nothing selected', () => { items = [] }, null],
  ['one item waiting for approval, selected', () => { items = [baseItem] }, 'expand'],
  ['item is finished', () => { items = [{ ...baseItem, state: 'done', pendingApproval: '' }] }, 'select'],
  ['item is running', () => { items = [{ ...baseItem, state: 'running', pendingApproval: '' }] }, 'select'],
  // The answer as it is being written: the Host appends it as a `streaming` row
  // between polls, and the panel must treat it as Claude talking (with the caret
  // the CSS adds) rather than as a tool row.
  ['answer still being written', () => {
    // The live turn must be the LAST turn and unfinished, or it folds and the
    // streaming row is hidden behind the heading — which is exactly why this
    // scenario rebuilds the tail instead of appending to the finished one.
    while (rows.length > 0 && rows.at(-1).kind !== 'user') rows.pop()
    items = [{ ...baseItem, state: 'running', pendingApproval: '', title: 'demo', cwd: 'C:\work\demo' }]
    rows.push({ kind: 'streaming', text: wanted === 'zh' ? '报表已经写到一半，正在补上' : 'The report is half written, still fillin', at: 1793260090000 })
  }, 'select'],
  ['back to a finished item', () => {
    // `rows` is shared across scenarios; drop the streaming row and restore the
    // answer so the later scenarios print a complete turn again.
    while (rows.length > 0 && rows.at(-1).kind === 'streaming') rows.pop()
    rows.push({ kind: 'result', text: wanted === 'zh' ? '报表已写好，放在 report.md。' : 'Report written to report.md.', at: 1793260080000, durationMs: 24100, inputTokens: 31204, outputTokens: 758, cacheReadTokens: 30720, tps: 31.5 })
    items = [{ ...baseItem, state: 'done', pendingApproval: '' }]
  }, 'select'],
  // A Markdown answer: the shape a model actually sends when asked to compare
  // things. The dump has to show a table as rows and a list as items, which is how
  // a reader tells a rendered answer from the raw source.
  ['answer with a table and a list', () => {
    while (rows.length > 0 && rows.at(-1).kind !== 'user') rows.pop()
    const markdown = wanted === 'zh'
      ? [
        '三种方案的对比如下：',
        '',
        '| 方案 | 耗时 | 说明 |',
        '|:---|---:|:---:|',
        '| 方案 A | 2s | 最快 |',
        '| 方案 B | 8s | 最稳 |',
        '',
        '建议先试 **方案 A**，因为它',
        '',
        '- 改动小',
        '- 可以回滚',
        '',
        '```powershell',
        'npm test',
        '```',
      ].join('\n')
      : [
        'The three options compare like this:',
        '',
        '| Option | Time | Note |',
        '|:---|---:|:---:|',
        '| A | 2s | fastest |',
        '| B | 8s | safest |',
        '',
        'Start with **Option A**, because it',
        '',
        '- touches little',
        '- can be rolled back',
        '',
        '```powershell',
        'npm test',
        '```',
      ].join('\n')
    rows.push({ kind: 'result', text: markdown, at: 1793260090000, durationMs: 12000, outputTokens: 90, tps: 20 })
    items = [{ ...baseItem, state: 'done', pendingApproval: '' }]
  }, 'select'],
  ['back to a plain answer', () => {
    while (rows.length > 0 && rows.at(-1).kind === 'result') rows.pop()
    rows.push({ kind: 'result', text: wanted === 'zh' ? '报表已写好，放在 report.md。' : 'Report written to report.md.', at: 1793260080000, durationMs: 24100, inputTokens: 31204, outputTokens: 758, cacheReadTokens: 30720, tps: 31.5 })
    items = [{ ...baseItem, state: 'done', pendingApproval: '' }]
  }, 'select'],
  // Item 6 of the review: a question tool must render its choices, because
  // pressing Allow alone is what produced "The user did not answer the questions."
  ['waiting on a question', () => {
    items = [{
      ...baseItem,
      pendingApproval: 'AskUserQuestion',
      pendingQuestions: [
        {
          question: wanted === 'zh' ? '用哪种格式导出？' : 'Which export format?',
          header: wanted === 'zh' ? '格式' : 'Format',
          options: [
            { label: 'PDF', description: wanted === 'zh' ? '便于分享' : 'easy to share' },
            { label: 'CSV' },
          ],
        },
        {
          question: wanted === 'zh' ? '要包含哪些工作表？' : 'Which sheets?',
          header: wanted === 'zh' ? '范围' : 'Scope',
          multiSelect: true,
          options: [{ label: wanted === 'zh' ? '汇总' : 'summary' }, { label: wanted === 'zh' ? '明细' : 'detail' }],
        },
      ],
    }]
  }, 'select'],
]

for (const [title, prepare, action] of SCENARIOS) {
  prepare()
  const tree = await mount()
  if (action === 'select' || action === 'expand') {
    const row = findFirst(tree, 'ccw-row')
    if (row !== null) {
      await row.props.onClick()
      await flush()
      await render()
    }
  }
  // `expand` additionally opens the first folded turn. A finished turn collapses
  // its process rows, so without this the dump never showed what a tool result,
  // a retry or an approval row actually looks like in the panel.
  if (action === 'expand') {
    const head = findFirst(instance.tree, 'ccw-turn-head')
    if (head !== null) {
      await head.props.onClick()
      await flush()
      await render()
    }
  }
  console.log(`--- ${title} ---`)
  for (const line of textOf(instance.tree)) console.log(`  ${line}`)
  console.log('')
}

console.log(`rendered from ${BUNDLE.split('\\').pop()} + locale/${wanted}.json`)
process.exit(0)
