// Does the REAL bundle's collapse control actually shrink the answer on screen?
//
// The Node harnesses stub React, so they can prove `data-clamped` flipped and
// nothing about the box getting smaller — and a CSS rule that never wins the
// cascade passes every one of them. That gap is where the answer fold broke (a
// `-webkit-line-clamp` silently doing nothing on a block tree). This renders the
// real bundle into real DOM inside headless Chromium, clicks the real control, and
// measures.
//
// Run: node tools/live-ui-test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'plugin', 'packages', 'claude-sessions')

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
let browser = null
for (const candidate of BROWSERS) {
  try { readFileSync(candidate); browser = candidate; break } catch { /* next */ }
}
if (browser === null) {
  console.log('no Chromium-based browser found; skipping the live UI test')
  process.exit(0)
}

const bundle = readFileSync(join(pkgDir, 'client.js'), 'utf8').replace(/<\/script>/g, '<\\/script>')
const locale = readFileSync(join(pkgDir, 'locale', 'zh.json'), 'utf8')

// The panel's colour-mix tokens resolve against the host's palette, so the real
// stylesheet has to be in the page. Without it every color-mix() is an invalid
// value, transparent wins, and the glass assertions pass for the wrong reason.
const themeSource = readFileSync(join(here, '..', '.research', 'theme-client.js'), 'utf8')
const themeStart = themeSource.indexOf('var design_platform_css_default = "')
const themeEnd = themeSource.indexOf('";', themeStart)
const theme = themeStart < 0
  ? ''
  : JSON.parse(`"${themeSource.slice(themeStart + 'var design_platform_css_default = "'.length, themeEnd)}"`)

const ANSWER_LINES = [
  '先回答你中途提出的两个问题：**不用开新的 cc 窗口**。',
  '',
  '## 当前状况',
  '',
  '| 名称 | 数值 | 备注 |',
  '|---|---:|---|',
  '| alpha | 1 | 第一个 |',
  '| beta | 22 | 第二个 |',
  '',
  '- 第一条列表项',
  '- 第二条列表项',
  '',
  '这是一段很长的正文，用来让答案的高度超过折叠线。'.repeat(12),
  '',
  '```powershell',
  'npm test',
  '```',
]
const ANSWER = ANSWER_LINES.join('\n')

