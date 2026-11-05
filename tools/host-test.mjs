// Host-half harness.
//
// The Host half is a plain ES module with exactly one export (`apply(ctx)`), so
// it can be exercised without Electron, without a browser, and without a live
// `claude` process: this file supplies a fake `ctx` whose `subprocess.spawn`
// returns an in-memory pipe the test drives by hand. That covers the parts the
// click-through harness cannot reach — the five-state machine, approval
// bookkeeping, persistence, and reload — while `node tools/click-through.mjs`
// covers the browser side.
//
// Run: node tools/host-test.mjs

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
let checks = 0

function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`PASS  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
    return
  }
  console.log(`FAIL  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  failures.push(label)
}

function equal(label, actual, expected) {
  const ok = Object.is(actual, expected)
  check(label, ok, ok ? String(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ------------------------------------------------------------------ fake ctx

/** One in-memory child process: stdin is recorded, stdout is driven by the test. */
function createFakeChild() {
  const listeners = new Map()
  const writes = []
  const stream = (name) => ({
    on: (event, handler) => {
      const key = `${name}:${event}`
      if (!listeners.has(key)) listeners.set(key, [])
      listeners.get(key).push(handler)
    },
    setEncoding: () => {},
  })
  // `done` is the documented completion signal the Host awaits, so the fake has
  // to expose a real promise rather than an exit event.
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const child = {
    writes,
    stdin: { write: (chunk) => { writes.push(chunk) } },
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    done,
    terminated: false,
    /** Push one protocol record down stdout, as `claude` would. */
    emit(record) {
      const chunk = `${JSON.stringify(record)}\n`
      for (const handler of listeners.get('stdout:data') ?? []) handler(chunk)
    },
    /** Emit raw bytes on stderr. */
    emitError(text) {
      for (const handler of listeners.get('stderr:data') ?? []) handler(text)
    },
    /** Complete the process the way the real handle does. */
    async exit(code) {
      if (!child.terminated) settle({ exitCode: code })
      await done
    },
    async terminate() {
      child.terminated = true
      settle({ exitCode: null })
    },
  }
  return child
}

function createCtx() {
  const children = []
  const registered = []
  const disposers = []
  const services = new Map()
  const ctx = {
    children,
    registered,
    spawnOptions: null,
    subprocess: {
      resolveExecutable: async (name) => name,
      spawn: (options) => {
        const child = createFakeChild()
        child.spawnOptions = options
        ctx.spawnOptions = options
        children.push(child)
        return child
      },
    },
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
    provide: (key, value) => services.set(key, value),
    services,
    effect: (factory) => {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    async dispose() {
      for (const disposer of disposers.splice(0).reverse()) await disposer()
    },
  }
  return ctx
}

// ------------------------------------------------------------------- the run

const home = mkdtempSync(join(tmpdir(), 'claude-sessions-host-'))
// `storageRoot()` reads DSH_HOME through os.homedir(); point it at the scratch
// tree by overriding the env var the Host actually consults.
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const modulePath = new URL('../plugin/packages/claude-sessions/index.js', import.meta.url)
const { apply, inject } = await import(modulePath.href)

check('the module exports apply()', typeof apply === 'function')
check('the module declares its inject list', Array.isArray(inject) && inject.includes('subprocess'),
  JSON.stringify(inject))

const ctx = createCtx()
apply(ctx)

const service = ctx.services.get('claudeSessions')
check('the Host provides the claudeSessions service', service !== undefined)
check('the Host registers the claude_session tool', ctx.registered.length === 1,
  ctx.registered.map((tool) => tool.name).join(', '))
check('the service carries its typert binding', service?.typertRemote?.namespace === 'claudeSessions',
  JSON.stringify(service?.typertRemote?.namespace))

const root = join(home, 'storages', 'claude-sessions')
check('the storage root is created', existsSync(root), root)

// --- start ----------------------------------------------------------------

const started = await service.start({ id: 'w1', title: 'probe', cwd: home, mode: 'manual' })
equal('start reports the initial state', started.item.state, 'idle')
equal('start keeps the requested title', started.item.title, 'probe')
equal('start keeps the requested mode', started.item.mode, 'manual')
check('start spawns exactly one child', ctx.children.length === 1)

const argv = ctx.spawnOptions.argv
check('the child runs claude in SDK mode', argv.includes('-p') && argv.includes('--input-format')
  && argv.includes('stream-json'), argv.join(' '))
check('the child is told which permission mode to use', argv[argv.indexOf('--permission-mode') + 1] === 'manual')
check('the child routes approvals to stdio', argv.includes('--permission-prompt-tool')
  && argv[argv.indexOf('--permission-prompt-tool') + 1] === 'stdio')
// Without this the CLI only emits the finished answer, so the panel has nothing
// to show while a long answer is being written.
check('the child streams partial messages', argv.includes('--include-partial-messages'), argv.join(' '))

const child = ctx.children[0]

// --- the live turn timer ---------------------------------------------------
//
// The rail shows a running clock for the turn in flight, so `send()` has to stamp
// a start and the `result` has to clear it. A timer that is never cleared reads as
// a turn that never ended, which is indistinguishable from a hung one.
await service.send('w1', 'time me')
check('a send stamps the turn start', service.list().items[0].turnStartedAt > 0,
  String(service.list().items[0].turnStartedAt))
child.emit({ type: 'result', result: 'timed', duration_ms: 1000 })
equal('a result clears the turn start', service.list().items[0].turnStartedAt, 0)

// --- transcript folding ---------------------------------------------------

child.emit({ type: 'system', subtype: 'init', session_id: 's-1', model: 'test-model' })
equal('init is folded into the state', service.list().items[0].model, 'test-model')
equal('init is folded into the session id', service.list().items[0].sessionId, 's-1')
// The id has to reach the header, because it is the only field a restart cannot
// recover from the event log alone and the only thing `--resume` needs.
const initHeader = JSON.parse(readFileSync(join(root, 'w1.meta.json'), 'utf8'))
equal('init persists the session id to the header', initHeader.sessionId, 's-1')

child.emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello' }] },
})
const afterAssistant = service.read('w1', 20)
check('an assistant message reaches the transcript', afterAssistant.rows.some((row) => row.kind === 'assistant'))

// --- streaming -------------------------------------------------------------
//
// With `--include-partial-messages` the CLI sends the answer as token deltas, a
// block stop, and then the finished `assistant` record. The deltas must be
// visible while they arrive, and must NOT each become a log row: a 30-line answer
// is 17 deltas, and one row per delta would turn one answer into seventeen.
const rowsBeforeDeltas = service.read('w1', 500).rows.length
child.emit({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
})
child.emit({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo wor' } },
})
const live = service.read('w1', 500).rows
const liveRow = live.filter((row) => row.kind === 'streaming').at(-1)
equal('a partial answer is visible before it is finished', liveRow?.text, 'Hello wor')
equal('the partial answer does not add a log row', live.length, rowsBeforeDeltas + 1)
check('the partial answer is not written to the log',
  !readFileSync(join(root, 'w1.jsonl'), 'utf8').includes('streaming'))

child.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
check('the block stop drops the partial answer',
  !service.read('w1', 500).rows.some((row) => row.kind === 'streaming'))
child.emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello world' }] },
})
const finished = service.read('w1', 500).rows
check('the finished record replaces the partial answer',
  finished.filter((row) => row.kind === 'assistant').at(-1)?.text === 'Hello world'
  && !finished.some((row) => row.kind === 'streaming'))