const HARNESS = `
let hooks = null
let dirty = false
let renderFn = null
const disposers = []

function createHooks() {
  const states = [], refs = [], deps = []; let cursor = 0, effects = []
  return {
    beginRender() { cursor = 0; effects = [] },
    useState(initial) {
      const slot = cursor++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(states[slot]) : next
        if (Object.is(value, states[slot])) return
        states[slot] = value
        dirty = true
        queueMicrotask(() => { if (dirty) render() })
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
      if (changed) effects.push(fn)
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
    useCallback(fn, list) { return this.useMemo(() => fn, list) },
    collect() { return effects },
  }
}

const React = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  useState: (i) => hooks.useState(i),
  useRef: (i) => hooks.useRef(i),
  useEffect: (f, l) => hooks.useEffect(f, l),
  useMemo: (f, l) => hooks.useMemo(f, l),
  useCallback: (f, l) => hooks.useCallback(f, l),
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
  if (Array.isArray(node)) {
    const box = document.createDocumentFragment()
    for (const child of node) { const made = renderNode(child); if (made !== null) box.append(made) }
    return box
  }
  const element = document.createElement(node.type)
  const props = node.props ?? {}
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    // A ref must be honoured: the panel keeps the transcript's scroll container in
    // one, and a harness that ignores it makes every scroll assertion describe a
    // null node instead of the pane.
    if (name === 'ref') {
      if (value !== null && typeof value === 'object' && 'current' in value) value.current = element
      continue
    }
    if (name === 'key' || name === 'children' || name === 'autoFocus') continue
    if (name === 'className') { element.className = value; continue }
    if (name === 'style' && typeof value === 'object') { Object.assign(element.style, value); continue }
    // Boolean attributes are PROPERTIES: setAttribute('disabled','false') still
    // disables the element, because in HTML any presence of the attribute counts.
    // The other harnesses never render real DOM, so this is the one place it bites.
    if (name === 'value' || name === 'checked' || name === 'disabled' || name === 'readOnly' || name === 'selected') {
      element[name] = value
      continue
    }
    if (/^on[A-Z]/.test(name)) {
      element.addEventListener(name.slice(2).toLowerCase(), (event) => value(event))
      continue
    }
    element.setAttribute(name, String(value))
  }
  const made = renderNode(node.children)
  if (made !== null) element.append(made)
  return element
}

const root = document.getElementById('root')
function render() {
  dirty = false
  hooks.beginRender()
  const tree = renderFn({})
  const effects = hooks.collect()
  // Carry the transcript's scroll position across the rebuild. A real React
  // reconciles in place; replacing the whole subtree resets scrollTop to 0, and
  // the panel would then "fail" to follow simply because the harness moved the
  // viewport itself.
  const previous = document.querySelector('.ccw-log')
  const keepTop = previous === null ? null : previous.scrollTop
  root.replaceChildren(renderNode(tree) ?? document.createTextNode(''))
  const fresh = document.querySelector('.ccw-log')
  if (fresh !== null && keepTop !== null) fresh.scrollTop = keepTop
  for (const effect of effects) {
    const dispose = effect()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
}

const registered = []
let loaded = null
window.__ModuleLoader__ = { load(spec) { loaded = spec } }

const ITEM = ${JSON.stringify({
  id: 'a', title: 'Alpha', cwd: 'C:\\p\\alpha', mode: 'auto', state: 'running',
  sessionId: 's', model: 'deepseek-v4.1-flash[1m]', turns: 2, pendingApproval: '', pendingQuestions: [],
  allowRules: '', startedAt: 1, lastActivityAt: 2, lastResult: '', costUsd: 0, durationMs: 1200,
  exitCode: 0, revision: 1, steps: 5, outputTokens: 12000, inputTokens: 400, cacheReadTokens: 30000,
  cacheWriteTokens: 800, contextTokens: 31200, contextLimit: 1000000, turnStartedAt: 0,
})}
const ROWS = [
  { kind: 'user', text: '帮我看一下', at: 1, seq: 1 },
  { kind: 'assistant', text: '我先看看。', at: 2, seq: 2 },
  { kind: 'result', text: ${JSON.stringify(ANSWER)}, at: 3, seq: 3, durationMs: 24100, outputTokens: 758, tps: 31.5 },
]
const LOCALE = ${locale}
const SEND_CALLS = []
const ok = (value) => ({ ok: true, value })
const namespace = {
  async list() { return ok({ items: [ITEM] }) },
  // window.__ROWS lets one scenario replace the transcript before boot; the
  // boot itself runs after the prelude, so the value is already there.
  async read() { return ok({ item: ITEM, rows: (typeof window !== 'undefined' && window.__ROWS) || ROWS }) },
  async start() { return ok({ item: ITEM }) },
  async send(id, text, attachments) { SEND_CALLS.push([id, text, attachments]); return ok({ item: ITEM }) },
  async approve() { return ok({ item: ITEM }) },
  async deny() { return ok({ item: ITEM }) },
  async answer() { return ok({ item: ITEM }) },
  async rename() { return ok({ item: ITEM }) },
  async setMode() { return ok({ item: ITEM }) },
  async interrupt() { return ok({ item: ITEM }) },
  async stop() { return ok({ item: ITEM }) },
  async forget() { return ok({ ok: true }) },
}
const ctx = {
  effect: (factory) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } },
  locale: { register: () => () => {}, bind: () => (key) => (key in LOCALE ? LOCALE[key] : '[' + key + ']') },
  remote: { async $mount() { return async () => {} }, claudeSessions: namespace },
  slots: { inject: (n, c) => { c(); return () => {} }, register: (o, c) => registered.push({ options: o, component: c }) },
  uiWorkspace: { async pickDirectory() { return 'C:\\\\p' } },
  get: (key) => (key === 'remote.claudeSessions' ? namespace : undefined),
  inject: (deps, callback) => { callback(ctx); return { dispose() {} } },
}

window.__boot = async () => {
  const mod = loaded.factory((id) => (id === 'react' ? React : null))
  await mod.apply(ctx)
  const page = registered.find((entry) => entry.options.name === 'main')
  if (!page) throw new Error('no main slot registered')
  renderFn = page.component
  hooks = createHooks()
  render()
  await new Promise((r) => setTimeout(r, 40))
  render()
  const row = document.querySelector('.ccw-row')
  if (!row) throw new Error('no rail row rendered')
  row.click()
  await new Promise((r) => setTimeout(r, 60))
  render()
  await new Promise((r) => setTimeout(r, 60))
}
window.__sendCalls = SEND_CALLS
`

const PAGE_HEAD = `<!doctype html><meta charset="utf-8"><title>live</title>
<style>${theme}</style>
<style>
  html, body { margin: 0; height: 100%; }
  #root { height: 100%; display: flex; }
  #root > * { flex: 1 1 auto; min-height: 0; }
  output { display: none; }
</style>
<body><div id="root"></div><output id="out"></output>
<script>${HARNESS}</script>
<script>${bundle}</script>
</body>`

const dir = mkdtempSync(join(tmpdir(), 'ccw-live-'))
const page = join(dir, 'live.html')

/**
 * Boot the panel in headless Chromium, run one probe, and return its result.
 * @param script - page script; it must eventually write JSON into #out.
 * @returns the parsed result.
 */
function run(script, preamble = '') {
  // The prelude ends with an assignment, and the IIFE after it starts with "(" —
  // without the terminator JavaScript reads that as a call of the array.
  const html = PAGE_HEAD.replace('</body>', `<script>
${preamble};
(async () => {
  const out = document.getElementById('out')
  try {
    await window.__boot()
    // Expose what the first scenario measured, so a later one can be compared
    // against it rather than against a hard-coded number.
    window.__live = window.__live || {}
    const value = await (async () => { ${script} })()
    out.textContent = JSON.stringify(value)
  } catch (failure) {
    out.textContent = JSON.stringify({ error: String(failure && failure.stack || failure) })
  }
})()
</script></body>`)
  writeFileSync(page, html, 'utf8')
  // The browser's stdout goes to a FILE through a PowerShell script, not through
  // a captured pipe. Under this sandbox a child's pipe never delivers: the browser
  // exits 0 with zero bytes on stdout, which is indistinguishable from a page that
  // never ran. (Same reason the guard runner uses `stdio: 'inherit'`.) The script
  // is written per run so the paths can be passed without quoting games.
  const out = join(dir, 'dom.html')
  const profile = join(dir, `profile-${String(Date.now())}`)
  const runner = join(dir, 'run.ps1')
  writeFileSync(runner, [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `& '${browser}' --headless=new --disable-gpu --no-sandbox --no-first-run `
      + `--user-data-dir='${profile}' --virtual-time-budget=12000 --dump-dom `
      + `'file:///${page.replace(/\\/g, '/')}' | Out-File -Encoding utf8 '${out}'`,
  ].join('\n'), 'utf8')
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], {
    stdio: 'ignore',
    timeout: 120_000,
  })
  const dom = readFileSync(out, 'utf8')
  const found = /<output id="out">([\s\S]*?)<\/output>/.exec(dom)
  if (found === null) throw new Error(`the page produced no output: ${dom.slice(-400)}`)
  const text = found[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  if (text === '') {
    // The page usually still holds the error in its own console-free way: the
    // catch writes it into #out, so an empty #out means the script never ran —
    // which is a syntax error in the generated page. Print enough of it to see.
    // Keep the generated page: a blank result is almost always a syntax error in
    // the inlined prelude, and reading that text is how it gets fixed.
    const kept = join(tmpdir(), 'ccw-live-failed.html')
    writeFileSync(kept, html, 'utf8')
    throw new Error(`the page wrote no result; the generated page is at ${kept}`)
  }
  const value = JSON.parse(text)
  if (value !== null && typeof value === 'object' && typeof value.error === 'string') {
    throw new Error(value.error)
  }
  return value
}