equal('one answer is still one row', finished.filter((row) => row.kind === 'assistant' && row.text === 'Hello world').length, 1)

// --- the API retry loop ----------------------------------------------------
//
// The CLI announces its retries on the SDK stream as `system/api_retry`; the Host
// used to drop them, so a session whose endpoint had gone away sat at "running"
// with a blank transcript for as long as the backoff lasted. Measured shape from
// tools/probe-retry.mjs against a dead endpoint:
//   {subtype:"api_retry", attempt:1, max_retries:2, retry_delay_ms:603,
//    error_status:null, error:"unknown"}
child.emit({
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 2,
  retry_delay_ms: 603,
  error_status: null,
  error: 'unknown',
})
const retryRows = service.read('w1', 50).rows.filter((row) => row.kind === 'retry')
equal('a retry reaches the transcript', retryRows.length, 1)
check('the retry names the attempt and the wait',
  retryRows[0].text.includes('attempt 1/2') && retryRows[0].text.includes('retry in 0.6s'), retryRows[0].text)
check('the retry carries the failure kind', retryRows[0].text.includes('unknown'), retryRows[0].text)
equal('a retry keeps the item running', service.list().items[0].state, 'running')

child.emit({
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 2,
  retry_delay_ms: 1027,
  error_status: 503,
  error: 'server_error',
})
const retry2 = service.read('w1', 50).rows.filter((row) => row.kind === 'retry').at(-1)
check('an HTTP status replaces the error kind', retry2.text.includes('HTTP 503'), retry2.text)

// A hanging endpoint is the case a reader most needs to tell apart from "slow":
// the CLI adds `no_response` when the API sent no headers within the first-byte
// window, and that detail is the whole diagnosis.
child.emit({
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 1,
  retry_delay_ms: 2000,
  error_status: null,
  error: 'unknown',
  no_response: { waited_ms: 25000, retry_wait_ms: 2000 },
})
const retry3 = service.read('w1', 50).rows.filter((row) => row.kind === 'retry').at(-1)
check('a hang is reported as a hang, not as an unknown error',
  retry3.text.includes('no response in 25.0s') && !retry3.text.includes('unknown'), retry3.text)

// The CLI also synthesises an `assistant` record to carry the terminal API error.
// Recording it as a real reply put "API Error: Connection refused" in the
// transcript as if Claude had said it.
child.emit({
  type: 'assistant',
  is_api_error_message: true,
  error: 'unknown',
  message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection refused' }] },
})
const errorRows = service.read('w1', 50).rows
check('a synthetic API error is its own kind', errorRows.some((row) => row.kind === 'api-error'),
  JSON.stringify(errorRows.filter((row) => row.kind === 'api-error').map((row) => row.text)))
check('a synthetic API error is not recorded as a reply',
  !errorRows.some((row) => row.kind === 'assistant' && row.text.includes('Connection refused')))

// And the result that closes such a turn says why. `is_error` alone was read as
// "denied", which told the reader a permission had been refused.
child.emit({
  type: 'result',
  result: 'API Error: Connection refused',
  is_error: true,
  terminal_reason: 'api_error',
  duration_ms: 0,
})
equal('an api_error result is not reported as denied', service.list().items[0].state, 'error')