const failures = []
let checks = 0
function check(label, okValue, detail) {
  checks += 1
  if (!okValue) failures.push(label)
  console.log(`${okValue ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ------------------------------------------------------- 1. the answer folds
const folded = run(`
  const answerRow = () => [...document.querySelectorAll('.ccw-log-row')].find((n) => n.dataset.kind === 'result')
  const textOf = (row) => row.querySelector('.ccw-log-text')
  const before = Math.round(textOf(answerRow()).getBoundingClientRect().height)
  const content = textOf(answerRow()).scrollHeight
  const toggles = [...answerRow().querySelectorAll('.ccw-log-toggle')]
  const beforeLabels = toggles.map((t) => t.textContent)
  if (toggles.length === 0) return { before, content, toggles: 0, after: -1 }
  toggles[0].click()
  await new Promise((r) => setTimeout(r, 80))
  const after = Math.round(textOf(answerRow()).getBoundingClientRect().height)
  return {
    before, content, after, toggles: toggles.length, beforeLabels,
    clamped: answerRow().dataset.clamped,
    afterLabel: [...answerRow().querySelectorAll('.ccw-log-toggle')].map((t) => t.textContent),
  }
`)

check('the answer renders as a tall block', folded.before > 300, `${folded.before}px (content ${folded.content}px)`)
check('the answer has a collapse control', folded.toggles >= 1, JSON.stringify(folded.beforeLabels))
check('clicking it collapses the answer', folded.after > 0 && folded.after < folded.before,
  `${folded.before}px -> ${folded.after}px`)
// TWO lines at 13.5px/1.62 is ~44px. The bound is loose on purpose — the exact
// number belongs to the font — but it has to be unmistakably smaller than a
// handful of lines, which is what "收起后两行" was about.
check('the collapsed box shows two lines', folded.after > 30 && folded.after < 70, `${folded.after}px`)
check('the row is marked clamped', folded.clamped === 'true', String(folded.clamped))
check('the control now offers to expand', JSON.stringify(folded.afterLabel).includes('展开'), JSON.stringify(folded.afterLabel))

// A plain-text answer (no Markdown markers) goes through a DIFFERENT CSS rule, so
// it needs its own measurement rather than inheriting confidence from the above.
const PLAIN_ANSWER = Array.from({ length: 40 }, (_, i) => `第 ${i} 行正文，用来看折叠是否生效。`).join('\n')
const plain = run(`
  // Re-query after the click: this harness rebuilds the DOM on every render, so a
  // node captured before it is detached and measures 0.
  const answer = () => [...document.querySelectorAll('.ccw-log-row')].find((n) => n.dataset.kind === 'result')
  const textOf = () => answer().querySelector('.ccw-log-text')
  const before = Math.round(textOf().getBoundingClientRect().height)
  const md = textOf().classList.contains('ccw-md')
  answer().querySelector('.ccw-log-toggle').click()
  await new Promise((r) => setTimeout(r, 80))
  const after = Math.round(textOf().getBoundingClientRect().height)
  return { before, after, md }
`, `window.__ROWS = [
  { kind: 'user', text: '帮我看一下', at: 1, seq: 1 },
  { kind: 'result', text: ${JSON.stringify(PLAIN_ANSWER)}, at: 2, seq: 2, durationMs: 1200 },
]`)
check('the plain-text answer is not parsed', plain.md === false, String(plain.md))
check('a plain-text answer folds too', plain.after > 0 && plain.after < plain.before,
  `${plain.before}px -> ${plain.after}px`)

// ------------------------------------------------------- 2. images in the composer
const pasted = run(`
  const area = document.querySelector('.ccw-composer textarea')
  if (!area) throw new Error('no composer textarea')
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAAB0UAgH2cW4hAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }))
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  // FileReader is asynchronous; the thumbnail's src only exists once it has run.
  await new Promise((r) => setTimeout(r, 400))
  const thumbs = [...document.querySelectorAll('.ccw-attach')]
  const sendComposer = document.querySelector('.ccw-composer-input .ccw-btn-primary')
  return {
    thumbs: thumbs.length,
    titles: thumbs.map((n) => n.getAttribute('title')),
    images: thumbs.map((n) => (n.querySelector('img') ? n.querySelector('img').src : null)),
    sendDisabled: sendComposer ? sendComposer.disabled : null,
  }