// An actionable notice is kept; pure transcript colour is not.
child.emit({ type: 'system', subtype: 'informational', level: 'info', content: 'just chatter' })
child.emit({ type: 'system', subtype: 'informational', level: 'warning', content: 'Git Bash is missing' })
const noticeRows = service.read('w1', 50).rows.filter((row) => row.kind === 'notice')
equal('only an actionable notice is kept', noticeRows.length, 1)
equal('the notice keeps its text', noticeRows[0].text, 'Git Bash is missing')

// --- a refused tool, as the CLI actually reports it ------------------------
//
// Measured on a real session (cc-mvyml3x4-4, 11:04:02): the CLI emits the same
// 1 509-character refusal TWICE — once as `system/permission_denied` and once as
// the `tool_result` the model reads — and the tail of it is an instruction to
// Claude ("If you have other tasks that don't depend on this action… IMPORTANT:
// You *may* attempt to accomplish this action using other tools…"), not something
// a person reading a transcript needs.
const DENIAL = 'Permission for this action was denied by the Claude Code auto mode classifier. '
  + 'Reason: [Self Modification] the write installs a hook the user never asked for. '
  + "If you have other tasks that don't depend on this action, continue working on those. "
  + 'IMPORTANT: You *may* attempt to accomplish this action using other tools that might '
  + 'naturally be used to accomplish this goal.'
child.emit({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Edit',
  tool_use_id: 'tu-1',
  decision_reason_type: 'classifier',
  message: DENIAL,
})
const afterDenial = service.read('w1', 50).rows
const deniedRow = afterDenial.filter((row) => row.kind === 'denied').pop()
equal('a refused tool is recorded', deniedRow !== undefined, true)
equal('the refusal keeps only the reason', deniedRow.text,
  '[Self Modification] the write installs a hook the user never asked for')
equal('the refusal names the tool', deniedRow.tool, 'Edit')
equal('a refused tool is not a finished turn', service.list().items[0].state, 'denied')

// The echo of the same refusal on the tool-result channel must not become a
// second row: one refusal, one line.
child.emit({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: DENIAL }] },
})
const afterEcho = service.read('w1', 50).rows
equal('the echoed refusal is not recorded twice',
  afterEcho.filter((row) => row.kind === 'denied' || row.text === DENIAL).length,
  afterDenial.filter((row) => row.kind === 'denied' || row.text === DENIAL).length)

// A tool error that is NOT a refusal still arrives as its own row, and keeps all
// of its text: only the CLI's own refusal preamble is stripped.
child.emit({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', is_error: true, content: 'Exit code 1' }] },
})
equal('an ordinary tool error still gets a row',
  service.read('w1', 50).rows.filter((row) => row.kind === 'tool-error').length, 1)

// Put the item back to a usable state for the scenarios below.
child.emit({ type: 'result', result: 'done', total_cost_usd: 0.02, duration_ms: 1234, is_error: false })
const afterResult = service.list().items[0]
equal('a successful result returns the item to idle', afterResult.state, 'idle')
equal('the cost is recorded', afterResult.costUsd, 0.02)
equal('the duration is recorded', afterResult.durationMs, 1234)
equal('the last result is remembered', afterResult.lastResult, 'done')

// --- the per-turn usage figures --------------------------------------------
//
// `usage` in a result record is cumulative for the whole process, so the panel
// must be given the DELTA or every turn after the first reports the running total
// and the last answer looks enormous. The first result above carried no usage, so
// it set no baseline; these two establish one and then measure against it.
child.emit({
  type: 'result',
  result: 'first',
  duration_ms: 20000,
  ttft_ms: 1000,
  usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 800 },
})
const usageRow1 = service.read('w1', 50).rows.filter((row) => row.kind === 'result').at(-1)
equal('turn 1 output tokens is the reading itself', usageRow1.outputTokens, 400)
equal('turn 1 input tokens is the reading itself', usageRow1.inputTokens, 1000)
equal('turn 1 cache reads are carried', usageRow1.cacheReadTokens, 800)
equal('turn 1 duration is carried on the row', usageRow1.durationMs, 20000)
// 400 tokens over (20000 - 1000) ms of generating = 21.05 → 21.1.
equal('turn 1 tps excludes the wait for the first token', usageRow1.tps, 21.1)

child.emit({
  type: 'result',
  result: 'second',
  duration_ms: 10000,
  ttft_ms: 0,
  usage: { input_tokens: 1600, output_tokens: 700, cache_read_input_tokens: 1500 },
})
const usageRow2 = service.read('w1', 50).rows.filter((row) => row.kind === 'result').at(-1)
equal('turn 2 output tokens is the delta, not the total', usageRow2.outputTokens, 300)
equal('turn 2 input tokens is the delta', usageRow2.inputTokens, 600)
equal('turn 2 cache reads are the delta', usageRow2.cacheReadTokens, 700)
equal('turn 2 tps uses the delta', usageRow2.tps, 30)

// --- the approval state machine -------------------------------------------

child.emit({
  type: 'control_request',
  request_id: 'req-1',
  request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: join(home, 'x.txt') } },
})
const waiting = service.list().items[0]
equal('a can_use_tool request parks the item', waiting.state, 'waiting-approval')
check('the pending approval names the tool', waiting.pendingApproval.startsWith('Write'), waiting.pendingApproval)

const sentBefore = child.writes.length
service.approve('w1', false)
const approvalLine = JSON.parse(child.writes[child.writes.length - 1])
equal('approve writes exactly one control_response', child.writes.length, sentBefore + 1)
equal('the response echoes the request id', approvalLine.response.request_id, 'req-1')
equal('the response allows the tool', approvalLine.response.response.behavior, 'allow')
equal('approve clears the pending approval', service.list().items[0].pendingApproval, '')
equal('approve moves the item back to running', service.list().items[0].state, 'running')

const answered = service.read('w1', 50).rows.filter((row) => row.kind === 'approval-answered')
check('approve is written to the event log', answered.length === 1, JSON.stringify(answered.map((row) => row.text)))

// --- remembering a tool ----------------------------------------------------

child.emit({
  type: 'control_request',
  request_id: 'req-2',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } },
})
service.approve('w1', true)
equal('remembering adds an allow rule', service.list().items[0].allowRules, 'Bash')
const policy = service.read('w1', 80).rows.filter((row) => row.kind === 'policy')
check('remembering is written to the event log', policy.length === 1, JSON.stringify(policy.map((row) => row.text)))
const rememberText = service.read('w1', 80).rows.filter((row) => row.kind === 'approval-answered').pop()
equal('the log distinguishes "always allow"', rememberText.text, 'allow (always Bash)')

// A remembered tool must be answered without parking the item again.
child.emit({
  type: 'control_request',
  request_id: 'req-3',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo again' } },
})
equal('a remembered tool never parks the item', service.list().items[0].state, 'running')
const autoAllow = JSON.parse(child.writes[child.writes.length - 1])
equal('a remembered tool is auto-allowed', autoAllow.response.request_id, 'req-3')
equal('the auto-allow still answers allow', autoAllow.response.response.behavior, 'allow')

// --- deny ------------------------------------------------------------------

child.emit({
  type: 'control_request',
  request_id: 'req-4',
  request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: join(home, 'y.txt') } },
})
service.deny('w1', 'not now')
const denyLine = JSON.parse(child.writes[child.writes.length - 1])
equal('deny answers with behavior deny', denyLine.response.response.behavior, 'deny')
equal('deny carries the message through', denyLine.response.response.message, 'not now')
equal('deny moves the item to denied', service.list().items[0].state, 'denied')
const denyText = service.read('w1', 80).rows.filter((row) => row.kind === 'approval-answered').pop()
equal('deny is written to the event log', denyText.text, 'deny: not now')

// Approving with nothing pending must fail rather than write a stray response.
let strayRefusal = ''
try { service.approve('w1', false) } catch (failure) { strayRefusal = failure.message }
check('approving with no pending request is refused', strayRefusal.includes('no pending approval'), strayRefusal)

// --- AskUserQuestion -------------------------------------------------------

// Allow alone is not enough for a question tool: the CLI reads its answers out of
// the tool input it is handed back, so `{behavior:'allow'}` with the original
// input runs the tool with no answers and the model is told "The user did not
// answer the questions." The projection has to carry the real choices, and the
// answer has to travel in `updatedInput.answers`.
child.emit({
  type: 'control_request',
  request_id: 'req-ask',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [{ label: 'red' }, { label: 'blue', description: 'the cold one' }],
        },
        {
          question: 'Which extras?',
          header: 'Extras',
          multiSelect: true,
          options: [{ label: 'logs' }, { label: 'metrics' }],
        },
      ],
    },
  },
})
const asking = service.list().items[0]
equal('a question request parks the item', asking.state, 'waiting-approval')
check('the projection carries both questions', asking.pendingQuestions?.length === 2,
  JSON.stringify(asking.pendingQuestions?.map((entry) => entry.question)))
equal('the projection keeps a question header', asking.pendingQuestions?.[0]?.header, 'Colour')
equal('the projection keeps the option labels', asking.pendingQuestions?.[0]?.options?.map((option) => option.label).join(','), 'red,blue')
equal('the projection keeps multiSelect', asking.pendingQuestions?.[1]?.multiSelect, true)
equal('the projection keeps an option description', asking.pendingQuestions?.[0]?.options?.[1]?.description, 'the cold one')

let partialRefusal = ''
try {
  service.answer('w1', [{ question: 'Which colour?', picked: ['red'] }])
} catch (failure) { partialRefusal = failure.message }
check('an answer that skips a question is refused', partialRefusal.includes('has none'), partialRefusal)

let wrongToolRefusal = ''
child.emit({
  type: 'control_request',
  request_id: 'req-plain',
  request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: join(home, 'q.txt') } },
})
try { service.answer('w1', [{ question: 'Which colour?', picked: ['red'] }]) } catch (failure) { wrongToolRefusal = failure.message }
check('answer is refused for a non-question tool', wrongToolRefusal.includes('not waiting on a question'), wrongToolRefusal)
service.deny('w1', 'skip')

// Re-park the question: the plain Write request above replaced it, because a
// session only ever has one request in flight.
child.emit({
  type: 'control_request',
  request_id: 'req-ask',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [{ label: 'red' }, { label: 'blue', description: 'the cold one' }],
        },
        {
          question: 'Which extras?',
          header: 'Extras',
          multiSelect: true,
          options: [{ label: 'logs' }, { label: 'metrics' }],
        },
      ],
    },
  },
})
equal('the question is parked again', service.list().items[0].state, 'waiting-approval')