`)

check('pasting an image adds one attachment', pasted.thumbs === 1, `${pasted.thumbs} attachment(s)`)
check('the attachment keeps the file name', JSON.stringify(pasted.titles).includes('tiny.png'), JSON.stringify(pasted.titles))
check('the attachment renders a preview', pasted.images.some((src) => typeof src === 'string' && src.startsWith('data:image/png')), JSON.stringify(pasted.images).slice(0, 80))
check('an image alone is enough to send', pasted.sendDisabled === false, String(pasted.sendDisabled))

// ------------------------------------------------------- 3. what send() receives
const sent = run(`
  const area = document.querySelector('.ccw-composer textarea')
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAAB0UAgH2cW4hAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }))
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 100))
  const sendComposer = document.querySelector('.ccw-composer .ccw-btn-primary')
  sendComposer.click()
  await new Promise((r) => setTimeout(r, 150))
  const [id, text, attachments] = window.__sendCalls.at(-1) ?? []
  return {
    id, text,
    count: Array.isArray(attachments) ? attachments.length : -1,
    first: Array.isArray(attachments) ? attachments[0] : null,
    thumbsAfter: document.querySelectorAll('.ccw-attach').length,
  }
`)

check('send carries the work item id', sent.id === 'a', String(sent.id))
check('send carries one attachment', sent.count === 1, String(sent.count))
check('the attachment is a base64 png', sent.first !== null && sent.first.mediaType === 'image/png'
  && typeof sent.first.data === 'string' && sent.first.data.length > 20,
  JSON.stringify(sent.first && { mediaType: sent.first.mediaType, length: sent.first.data && sent.first.data.length }))
check('the composer clears its attachments after sending', sent.thumbsAfter === 0, `${sent.thumbsAfter} left`)

// ---------------------------------------- 3a. the command menu opens upward
//
// The menu is absolutely positioned inside the composer, which sits at the
// bottom of the pane. Two things only a real layout can prove:
//   1. it is painted ABOVE the transcript (the composer's stacking context), and
//   2. it opens UP, so its bottom edge is above the button that opened it —
//      a menu that opened downward would fall off the pane.
// The DOM stub cannot see either, and a wrong direction is invisible in code.
const menu = run(`
  const button = document.querySelector('.ccw-cmd .ccw-btn')
  if (!button) throw new Error('no command button')
  button.click()
  await new Promise((r) => setTimeout(r, 80))
  // Re-query after the click: the harness rebuilds the DOM on every render, so
  // the node captured before it is detached and measures 0 — which is exactly
  // how a correct upward menu read as "below the button" the first time.
  const menu = document.querySelector('.ccw-cmd-menu')
  if (!menu) throw new Error('the menu never opened')
  const anchor = document.querySelector('.ccw-cmd .ccw-btn').getBoundingClientRect()
  const box = menu.getBoundingClientRect()
  const entry = menu.querySelector('.ccw-cmd-item')
  const style = getComputedStyle(menu)
  return {
    visible: box.height > 100 && box.width > 100,
    above: box.bottom <= anchor.top + 1,
    onScreen: box.top >= 0,
    anchorTop: Math.round(anchor.top),
    boxBottom: Math.round(box.bottom),
    zIndex: style.zIndex,
    entries: menu.querySelectorAll('.ccw-cmd-item').length,
    dangerColor: getComputedStyle(menu.querySelector('.ccw-cmd-item[data-danger="true"] .ccw-cmd-name')).color,
    normalColor: getComputedStyle(menu.querySelector('.ccw-cmd-item:not([data-danger="true"]) .ccw-cmd-name')).color,
    entryColour: getComputedStyle(entry).color,
    // The pinned question and the open menu are the two translucent layers that
    // can land on each other: the menu only reaches the log's top when the pane
    // is short or the menu is tall. Scroll it and hit-test the top of the menu,
    // which is where the glass heading sits.
    ...(() => {
      const log = document.querySelector('.ccw-log')
      log.scrollTop = log.scrollHeight
      const head = document.querySelector('.ccw-turn-head')
      const box2 = document.querySelector('.ccw-cmd-menu').getBoundingClientRect()
      const headBox = head ? head.getBoundingClientRect() : null
      // The point to hit-test is the middle of where the two actually overlap —
      // not a guess inside the menu. An earlier version used the first entry's
      // centre, which sat BELOW the heading, so it passed with the bug in place.
      const left = Math.max(box2.left, headBox === null ? box2.left : headBox.left)
      const right = Math.min(box2.right, headBox === null ? box2.right : headBox.right)
      const top = Math.max(box2.top, headBox === null ? box2.top : headBox.top)
      const bottom = Math.min(box2.bottom, headBox === null ? box2.bottom : headBox.bottom)
      const hit = right > left && bottom > top
        ? document.elementFromPoint(Math.round((left + right) / 2), Math.round((top + bottom) / 2))
        : null
      const overHead = headBox === null ? false
        : !(box2.right < headBox.left || box2.left > headBox.right || box2.bottom < headBox.top || box2.top > headBox.bottom)
      return {
        headZ: head ? getComputedStyle(head).zIndex : null,
        composerZ: getComputedStyle(document.querySelector('.ccw-composer')).zIndex,
        hitInMenu: hit !== null && document.querySelector('.ccw-cmd-menu').contains(hit),
        overlap: overHead,
        headBottom: headBox === null ? null : Math.round(headBox.bottom),
        menuTop: Math.round(box2.top),
      }
    })(),
  }