const writesBeforeAnswer = child.writes.length
service.answer('w1', [
  { question: 'Which colour?', picked: ['blue'] },
  { question: 'Which extras?', picked: ['logs', 'metrics'] },
])
equal('answer writes exactly one control_response', child.writes.length, writesBeforeAnswer + 1)
const answerLine = JSON.parse(child.writes[child.writes.length - 1])
equal('the answer echoes the request id', answerLine.response.request_id, 'req-ask')
equal('the answer allows the tool', answerLine.response.response.behavior, 'allow')
equal('the answer lands in updatedInput.answers', answerLine.response.response.updatedInput.answers['Which colour?'], 'blue')
// The tool's own input schema declares answers as string -> STRING ("multi-select
// answers are comma-separated"); an array there is read as absent.
equal('a multi-select answer is comma-separated',
  answerLine.response.response.updatedInput.answers['Which extras?'], 'logs, metrics')
equal('the original tool input is preserved', Array.isArray(answerLine.response.response.updatedInput.questions), true)
equal('answer clears the pending approval', service.list().items[0].pendingApproval, '')
equal('answer moves the item back to running', service.list().items[0].state, 'running')
equal('answer clears the parked questions', service.list().items[0].pendingQuestions.length, 0)
const answerRow = service.read('w1', 400).rows.filter((row) => row.kind === 'approval-answered').pop()
check('the log records which labels were chosen', String(answerRow?.text).includes('blue'), answerRow?.text)

// A free-text and a number question have NO options. The tool's schema gives them
// `kind: "text" | "number"` plus placeholder / min / max / unit, and a projection
// that dropped those would leave the panel drawing an unanswerable card: an
// option list of length zero with no way to type anything.
child.emit({
  type: 'control_request',
  request_id: 'req-typed',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        { question: 'What name?', kind: 'text', placeholder: 'e.g. report', options: [] },
        { question: 'How many slides?', kind: 'number', min: 1, max: 40, step: 1, defaultValue: 8, unit: 'slides', options: [] },
      ],
    },
  },
})
const typed = service.list().items[0].pendingQuestions
equal('a text question keeps its kind', typed?.[0]?.kind, 'text')
equal('a text question keeps its placeholder', typed?.[0]?.placeholder, 'e.g. report')
equal('a text question has no options', typed?.[0]?.options?.length, 0)
equal('a number question keeps min', typed?.[1]?.min, 1)
equal('a number question keeps max', typed?.[1]?.max, 40)
equal('a number question keeps step', typed?.[1]?.step, 1)
equal('a number question keeps its unit', typed?.[1]?.unit, 'slides')
service.answer('w1', [
  { question: 'What name?', picked: ['report'] },
  { question: 'How many slides?', picked: ['12'] },
])
const typedLine = JSON.parse(child.writes[child.writes.length - 1])
equal('a typed answer travels as the same string map',
  typedLine.response.response.updatedInput.answers['How many slides?'], '12')
equal('a typed answer clears the parked questions', service.list().items[0].pendingQuestions.length, 0)

// --- turns -----------------------------------------------------------------

const turnsBefore = service.list().items[0].turns
const transcriptBefore = service.read('w1', 500).rows.length
check('the transcript holds far more rows than there were turns', transcriptBefore > turnsBefore * 3,
  `${String(transcriptBefore)} rows vs ${String(turnsBefore)} turns`)
service.send('w1', 'second turn')
equal('send increments the turn counter', service.list().items[0].turns, turnsBefore + 1)
// The panel renders this as "N 轮". Deriving it from `transcript.length` made a
// two-turn session report fifty, so pin the two numbers apart explicitly.
const userRows = service.read('w1', 500).rows.filter((row) => row.kind === 'user').length
equal('turns counts user turns, not transcript rows', service.list().items[0].turns, userRows)

// A pending approval must survive a new turn: `send()` used to reset the state
// to running and strand the approval with no UI to answer it.
child.emit({
  type: 'control_request',
  request_id: 'req-5',
  request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: join(home, 'z.txt') } },
})
equal('the approval is pending again', service.list().items[0].state, 'waiting-approval')
service.send('w1', 'third turn')
equal('sending another turn keeps waiting-approval', service.list().items[0].state, 'waiting-approval')
equal('sending another turn keeps the pending approval', service.list().items[0].pendingApproval.startsWith('Write'), true)
service.approve('w1', false)

// --- a result ends the turn, so a parked approval cannot outlive it ---------
//
// Interrupting a turn that was waiting for approval produces, in order:
// approval-requested, tool-error, result. The stale request used to survive the
// result, so the panel kept offering Allow/Deny for a tool Claude Code had
// already abandoned — and pressing Allow wrote a control_response for a
// request_id nobody was listening for.
child.emit({
  type: 'control_request',
  request_id: 'req-stranded',
  // `Edit`, not `Bash`: an earlier scenario remembered `Bash`, so a Bash request
  // is auto-allowed and never parks the item — this check would then pass or fail
  // for the wrong reason.
  request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: join(home, 'w.txt') } },
})
equal('the stranded approval is parked', service.list().items[0].state, 'waiting-approval')
child.emit({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'aborted' }] } })
child.emit({ type: 'result', result: '', is_error: false })
equal('a result clears the stranded approval', service.list().items[0].pendingApproval, '')
equal('a result returns the item to idle', service.list().items[0].state, 'idle')
let strandedRefusal = ''
try { service.approve('w1', false) } catch (failure) { strandedRefusal = failure.message }
check('Allow after a cleared approval is refused rather than sent',
  strandedRefusal.includes('no pending approval'), strandedRefusal)

// --- setMode ---------------------------------------------------------------