`)

check('the command menu opens', menu.visible, `${menu.entries} entries`)
// The bug this replaces: the composed pane put the composer at z-index 2 and the
// sticky question at 3, so the frosted heading painted OVER the menu — the menu
// was there, visible only where the heading did not reach. A non-zero z-index is
// not the assertion; being above the heading is.
check('the composer stacks above the pinned question',
  Number(menu.composerZ) > Number(menu.headZ),
  JSON.stringify({ composer: menu.composerZ, questionHead: menu.headZ }))
check('a click on the menu reaches the menu, not the glass',
  menu.hitInMenu === true,
  JSON.stringify({ overlap: menu.overlap, headBottom: menu.headBottom, menuTop: menu.menuTop }))
check('it opens upward, away from the pane edge', menu.above === true, JSON.stringify({ anchorTop: menu.anchorTop, boxBottom: menu.boxBottom }))
check('it stays inside the pane', menu.onScreen === true)
check('it stacks above the transcript', Number(menu.zIndex) > 0, String(menu.zIndex))
check('/clear is painted in the error colour',
  menu.dangerColor !== menu.normalColor && /^rgb\(/.test(menu.dangerColor),
  JSON.stringify({ danger: menu.dangerColor, normal: menu.normalColor }))

// --------------------------------------- 3b. a growing answer follows the view
//
// The reported bug: while a reply arrived the panel did not scroll, and the
// sentence being written walked off the bottom. The old growth test was
// `rows.length` — a streaming answer grows INSIDE one row, so the count never
// changed and the effect returned early.
const follow = run(`
  const log = document.querySelector('.ccw-log')
  // Start pinned to the bottom, the way a reader who just sent a message is.
  log.scrollTop = log.scrollHeight
  await new Promise((r) => setTimeout(r, 260))
  const startTop = Math.round(log.scrollTop)
  const startHeight = Math.round(log.scrollHeight)
  // Same rows, ONE ROW LONGER — exactly what a poll returns while an answer
  // streams. The row count does not change.
  const rows = (window.__ROWS || [])
  // Built with String.fromCharCode(10): a literal newline inside this template
  // would end the page's script, and a backslash-n would be eaten by the outer
  // template before the page ever sees it.
  const NL = String.fromCharCode(10)
  window.__ROWS = rows.map((row, index) => (index === rows.length - 1
    ? { ...row, text: row.text + NL + Array.from({ length: 30 }, (_, i) => '还在继续写的第 ' + i + ' 行').join(NL) }
    : row))
  await new Promise((r) => setTimeout(r, 2600))
  // Re-query: this harness rebuilds the DOM on every render, so the node captured
  // before the poll is detached and reports zero height.
  const after = document.querySelector('.ccw-log')
  return {
    startTop,
    startHeight,
    endHeight: Math.round(after.scrollHeight),
    endTop: Math.round(after.scrollTop),
    atBottom: Math.round(after.scrollHeight - after.scrollTop - after.clientHeight) <= 4,
    rows: (window.__ROWS || []).length,
  }