const writesBeforeMode = child.writes.length
service.setMode('w1', 'auto')
equal('setMode writes one control_request', child.writes.length, writesBeforeMode + 1)
const modeLine = JSON.parse(child.writes[child.writes.length - 1])
equal('setMode asks for set_permission_mode', modeLine.request.subtype, 'set_permission_mode')
equal('setMode asks for the target mode', modeLine.request.mode, 'auto')
equal('setMode updates the projection', service.list().items[0].mode, 'auto')
const header = JSON.parse(readFileSync(join(root, 'w1.meta.json'), 'utf8'))
equal('setMode rewrites the header', header.mode, 'auto')
const modeRows = service.read('w1', 200).rows.filter((row) => row.kind === 'mode')
check('setMode is written to the event log', modeRows.length === 1, JSON.stringify(modeRows.map((row) => row.text)))

// --- interrupt -------------------------------------------------------------

service.interrupt('w1')
const interruptLine = JSON.parse(child.writes[child.writes.length - 1])
equal('interrupt asks for the interrupt subtype', interruptLine.request.subtype, 'interrupt')

// --- attachments -------------------------------------------------------------
//
// The CLI takes images as content blocks of the user message (measured with
// tools/probe-image.mjs). Text and images travel in ONE turn, and an image alone
// is legal — refusing it because the text box was empty is a rule the CLI does not
// have.
await service.send('w1', 'look at this', [
  { mediaType: 'image/png', data: 'AAAA', name: 'a.png' },
  { mediaType: 'text/plain', data: 'nope' },
  { mediaType: 'image/jpeg', data: '' },
])
const withImages = JSON.parse(ctx.children.at(-1).writes.at(-1))
const content = withImages.message.content
equal('the turn carries the text block', content.at(-1).type, 'text')
equal('the turn carries one image block', content.filter((block) => block.type === 'image').length, 1)
equal('the image block is base64 with its media type', content[0].source.media_type, 'image/png')
equal('the image block carries the payload', content[0].source.data, 'AAAA')
check('a non-image attachment is dropped', !content.some((block) => block.source?.media_type === 'text/plain'))
check('an empty payload is dropped', !content.some((block) => block.source?.data === ''))
const imageRows = service.read('w1', 100).rows.filter((row) => row.kind === 'user')
equal('the transcript counts the images', imageRows.at(-1)?.images, 1)
equal('the transcript keeps the text', imageRows.at(-1)?.text, 'look at this')

await service.send('w1', '   ', [{ mediaType: 'image/png', data: 'BBBB' }])
const imageOnly = JSON.parse(ctx.children.at(-1).writes.at(-1))
check('an image alone is a legal turn', imageOnly.message.content.length === 1
  && imageOnly.message.content[0].type === 'image', JSON.stringify(imageOnly.message.content.map((block) => block.type)))
let emptyRefusal = ''
try { await service.send('w1', '   ', []) } catch (failure) { emptyRefusal = String(failure.message) }
check('an empty turn is still refused', emptyRefusal.includes('at least one image'), emptyRefusal)

// --- the transcript window starts at a question -----------------------------
//
// A long turn is hundreds of process rows, so `slice(-N)` lands in the MIDDLE of
// one. The panel groups its transcript by `user` rows, so an orphan first row used
// to become a turn of its own — its heading read "up after 4s", a line of shell
// output that looked like something the reader had asked. Measured on a real item
// (cc-mvymhjvf-3): 1 190 rows, the last question 129 rows from the end, and the
// 120-row window contained no question at all.
const child0 = ctx.children[0]
child0.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'before' }] } })
await service.send('w1', 'the real question')
for (let index = 0; index < 150; index += 1) {
  child0.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `step ${index}` } }] } })
}
const windowed = service.read('w1', 40)
equal('a short window is widened back to the question', windowed.rows[0].kind, 'user')
check('the widened window still ends at the newest row',
  String(windowed.rows.at(-1).text).includes('step 149'), String(windowed.rows.at(-1).text))

// A question that is unreasonably far back is NOT chased: one tool call must not
// drag the whole transcript into a single poll.
for (let index = 0; index < 500; index += 1) {
  child0.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `bulk ${index}` } }] } })
}
const capped = service.read('w1', 40)
check('a very old question is not chased', capped.rows.length <= 40 + 400,
  `${capped.rows.length} rows`)

// --- exit ------------------------------------------------------------------

// `done.then(…)` is a microtask, so the state only settles on the next turn of
// the loop; the test has to let that happen before reading the projection.
child.exit(0)
await new Promise((resolve) => setImmediate(resolve))
equal('an exit marks the item done', service.list().items[0].state, 'done')
equal('an exit records the exit code', service.list().items[0].exitCode, 0)
equal('an exit releases the process handle', service.list().items[0].state === 'done', true)

// --- rename ----------------------------------------------------------------

const renamed = service.rename('w1', '  a better name  ')
equal('rename trims the title', renamed.item.title, 'a better name')
const renamedHeader = JSON.parse(readFileSync(join(root, 'w1.meta.json'), 'utf8'))
equal('rename writes the header', renamedHeader.title, 'a better name')
let blankRefusal = ''
try { service.rename('w1', '   ') } catch (failure) { blankRefusal = String(failure.message) }
check('a blank title is refused', blankRefusal.includes('title is required'), blankRefusal)
let unknownRefusal = ''
try { service.rename('nope', 'x') } catch (failure) { unknownRefusal = String(failure.message) }
check('renaming an unknown item is refused', unknownRefusal.includes('unknown work item'), unknownRefusal)

// --- reopening a finished session ------------------------------------------
//
// `send()` on a stopped item used to throw "work item … is not running", which
// left the panel's composer looking usable against a dead item: the user typed,
// nothing happened, and the only feedback was an error banner. A finished item is
// not a broken thing to type into — it reopens in the same directory, and the
// previous conversation is carried into the new process, because `-p` sessions
// never persist to ~/.claude/projects and `--resume` cannot find them.

const childrenBefore = ctx.children.length
const reopenResult = await service.send('w1', 'carry on')
equal('send on a finished item reopens instead of throwing', reopenResult.item.state, 'running')
equal('reopening spawns one new child', ctx.children.length, childrenBefore + 1)
const child3 = ctx.children[ctx.children.length - 1]
const reopenArgv = child3.spawnOptions.argv
equal('the reopened process uses the same directory', child3.spawnOptions.cwd, home)
check('the reopened process is a fresh claude -p', reopenArgv.includes('-p'), reopenArgv.join(' '))
check('the reopened process keeps the permission prompt tool',
  reopenArgv[reopenArgv.indexOf('--permission-prompt-tool') + 1] === 'stdio', reopenArgv.join(' '))
// No CLI transcript was written for this session id (`s-1` is a fresh fake), so
// this reopen takes the fallback path: the previous conversation is replayed as a
// text primer instead of `--resume`.
check('a reopen without a CLI transcript does not pass --resume', !reopenArgv.includes('--resume'), reopenArgv.join(' '))

const reopenRows = service.read('w1', 500).rows
check('the transcript says the session was reopened',
  reopenRows.some((row) => row.kind === 'reopened'), JSON.stringify(reopenRows.filter((row) => row.kind === 'reopened').map((row) => row.text)))
const firstWrite = JSON.parse(child3.writes[0])
const carried = firstWrite.message.content[0].text
check('the new process is told the old session ended', carried.includes('新的会话进程'), carried.slice(0, 80))
check('the new process receives the previous turns as context', carried.includes('carry on') && carried.includes('hello'), carried.slice(0, 120))
equal('the item is running again', service.list().items[0].state, 'running')

// The reopened process starts its own token counters at zero, so the cumulative
// baseline must reset with it. Without this, the first answer of the new process
// reports a delta against the dead process's totals — zero, so its usage line is
// silently empty and the panel looks like it stopped measuring.
child3.emit({
  type: 'result',
  result: 'fresh',
  duration_ms: 5000,
  usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0 },
})
const freshRow = service.read('w1', 500).rows.filter((row) => row.kind === 'result').at(-1)
equal('the reopened process measures from zero', freshRow.outputTokens, 200)
equal('the reopened process measures its own input', freshRow.inputTokens, 900)
equal('the reopened process still gets a tps figure', freshRow.tps, 40)

// A second send must NOT reopen again: the handle is alive now.
const childrenAfterReopen = ctx.children.length
await service.send('w1', 'and again')
equal('a send on a live item does not spawn again', ctx.children.length, childrenAfterReopen)

// Put it back to a finished item so the remaining scenarios see what they expect.
child3.exit(0)
await new Promise((resolve) => setImmediate(resolve))
equal('the reopened item can finish again', service.list().items[0].state, 'done')

// --- forget ----------------------------------------------------------------

service.forget('w1')
equal('forget drops the item', service.list().items.length, 0)
check('forget removes the event log', !existsSync(join(root, 'w1.jsonl')))
check('forget removes the header', !existsSync(join(root, 'w1.meta.json')))

// --- reload ----------------------------------------------------------------

// Everything above ran against in-memory state; the reload path rebuilds from
// the files, so it is the only way to prove persistence actually works.
const started2 = await service.start({ id: 'w2', title: 'reload', cwd: home, mode: 'manual' })
check('a second item opens', started2.item.id === 'w2')
const child2 = ctx.children[ctx.children.length - 1]
child2.emit({ type: 'system', subtype: 'init', session_id: 's-2', model: 'm2' })
service.send('w2', 'hello')
service.setMode('w2', 'auto')
child2.emit({
  type: 'result',
  result: 'all good',
  duration_ms: 8000,
  usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0 },
})

await ctx.dispose()
check('disposal terminates the resident child', child2.terminated === true)

const ctx2 = createCtx()
apply(ctx2)
const service2 = ctx2.services.get('claudeSessions')
const reloaded = service2.list().items
equal('a reload finds the persisted item', reloaded.length, 1)
const w2 = reloaded[0]
equal('a reload restores the id', w2.id, 'w2')
equal('a reload restores the title', w2.title, 'reload')
equal('a reload restores the mode from the log', w2.mode, 'auto')
equal('a reload restores the turn count', w2.turns, 1)
equal('a reload restores the last result', w2.lastResult, 'all good')
equal('a reload restores the session id', w2.sessionId, 's-2')
equal('a reload reports the item as done', w2.state, 'done')

// --- rail totals -----------------------------------------------------------
//
// One line per work item in the rail: total steps, total tokens, the context the
// last turn filled and the live turn's start. They are transcript-wide, so they
// must survive the reload below — which is the whole reason they are rebuilt from
// the log instead of read off the process.
const w2Item = service2.list().items[0]
check('the rail reports a step total', typeof w2Item.steps === 'number' && w2Item.steps > 0, String(w2Item.steps))
check('the rail reports output tokens', w2Item.outputTokens === 100, String(w2Item.outputTokens))
check('the rail reports input tokens', w2Item.inputTokens === 500, String(w2Item.inputTokens))
check('the rail reports the context the last turn filled', w2Item.contextTokens === 500, String(w2Item.contextTokens))
equal('a finished item has no turn in flight', w2Item.turnStartedAt, 0)