`, `window.__ROWS = Array.from({ length: 30 }, (_, i) => ({
  kind: i === 0 ? 'user' : 'assistant',
  text: '历史第 ' + i + ' 行，用来把对话撑得比面板高。',
  at: i + 1, seq: i + 1,
}))`)
check('the transcript is taller than the panel', follow.startHeight > 400, `${follow.startHeight}px`)
check('the answer got longer without adding a row', follow.rows === 30, `${follow.rows} rows`)
check('the pane grew', follow.endHeight > follow.startHeight, `${follow.startHeight}px -> ${follow.endHeight}px`)
check('a growing answer keeps the view at the bottom', follow.atBottom,
  `scrollTop ${follow.startTop} -> ${follow.endTop}, height ${follow.endHeight}`)

// ------------------------------------- 4. the question sticks while you scroll
//
// A long answer must not carry the question off screen: the turn head is sticky,
// so after scrolling to the bottom the heading is still at the top of the log.
const sticky = run(`
  const log = document.querySelector('.ccw-log')
  const heads = [...document.querySelectorAll('.ccw-turn-head')]
  const last = heads[heads.length - 1]
  const logBox = log.getBoundingClientRect()
  const before = Math.round(last.getBoundingClientRect().top - logBox.top)
  log.scrollTop = log.scrollHeight
  await new Promise((r) => setTimeout(r, 120))
  const head = [...document.querySelectorAll('.ccw-turn-head')].at(-1)
  const after = Math.round(head.getBoundingClientRect().top - log.getBoundingClientRect().top)
  const style = getComputedStyle(head)
  return {
    scrolled: Math.round(log.scrollTop),
    before,
    after,
    stickyStyle: style.position,
    background: style.backgroundColor,
    backdrop: style.backdropFilter,
    webkitBackdrop: style.webkitBackdropFilter,
    borderBottomWidth: style.borderBottomWidth,
  }
`)
check('the transcript actually scrolls', sticky.scrolled > 100, `${sticky.scrolled}px`)
check('the question head is sticky', sticky.stickyStyle === 'sticky', sticky.stickyStyle)
// The log has a 10px top padding, and a sticky element stops at the padding edge:
// the number to assert is "it did not move", not "it is at zero".
check('the question stays at the top after scrolling',
  sticky.after <= sticky.before + 2 && sticky.after < 20,
  `offset ${sticky.before}px -> ${sticky.after}px`)

// The pane has to READ as a layer, not as the first row: translucent background,
// a real backdrop blur, and an edge. An opaque background was the earlier bug —
// on the dark theme it was a black bar with no boundary.
check('the pinned head is translucent', sticky.background.includes('rgba') || sticky.background.includes('/'),
  sticky.background)
check('the pinned head blurs what scrolls under it',
  /blur\(/.test(sticky.backdrop) || /blur\(/.test(sticky.webkitBackdrop),
  `${sticky.backdrop} | ${sticky.webkitBackdrop}`)
check('the pinned head has a bottom edge', sticky.borderBottomWidth !== '0px', sticky.borderBottomWidth)

// The complaint was specifically about the dark theme, so the dark glass gets its
// own measurement: it must be a WHITE tint there, and still blurred and edged.
const dark = run(`
  document.body.setAttribute('data-ds-dark-theme', '')
  document.body.style.background = '#0f1115'
  await new Promise((r) => setTimeout(r, 60))
  const log = document.querySelector('.ccw-log')
  log.scrollTop = log.scrollHeight
  await new Promise((r) => setTimeout(r, 80))
  const head = [...document.querySelectorAll('.ccw-turn-head')].at(-1)
  const style = getComputedStyle(head)
  return {
    background: style.backgroundColor,
    backdrop: style.backdropFilter,
    borderBottomWidth: style.borderBottomWidth,
  }
`)
check('the dark theme tints the pane with white, not black', /^color\(srgb 1 1 1 \//.test(dark.background)
  || /rgba\(255, 255, 255/.test(dark.background), dark.background)
check('the dark theme keeps the blur', /blur\(/.test(dark.backdrop), dark.backdrop)
check('the dark theme keeps the edge', dark.borderBottomWidth !== '0px', dark.borderBottomWidth)

// ------------------------------------------------- 5. the handover banner wording
//
// A resumed session must not be described as a fresh process replaying a summary,
// and the banner must go away once the new session has answered.
const banner = run(`
  const read = () => document.querySelector('.ccw-reopen')?.textContent ?? null
  const before = read()
  return { text: before }
`, `window.__ROWS = [
  { kind: 'user', text: '之前的问题', at: 1, seq: 1 },
  { kind: 'result', text: '之前的回答', at: 2, seq: 2 },
  { kind: 'reopened', text: 'resumed session abcdef12', resumed: true, at: 3, seq: 3 },
  { kind: 'user', text: '继续', at: 4, seq: 4 },
]`)
check('a resumed session says so in its own words', /续接|resumed/i.test(String(banner.text)), String(banner.text).slice(0, 60))
check('the banner does not claim a new session', !/新会话|NEW process|新的会话/i.test(String(banner.text)), String(banner.text).slice(0, 60))

const afterAnswer = run(`
  const read = () => document.querySelector('.ccw-reopen')?.textContent ?? null
  return { text: read() }
`, `window.__ROWS = [
  { kind: 'user', text: '之前的问题', at: 1, seq: 1 },
  { kind: 'reopened', text: 'resumed session abcdef12', resumed: true, at: 2, seq: 2 },
  { kind: 'user', text: '继续', at: 3, seq: 3 },
  { kind: 'result', text: '好的', at: 4, seq: 4, durationMs: 900 },
]`)
check('the banner hides once the new session has answered', afterAnswer.text === null, String(afterAnswer.text))

// A primer-based reopen keeps its own sentence: that one really is a new process.
const primed = run(`
  return { text: document.querySelector('.ccw-reopen')?.textContent ?? null }
`, `window.__ROWS = [
  { kind: 'user', text: '之前的问题', at: 1, seq: 1 },
  { kind: 'reopened', text: '3 prior line(s) as context', resumed: false, at: 2, seq: 2 },
  { kind: 'user', text: '继续', at: 3, seq: 3 },
]`)
check('a primed reopen warns that the process is new',
  /新进程|NEW process|历史记录/i.test(String(primed.text)), String(primed.text).slice(0, 60))

// ------------------------------------------- 6. no control that folds nothing
const noFold = run(`
  const answer = [...document.querySelectorAll('.ccw-log-row')].find((n) => n.dataset.kind === 'result')
  return { toggles: answer.querySelectorAll('.ccw-log-toggle').length, length: (answer.querySelector('.ccw-log-text')?.textContent ?? '').length }
`, `window.__ROWS = [
  { kind: 'user', text: '问题', at: 1, seq: 1 },
  { kind: 'result', text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", at: 2, seq: 2 },
]`)
check('a short answer carries no fold control', noFold.toggles === 0, `${noFold.toggles} control(s) on ${noFold.length} chars`)

// -------------------------------------------------------------------- report
console.log('')
if (failures.length === 0) {
  console.log(`${checks}/${checks} checks passed`)
  console.log('LIVE UI OK')
  process.exit(0)
} else {
  console.log(`${checks - failures.length}/${checks} checks passed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
// -------------------------------------------------------------------- report
console.log('')
if (failures.length === 0) {
  console.log(`${checks}/${checks} checks passed`)
  console.log('LIVE UI OK')
  process.exit(0)
} else {
  console.log(`${checks - failures.length}/${checks} checks passed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