// The usage fields ride on the `result` row, so they survive a reload with it. A
// reloaded session must not start counting from zero on its next turn either:
// `loadHistory` replays the log, which re-establishes the cumulative baseline.
const reloadedRows = service2.read('w2', 50).rows
const reloadedResult = reloadedRows.filter((row) => row.kind === 'result').at(-1)
equal('a reload keeps the per-turn duration', reloadedResult?.durationMs, 8000)
equal('a reload keeps the per-turn output count', reloadedResult?.outputTokens, 100)
equal('a reload keeps the per-turn tps', reloadedResult?.tps, 12.5)

// --- resuming a finished session ------------------------------------------
//
// When the CLI still has its own transcript for the session id, sending to a
// finished item resumes that conversation instead of replaying a text primer.
// The transcript lives under `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl`, so the
// test points CLAUDE_CONFIG_DIR at the scratch tree and creates the file.
const claudeConfig = join(home, 'claude-config')
const projectDir = join(claudeConfig, 'projects', 'C--scratch')
mkdirSync(projectDir, { recursive: true })
const resumeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
writeFileSync(join(projectDir, `${resumeId}.jsonl`), '{}\n')
const previousConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = claudeConfig

// The header was written before `init` reached the Host (that is the real order:
// `start()` writes it, the CLI reports the id later), so it still says `s-2`.
// `loadHistory` therefore prefers the `init` row in the log — which is why the
// log is read for this at all. Rewriting the header here models what
// `persistHeader` now does on `init`, and the reload below is what proves the
// item actually carries a resumable id.
writeFileSync(join(root, 'w2.meta.json'), JSON.stringify({
  id: 'w2', title: 'reload', cwd: home, mode: 'auto', sessionId: resumeId, startedAt: Date.now(), allowRules: [],
}))
// The log-scraped id (`s-2`) wins over the header, and there is no transcript for
// it, so this item would take the primer path. Point the fake `init` row at the
// resumable id instead: that is the shape a real log has.
const logPath = join(root, 'w2.jsonl')
const rewrittenLog = readFileSync(logPath, 'utf8')
  .split('\n')
  .map((line) => (line.includes('"kind":"init"') ? JSON.stringify({ at: Date.now(), kind: 'init', text: `m2 · ${resumeId}` }) : line))
  .join('\n')
writeFileSync(logPath, rewrittenLog)
const ctx4 = createCtx()
apply(ctx4)
const service4 = ctx4.services.get('claudeSessions')
const resumedItem = service4.list().items[0]
equal('the log init row wins over a stale header', resumedItem.sessionId, resumeId)

const beforeResume = ctx4.children.length
await service4.send('w2', 'go on')
equal('resuming spawns one child', ctx4.children.length, beforeResume + 1)
const resumeChild = ctx4.children[ctx4.children.length - 1]
const resumeArgv = resumeChild.spawnOptions.argv
check('a reopen with a CLI transcript passes --resume', resumeArgv.includes('--resume'), resumeArgv.join(' '))
equal('--resume names the session', resumeArgv[resumeArgv.indexOf('--resume') + 1], resumeId)
const resumeWrite = JSON.parse(resumeChild.writes[0])
equal('a resumed message carries only the new turn', resumeWrite.message.content[0].text, 'go on')
// The `session_id` echo stays on the wire: measured against the real CLI, a
// resumed process accepts it and keeps answering (tools/probe-resume.mjs).
equal('a resumed message still names the session', resumeWrite.session_id, resumeId)
const resumeRows = service4.read('w2', 500).rows
check('the log says the session was resumed, not primed',
  resumeRows.some((row) => row.kind === 'reopened' && row.text.includes('resumed')), JSON.stringify(resumeRows.filter((row) => row.kind === 'reopened').map((row) => row.text)))
// The panel words its banner differently for the two handovers, so the row has to
// carry WHICH one it was instead of leaving the sentence to be parsed.
check('the resumed row is marked as a resume',
  resumeRows.some((row) => row.kind === 'reopened' && row.resumed === true), JSON.stringify(resumeRows.filter((row) => row.kind === 'reopened')))

// And when the transcript is missing, the primer path is still there.
rmSync(join(projectDir, `${resumeId}.jsonl`), { force: true })
await service4.stop('w2')
await service4.send('w2', 'again')
const primedChild = ctx4.children[ctx4.children.length - 1]
const primedArgv = primedChild.spawnOptions.argv
check('a reopen without a CLI transcript falls back to the primer', !primedArgv.includes('--resume'), primedArgv.join(' '))
check('a primed reopen is marked as not resumed',
  service4.read('w2', 500).rows.filter((row) => row.kind === 'reopened').at(-1)?.resumed === false,
  JSON.stringify(service4.read('w2', 500).rows.filter((row) => row.kind === 'reopened')))
check('the fallback still carries the previous turns',
  JSON.parse(primedChild.writes[0]).message.content[0].text.includes('新的会话进程'),
  JSON.parse(primedChild.writes[0]).message.content[0].text.slice(0, 60))
if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
else process.env.CLAUDE_CONFIG_DIR = previousConfig

// ------------------------------------------------------------------ report

rmSync(home, { recursive: true, force: true })
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

console.log('')
if (failures.length === 0) {
  console.log(`${checks}/${checks} checks passed`)
  console.log('HOST OK')
} else {
  console.log(`${checks - failures.length}/${checks} checks passed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
