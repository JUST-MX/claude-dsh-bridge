/**
 * Host half of @local/dsh-plugin-claude-sessions.
 *
 * One work item is one resident `claude -p` process started from inside
 * DeepSeek Harness. Nothing the user starts in their own shell is tracked here:
 * the plugin only knows about processes it spawned itself.
 *
 * Wire surface: `tools/api-spec.mjs` is the single source of truth, and
 * `tools/gen-typert.mjs` emits `typert.js` (the Host face typert-loader
 * registers) from it. This module provides the Cordis service those invocations
 * dispatch to, and one agent tool for the operations that do not grant
 * authority.
 *
 * @module @local/dsh-plugin-claude-sessions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis service key, Remote namespace, and tool prefix. */
const SERVICE = 'claudeSessions'

/** The states the panel distinguishes. */
const STATE = {
  running: 'running',
  waitingApproval: 'waiting-approval',
  idle: 'idle',
  denied: 'denied',
  // A turn that ended because the API could not be reached. Distinct from
  // `denied` (a human or a policy refused something) and from `done` (the session
  // finished its work): the retry loop gave up, and the fix is to restore the
  // endpoint rather than to approve anything. The rail paints it red, which is the
  // same bucket the reader already reads as "this went wrong".
  error: 'error',
  done: 'done',
}

/** Keep resident processes alive only while they hold something worth reading. */
const MAX_TRANSCRIPT_ROWS = 2000

/**
 * A row that grows while the model is still writing it.
 *
 * `--include-partial-messages` delivers an answer as token-sized deltas
 * (`content_block_delta/text_delta`) — measured with `tools/probe-stream.mjs`:
 * 25 deltas for a 30-line reply. Appending one log line per delta would put
 * twenty-five rows where the transcript used to have one, so the live text is
 * held in memory and handed to the panel as a single extra row of this kind on
 * every `read()`. It never reaches the log: the finished block arrives as an
 * `assistant` record and takes the row over.
 */
const STREAMING_KIND = 'streaming'

/** Operations only a human in the panel may perform: they grant or refuse authority. */
const USER_ONLY = new Set(['approve', 'deny', 'answer'])

/** Services this plugin needs before it can activate. */
export const inject = ['subprocess', 'tools']

// --------------------------------------------------------------------- utils

/** Keep the last `limit` characters of a diagnostic line. */
function tail(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `…${value.slice(-limit)}`
}

/** Strip a trailing slash so a directory compares canonically. */
function trimDir(path) {
  return String(path ?? '').replace(/[\\/]+$/, '')
}

/**
 * The ways the CLI opens a permission refusal it wrote itself.
 *
 * Three shapes ship in the binary: the auto-mode classifier's verdict, a plain
 * refusal, and "this session has no approval surface". All three arrive twice on
 * the stream — as `system/permission_denied` (which names the tool) and as the
 * `tool_result` the model reads — so they also need recognising for de-duplication.
 */
const DENIAL_PREFIXES = [
  'Permission for this action was denied by the Claude Code auto mode classifier.',
  'Permission for this action has been denied.',
  'Permission for this tool use was denied.',
]

/** Whether one piece of text is a CLI-authored permission refusal. */
function isDenialText(text) {
  const value = String(text ?? '')
  return DENIAL_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * The part of a permission refusal a person should read.
 *
 * The CLI writes its refusal for the MODEL: after the reason it appends "If you
 * have other tasks that don't depend on this action, continue working on those.
 * IMPORTANT: You *may* attempt to accomplish this action using other tools…".
 * That is an instruction to Claude, and in a transcript a human reads it is pure
 * noise — it made one refusal 1 509 characters long, of which 60 said what
 * happened. The CLI splits the two itself (its own `CPo` keys on the same
 * sentinel), so this shows exactly what the CLI would show.
 */
function denialReason(text) {
  const value = String(text ?? '')
  if (!isDenialText(value)) return value
  let body = value
  const reasonAt = body.indexOf('Reason: ')
  if (reasonAt >= 0) body = body.slice(reasonAt + 'Reason: '.length)
  else {
    // The "no approval surface" variant carries no `Reason:`; the actionable part
    // is what needed approval.
    const requiredAt = body.indexOf('What required approval: ')
    if (requiredAt >= 0) body = body.slice(requiredAt + 'What required approval: '.length)
  }
  const stop = body.indexOf('. If you have other tasks')
  return stop > 0 ? body.slice(0, stop) : body
}

/**
 * The questions a parked `can_use_tool` request is asking, in wire form.
 *
 * AskUserQuestion's input is `{ questions: [{ question, header, multiSelect,
 * options: [{ label, description }] }] }`. The panel needs all of that to draw
 * the choices, and the answer has to come back as labels keyed by the question
 * text, so the projection keeps the same shape rather than flattening it into a
 * sentence.
 *
 * A question is not always a choice. The tool also takes `kind: 'text'` (a free
 * text box, no options) and `kind: 'number'` (a slider between min and max), and
 * those carry `placeholder` / `min` / `max` / `step` / `defaultValue` / `unit`.
 * Rendering such a question as an empty option list would leave the panel with a
 * card nobody can answer, so the kind travels with the projection.
 * @param request - one parked approval.
 * @returns an array of question projections; empty for a non-question tool.
 */
function questionsOf(request) {
  const list = request?.input?.questions
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const question = String(entry.question ?? '')
    if (question === '') continue
    const options = []
    for (const option of Array.isArray(entry.options) ? entry.options : []) {
      const label = String(option?.label ?? '')
      if (label === '') continue
      const item = { label }
      const description = String(option?.description ?? '')
      if (description !== '') item.description = description
      options.push(item)
    }
    const narrow = { question, options }
    const kind = entry.kind === 'text' || entry.kind === 'number' ? entry.kind : 'choice'
    if (kind !== 'choice') narrow.kind = kind
    const header = String(entry.header ?? '')
    if (header !== '') narrow.header = header
    if (entry.multiSelect === true) narrow.multiSelect = true
    const placeholder = String(entry.placeholder ?? '')
    if (placeholder !== '') narrow.placeholder = placeholder
    for (const key of ['min', 'max', 'step', 'defaultValue']) {
      if (typeof entry[key] === 'number' && Number.isFinite(entry[key])) narrow[key] = entry[key]
    }
    const unit = String(entry.unit ?? '')
    if (unit !== '') narrow.unit = unit
    out.push(narrow)
  }
  return out
}

/** The storage root: `<DSH_HOME>/storages/claude-sessions`. */
function storageRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'claude-sessions')
}

/**
 * Whether the CLI still has the transcript for one session id.
 *
 * `--resume` on an id the CLI cannot find is not a soft failure: the process
 * answers with `subtype:"error_during_execution"` and exits, so a work item would
 * look broken after a single message. The transcript lives at
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is the working
 * directory with every non-alphanumeric character replaced by `-` — but that rule
 * is the CLI's, not the wire protocol's, so every project directory is checked
 * rather than computing the slug and hoping it still matches.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because a probe or a test can point the CLI at
 * a different tree; `~/.claude` is only the default.
 * @param sessionId - the id the CLI reported at `init`.
 * @returns true when a transcript file with that name exists anywhere under
 *   `<config>/projects`.
 */
function transcriptExists(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return false
  const config = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== ''
    ? process.env.CLAUDE_CONFIG_DIR
    : join(homedir(), '.claude')
  const projects = join(config, 'projects')
  let names
  try {
    names = readdirSync(projects, { withFileTypes: true })
  } catch {
    return false
  }
  const file = `${id}.jsonl`
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    try {
      if (existsSync(join(projects, entry.name, file))) return true
    } catch {
      // An unreadable directory is not a match.
    }
  }
  return false
}

/** Split a byte stream into newline-delimited records across chunk boundaries. */
function createLineReader(onLine) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') onLine(line)
      }
    },
    flush() {
      const line = buffer.trim()
      buffer = ''
      if (line !== '') onLine(line)
    },
  }
}

/** Coerce one stored or live row into the fields the wire schema declares. */
function rowView(row) {
  const narrow = { kind: String(row.kind ?? '') }
  if (typeof row.at === 'number') narrow.at = row.at
  if (typeof row.seq === 'number') narrow.seq = row.seq
  if (typeof row.text === 'string' && row.text !== '') narrow.text = row.text
  if (typeof row.tool === 'string' && row.tool !== '') narrow.tool = row.tool
  // How many images a user turn carried. The images themselves are not logged.
  if (typeof row.images === 'number' && row.images > 0) narrow.images = row.images
  // On a `reopened` row: whether the CLI resumed its own transcript (true) or the
  // turns were replayed as a text primer (false). Absent on older logs.
  if (typeof row.resumed === 'boolean') narrow.resumed = row.resumed
  if (typeof row.code === 'number') narrow.code = row.code
  // The per-turn usage the panel prints under an answer. Only a `result` row
  // carries it, so they travel together and an older log (written before these
  // fields existed) simply has none of them.
  for (const key of ['durationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'contextTokens', 'tps']) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key])) narrow[key] = row[key]
  }
  return narrow
}

// ----------------------------------------------------------------- work item

/**
 * Whether one transcript row counts as a step of its turn.
 *
 * The panel's folded heading says "N steps", where a step is everything the turn
 * did that is not something a person said or the answer itself: thinking, tool
 * calls and their results, refusals, retries, notices. The rail's total is the
 * same predicate over the whole transcript, so the two numbers cannot disagree.
 * @param kind - a transcript row's kind.
 * @returns true when the row is part of a turn's process.
 */
function countsAsStep(kind) {
  if (kind === 'user' || kind === 'result' || kind === 'api-error') return false
  return true
}


/** One resident Claude Code session and everything the panel shows about it. */
class WorkItem {
  constructor({ id, title, cwd, mode }) {
    this.id = id
    this.title = title
    this.cwd = cwd
    this.mode = mode === 'manual' ? 'manual' : 'auto'
    this.state = STATE.idle
    this.sessionId = ''
    this.model = ''
    this.transcript = []
    // User turns, not transcript rows. The panel renders this as "N 轮", and
    // `transcript.length` counted every thinking/tool-use/tool-result row too —
    // a two-turn session reported "50 turns", which reads as nonsense.
    this.turns = 0
    this.pendingApproval = null
    // The answer the model is still writing, as `{ at, text }`. It is a row
    // BEFORE it is finished: the panel polls every two seconds, and without a row
    // there is nothing to show until the whole turn is over. It is replaced by
    // the real `assistant` record when the block closes, so it never reaches the
    // log as a kind of its own.
    this.streaming = null
    this.allowRules = new Set()
    // The exact texts of CLI permission refusals already recorded. Each one also
    // arrives as a `tool_result`, and that echo must not become a second row.
    this.denialsSeen = new Set()
    this.lastResult = ''
    this.costUsd = 0
    this.durationMs = 0
    this.exitCode = undefined
    this.startedAt = Date.now()
    this.lastActivityAt = this.startedAt
    this.revision = 1
    this.handle = null
    this.reader = null
    // Cumulative token counters as of the last `result`. `usage` in a result
    // record is process-wide, so the per-turn figure is the delta from here.
    this.usageTotals = { output: 0, input: 0, cacheRead: 0 }
    // --- the rail's totals (one line per work item) -------------------------
    // Everything below is summed from the whole transcript, not from the current
    // process, so a reopened session keeps counting where the last one stopped.
    // `usageTotals` starts again at zero on a reopen (it only measures a delta);
    // these do not, and must not.
    this.steps = 0
    this.tokens = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
    // Where the last answer ended up, in tokens: the prompt the model saw on the
    // most recent turn. That is the number a reader means by "how full is the
    // context", and the only one the wire can report without inventing a limit.
    this.contextTokens = 0
    this.contextLimit = 0
    // Wall-clock of the turn in flight, so the rail can show a running timer
    // instead of a duration that only exists after the answer arrives.
    this.turnStartedAt = 0
    // Cumulative cache-write count as of the last result; only the delta matters,
    // and the first result of a process reports the whole prompt as written.
    this.cacheWriteTotals = 0
    // A monotonic number per row, so the panel can key a transcript row by
    // identity. It used to key by (timestamp, position-in-window), and once the
    // 120-row window started sliding every position shifted under it — which
    // silently threw away which turns the reader had folded.
    this.rowSeq = 0
  }

  /** Whether a live process still backs this item. */
  get live() {
    return this.handle !== null
  }

  /** Note a change so the polling panel and the Host log agree on ordering. */
  touch() {
    this.revision += 1
    this.lastActivityAt = Date.now()
  }
}

// ---------------------------------------------------------------------- plugin

/**
 * Register the work-item service, the persistence log, and the agent tool.
 * @param ctx - the Host Cordis context.
 */
export function apply(ctx) {
  /** Every work item this plugin has ever opened, by id. */
  const items = new Map()
  /** Monotonic id suffix for records that need a correlation number. */
  let sequence = 0
  let ready = false

  const root = storageRoot()

  /** The projection handed to the wire; its fields match api-spec.mjs exactly. */
  function view(item) {
    const approval = item.pendingApproval === null
      ? ''
      : `${item.pendingApproval.tool}${item.pendingApproval.summary ? ` · ${item.pendingApproval.summary}` : ''}`
    const snapshot = {
      id: item.id,
      title: item.title,
      cwd: item.cwd,
      mode: item.mode,
      state: item.state,
      sessionId: item.sessionId,
      model: item.model,
      turns: item.turns,
      pendingApproval: approval,
      pendingQuestions: item.pendingApproval === null ? [] : questionsOf(item.pendingApproval),
      allowRules: [...item.allowRules].join(','),
      startedAt: item.startedAt,
      lastActivityAt: item.lastActivityAt,
      lastResult: item.lastResult,
      costUsd: item.costUsd,
      durationMs: item.durationMs,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : 0,
      revision: item.revision,
      steps: item.steps,
      outputTokens: item.tokens.output,
      inputTokens: item.tokens.input,
      cacheReadTokens: item.tokens.cacheRead,
      cacheWriteTokens: item.tokens.cacheWrite,
      contextTokens: item.contextTokens,
      contextLimit: item.contextLimit,
      // The turn in flight: the panel counts up from here. Zero means none.
      turnStartedAt: item.turnStartedAt,
    }
    // A stopped item has no exit code; report 0 rather than omitting the field,
    // because the wire schema declares a number and the panel formats it.
    if (item.exitCode !== undefined && item.exitCode !== null) snapshot.exitCode = item.exitCode
    return snapshot
  }

  /** Remember one refusal text so its duplicate on the other channel is dropped. */
  function rememberDenial(item, text) {
    item.denialsSeen.add(text)
    // Bounded: a long session cannot accumulate refusals for ever.
    while (item.denialsSeen.size > 8) {
      item.denialsSeen.delete(item.denialsSeen.values().next().value)
    }
  }

  /** Append one transcript row to memory and to the item's event log. */
  function record(item, row) {
    item.rowSeq += 1
    const next = { at: Date.now(), seq: item.rowSeq, ...row }
    if (countsAsStep(next.kind)) item.steps += 1
    item.transcript.push(next)
    if (item.transcript.length > MAX_TRANSCRIPT_ROWS) {
      item.transcript.splice(0, item.transcript.length - MAX_TRANSCRIPT_ROWS)
    }
    item.touch()
    persist(item, next)
  }

  /**
   * The per-turn figures the panel prints under one answer.
   *
   * `usage` in a `result` record is cumulative for the whole process: turn 3
   * reports the tokens of turns 1–3 combined. Printing that under turn 3's answer
   * would be wrong (it grows monotonically and the last turn looks enormous), so
   * the per-turn number is the delta since the previous result.
   *
   * `tps` follows the DSH chat UI's own rule (`formatTokensPerSecond` in
   * `dsh-client-ui-chat`): decode throughput is output tokens over the decode
   * window, and whole numbers from ten up, one decimal below. The decode window
   * is approximated by the wall-clock duration minus the cache-read share, which
   * is not measurable from here; the CLI's `ttft_ms` is subtracted instead when
   * it is present, which is the closest honest proxy for "time not spent
   * generating".
   * @param item - the work item, for the previous cumulative counters.
   * @param payload - one `result` protocol record.
   * @returns the numeric fields to hang on the `result` row.
   */
  function turnUsage(item, payload) {
    const usage = payload?.usage ?? {}
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const output = number(usage.output_tokens)
    const input = number(usage.input_tokens)
    const cacheRead = number(usage.cache_read_input_tokens)
    const previous = item.usageTotals ?? { output: 0, input: 0, cacheRead: 0 }
    const delta = {
      output: Math.max(0, output - previous.output),
      input: Math.max(0, input - previous.input),
      cacheRead: Math.max(0, cacheRead - previous.cacheRead),
    }
    item.usageTotals = { output, input, cacheRead }
    // The per-turn deltas, accumulated for the rail's totals line. The CLI's
    // `usage` is process-wide, so `input + cacheRead + cacheCreate` on the LAST
    // result is exactly what the prompt held on that turn — the context figure.
    const cacheWrite = number(usage.cache_creation_input_tokens)
    // Replaced, not accumulated: see the note in `case 'result'` — the cumulative
    // figures are not trustworthy as a running total.
    item.tokens = {
      output: delta.output,
      input: delta.input,
      cacheRead: delta.cacheRead,
      cacheWrite: Math.max(0, cacheWrite - (item.cacheWriteTotals ?? 0)),
    }
    item.cacheWriteTotals = cacheWrite
    item.contextTokens = input + cacheRead + cacheWrite
    // The context window comes from the CLI's own per-model report, not from a
    // table in this plugin: the gateway can serve whatever it likes, and guessing
    // here would draw a gauge against the wrong ceiling.
    const models = payload?.modelUsage !== null && typeof payload?.modelUsage === 'object'
      ? Object.values(payload.modelUsage)
      : []
    for (const model of models) {
      const limit = number(model?.contextWindow)
      if (limit > 0) item.contextLimit = limit
    }

    const durationMs = number(payload?.duration_ms)
    const ttft = number(payload?.ttft_ms)
    // Long enough to be a real answer, and at least 1 ms so the division is safe.
    const generating = Math.max(1, durationMs - Math.max(0, ttft))
    const tps = delta.output > 0 && durationMs > 0 ? (delta.output / (generating / 1000)) : 0

    const out = {}
    if (durationMs > 0) out.durationMs = durationMs
    if (delta.input > 0) out.inputTokens = delta.input
    if (delta.output > 0) out.outputTokens = delta.output
    if (delta.cacheRead > 0) out.cacheReadTokens = delta.cacheRead
    if (tps > 0) out.tps = Math.round(tps * 10) / 10
    // The prompt size at the end of this turn, so a reload can restore the rail's
    // context figure without re-deriving the CLI's cumulative arithmetic.
    if (item.contextTokens > 0) out.contextTokens = item.contextTokens
    return out
  }

  /** Append one record to `<storages>/claude-sessions/<id>.jsonl`. */
  function persist(item, row) {
    if (!ready) return
    try {
      appendFileSync(join(root, `${item.id}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      // Persistence is a convenience; a failure must not break a live session.
    }
  }

  /** Write one work item's header so a restart can rebuild the list. */
  function persistHeader(item) {
    if (!ready) return
    try {
      writeFileSync(join(root, `${item.id}.meta.json`), JSON.stringify({
        id: item.id,
        title: item.title,
        cwd: item.cwd,
        mode: item.mode,
        sessionId: item.sessionId,
        startedAt: item.startedAt,
        allowRules: [...item.allowRules],
      }), 'utf8')
    } catch {
      // Same reasoning as above.
    }
  }

  /** Resolve one work item or fail with a message the panel can show. */
  function itemOrThrow(id) {
    const item = items.get(String(id ?? ''))
    if (item === undefined) throw new Error(`unknown work item: ${String(id)}`)
    return item
  }

  /**
   * The narrower projection the agent tool declares. The tool's output schema is
   * enforced field by field with `additionalProperties: false`, while the panel's
   * wire view carries more; keeping the two separate stops a richer view from
   * failing the tool result.
   */
  function toolItem(item) {
    const snapshot = view(item)
    return {
      id: snapshot.id,
      title: snapshot.title,
      cwd: snapshot.cwd,
      mode: snapshot.mode,
      state: snapshot.state,
      turns: snapshot.turns,
      pendingApproval: snapshot.pendingApproval,
    }
  }

  /** The single text block the model reads for one tool result. */
  function renderToolResult(value) {
    if (value.ok !== true) return `failed: ${String(value.error ?? 'unknown error')}`
    if (Array.isArray(value.items)) {
      if (value.items.length === 0) return 'no work items'
      return value.items
        .map((item) => {
          const approval = item.pendingApproval ? `  ← ${item.pendingApproval}` : ''
          return `${String(item.state).padEnd(16)} ${item.id}  ${item.cwd}  [${item.mode}, ${String(item.turns)} turns]${approval}`
        })
        .join('\n')
    }
    if (value.item !== undefined && Array.isArray(value.rows)) {
      const header = `${value.item.state}  ${value.item.id}  ${value.item.cwd}`
      const body = value.rows.map((row) => {
        // A tool row is labelled with the tool's name, not with its kind: the
        // model reading this needs to know WHICH tool ran, and `tool-use` alone
        // says nothing. Every other row keeps its kind.
        const label = row.kind === 'tool-use' && row.tool !== undefined ? `${row.kind}:${row.tool}` : row.kind
        const detail = row.text ?? (row.code !== undefined ? String(row.code) : '')
        return detail === '' ? `[${label}]` : `[${label}] ${detail}`
      })
      return body.length === 0 ? header : `${header}\n${body.join('\n')}`
    }
    if (value.item !== undefined) {
      const approval = value.item.pendingApproval ? `  ← ${value.item.pendingApproval}` : ''
      return `${value.item.state}  ${value.item.id}  ${value.item.cwd}${approval}`
    }
    return 'ok'
  }

  /** Write one protocol line to the resident process's stdin pipe. */
  function sendLine(item, payload) {
    const into = item.handle?.stdin
    if (!into) throw new Error(`work item ${item.id} is not running`)
    into.write(`${JSON.stringify(payload)}\n`)
  }

  /** Answer a pending tool approval, remembering the tool when asked. */
  function respondToApproval(item, behavior, message, remember) {
    if (item.pendingApproval === null) return false
    const request = item.pendingApproval
    sendLine(item, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.requestId,
        response: behavior === 'allow'
          ? { behavior: 'allow', updatedInput: request.input ?? {} }
          : { behavior: 'deny', message: message ?? 'denied from DeepSeek Harness' },
      },
    })
    if (behavior === 'allow' && remember === true && request.tool !== '') {
      // `bypassPermissions` cannot be granted to a session that did not start
      // with --dangerously-skip-permissions, so "always allow" is a Host-side
      // memory: the same tool is answered without asking from now on.
      item.allowRules.add(request.tool)
      record(item, { kind: 'policy', text: `allow ${request.tool}` })
    }
    // The decision itself belongs in the log: the P1 replay is read-only, and a
    // transcript that jumps from "approval-requested" straight to a tool-result
    // cannot say whether a human allowed it, a human refused it, or the Host
    // auto-allowed it from `allowRules`. That distinction is the whole point of
    // keeping the log.
    record(item, {
      kind: 'approval-answered',
      tool: request.tool,
      text: behavior === 'allow'
        ? (remember === true ? `allow (always ${request.tool})` : 'allow')
        : `deny: ${message ?? 'denied from DeepSeek Harness'}`,
    })
    item.pendingApproval = null
    item.state = behavior === 'allow' ? STATE.running : STATE.denied
    item.touch()
    return true
  }

  /** Fold one protocol record into the item's state and transcript. */
  function handleRecord(item, payload) {
    switch (payload.type) {
      case 'system': {
        if (payload.subtype === 'init') {
          item.sessionId = String(payload.session_id ?? '')
          item.model = String(payload.model ?? '')
          record(item, { kind: 'init', text: `${item.model}${item.sessionId ? ` · ${item.sessionId}` : ''}` })
          // The header is what a restart rebuilds from, and the session id is the
          // one field a restart CANNOT recover from the log alone — it is only
          // known once the CLI says so here. Writing it here is what makes
          // `send()` after a restart able to `--resume` this very conversation
          // instead of starting a new one from a text summary.
          persistHeader(item)
          return
        }
        // The API retry loop, which the CLI announces on the SDK stream as
        // `system/api_retry`. It used to be dropped here, so a session whose
        // endpoint had gone away sat at "running" with a blank transcript for as
        // long as the backoff lasted — the retries were only visible in a
        // terminal. Measured shape (tools/probe-retry.mjs, dead endpoint):
        //   {subtype:"api_retry", attempt:1, max_retries:2,
        //    retry_delay_ms:603, error_status:null, error:"unknown"}
        // A hanging endpoint adds `no_response:{waited_ms, retry_wait_ms}`, which is
        // the one case a reader most needs to tell apart from "just slow".
        if (payload.subtype === 'api_retry') {
          const attempt = Number(payload.attempt ?? 0)
          const max = Number(payload.max_retries ?? 0)
          const delay = Number(payload.retry_delay_ms ?? 0)
          const status = payload.error_status === null || payload.error_status === undefined
            ? String(payload.error ?? 'unknown')
            : `HTTP ${String(payload.error_status)}`
          const waited = Number(payload.no_response?.waited_ms ?? 0)
          const cause = waited > 0 ? `no response in ${(waited / 1000).toFixed(1)}s` : status
          record(item, {
            kind: 'retry',
            // Same "attempt n/m" wording the CLI's own TUI uses, so a reader
            // looking at both surfaces sees the same numbers.
            text: `attempt ${String(attempt)}/${String(max)} · retry in ${(delay / 1000).toFixed(1)}s · ${cause}`,
          })
          item.state = STATE.running
          return
        }
        if (payload.subtype === 'permission_denied') {
          item.state = STATE.denied
          // `decision_reason_type` is the discriminator ('classifier', 'rule',
          // 'mode', 'asyncAgent'); the human-readable reason is in `message`.
          const reason = String(payload.message ?? '')
          const tool = String(payload.tool_name ?? '')
          // The identical refusal also arrives as the `tool_result` the model
          // reads. Record whichever lands first and drop the echo: printing both
          // put the same 1 500 characters in the transcript twice, one row apart.
          if (isDenialText(reason)) {
            if (item.denialsSeen.has(reason)) return
            rememberDenial(item, reason)
          }
          record(item, { kind: 'denied', tool, text: denialReason(reason) })
          return
        }
        // Background notices (a missing Git Bash, a partially applied host config,
        // a hook speaking up). `info` and `notice` are pure transcript colour and
        // would only add noise here; `suggestion` and `warning` say something the
        // reader may have to act on.
        if (payload.subtype === 'informational') {
          const level = String(payload.level ?? 'notice')
          if (level === 'warning' || level === 'suggestion') {
            record(item, { kind: 'notice', text: tail(String(payload.content ?? ''), 600) })
          }
          return
        }
        return
      }
      case 'control_request': {
        const request = payload.request ?? {}
        if (request.subtype === 'can_use_tool') {
          const tool = String(request.tool_name ?? '')
          const summary = String(
            request.display_name
            ?? request.input?.file_path
            ?? request.input?.command
            ?? request.input?.path
            ?? '',
          )
          item.pendingApproval = {
            requestId: String(payload.request_id ?? ''),
            tool,
            summary: tail(summary, 120),
            input: request.input,
          }
          if (item.allowRules.has(tool) && tool !== '') {
            // A remembered tool never reaches the user again.
            respondToApproval(item, 'allow', undefined, false)
            return
          }
          item.state = STATE.waitingApproval
          record(item, { kind: 'approval-requested', tool, text: summary })
          return
        }
        if (request.subtype === 'set_permission_mode') {
          item.mode = request.mode === 'manual' ? 'manual' : 'auto'
          record(item, { kind: 'mode', text: item.mode })
          persistHeader(item)
          return
        }
        return
      }
      case 'stream_event': {
        const event = payload.event ?? {}
        // What the model has written so far, before the block is complete. The
        // panel polls every two seconds, so this is the difference between an
        // answer that appears when it is done and one that grows while it is
        // written. The growth is held in `item.streaming` and never appended to
        // the log: the finished block arrives as an `assistant` record and takes
        // the row over, so the log keeps one row per answer.
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (item.streaming === null) item.streaming = { at: Date.now(), text: '' }
          item.streaming.text += String(event.delta.text ?? '')
          item.touch()
          return
        }
        // End of a block. The finished text is already on its way as an
        // `assistant` record; dropping the live copy here keeps the two from
        // being on screen at once.
        if (event.type === 'content_block_stop') {
          item.streaming = null
          item.touch()
        }
        return
      }
      case 'assistant': {
        // The CLI synthesises an `assistant` record to carry a terminal API error
        // (`model:"<synthetic>"`, `is_api_error_message:true`). Recording it like a
        // real reply put "API Error: Connection refused…" in the transcript as if
        // Claude had said it. Measured with tools/probe-retry.mjs.
        if (payload.is_api_error_message === true) {
          const block = (payload.message?.content ?? []).find((part) => part.type === 'text')
          record(item, { kind: 'api-error', text: tail(String(block?.text ?? payload.error ?? 'API error'), 600) })
          return
        }
        for (const block of payload.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            // The finished block supersedes whatever the deltas accumulated.
            item.streaming = null
            record(item, { kind: 'assistant', text: block.text })
          }
          else if (block.type === 'thinking' && block.thinking) record(item, { kind: 'thinking', text: block.thinking })
          else if (block.type === 'tool_use') {
            const detail = block.input?.file_path ?? block.input?.command ?? block.input?.path ?? ''
            record(item, { kind: 'tool-use', tool: String(block.name ?? ''), text: tail(detail, 400) })
          }
        }
        return
      }
      case 'user': {
        for (const block of payload.message?.content ?? []) {
          if (block.type !== 'tool_result') continue
          const body = Array.isArray(block.content)
            ? block.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
            : String(block.content ?? '')
          // A refusal the CLI already announced as `system/permission_denied`
          // arrives a second time as the `tool_result` the model reads — the same
          // 1 500 characters, one row apart. Recording both printed every refusal
          // twice. Keep the first (it is the one that names the tool) and skip the
          // echo; report it as a result so the original keeps its own row.
          if (block.is_error === true && isDenialText(body)) {
            if (item.denialsSeen.has(body)) {
              item.denialsSeen.delete(body)
              continue
            }
            rememberDenial(item, body)
          }
          record(item, {
            kind: block.is_error === true ? 'tool-error' : 'tool-result',
            text: tail(body, 4000),
          })
        }
        return
      }
      case 'result': {
        item.lastResult = tail(String(payload.result ?? ''), 4000)
        item.costUsd = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : item.costUsd
        item.durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : item.durationMs
        // A result ends the turn, so any approval parked during it is gone by
        // definition. Interrupting a turn that was waiting for approval produces
        // exactly this order — approval-requested, tool-error, result — and the
        // stale request used to survive: the panel kept offering Allow/Deny for a
        // tool Claude Code had already given up on, and pressing Allow sent a
        // control_response for a request_id nobody was listening for.
        item.pendingApproval = null
        // A result ends the turn, so anything still being written is finished —
        // or the turn died before its block closed.
        item.streaming = null
        // `terminal_reason` says WHY the turn ended, and `api_error` is the one
        // case the reader can act on without touching this session: the endpoint
        // was unreachable and the retry loop gave up. Reporting it as `denied`
        // (which is what `is_error` alone produced) told the reader a permission
        // had been refused when nothing of the sort happened.
        const terminal = String(payload.terminal_reason ?? '')
        if (terminal === 'api_error') item.state = STATE.error
        else if (payload.is_error === true) item.state = STATE.denied
        else item.state = STATE.idle
        // The per-turn numbers the panel prints under the answer. Read them from
        // the CLI's own result record rather than counting rows here: the CLI
        // reports cache reads/writes and reasoning tokens that a local count
        // cannot know about, and `usage` is cumulative for the whole process
        // while the answer is per turn — so the per-turn figure is the delta.
        // The turn is over: the timer stops and the duration it measured is the
        // one `result` carries. `done` clears it as well, for a turn that died
        // without a result.
        item.turnStartedAt = 0
        // The CLI reports `usage` CUMULATIVELY per process, and a session can be
        // large enough that the running total wraps the counter. Measured on a
        // real 5-minute turn in this very session: input 1,540,275 and cache-read
        // 33,422,336 for ONE turn. A total that keeps growing past the point where
        // the numbers stop being believable is worse than no total at all — the
        // reader cannot tell a huge session from a broken counter. So the rail
        // reports the LAST completed turn's figures, which is the same number the
        // answer's usage line prints, and the label says "last turn".
        const usage = turnUsage(item, payload)
        // A turn that ended on an API error did not produce an answer, so its
        // closing record must not be painted like one. `result` is the row the
        // panel renders as the violet answer block; an error belongs in the
        // failure colour instead.
        record(item, {
          kind: terminal === 'api_error' ? 'api-error' : 'result',
          text: item.lastResult,
          ...usage,
        })
        return
      }
      default:
        return
    }
  }

  // ------------------------------------------------------------------- actions

  /**
   * Spawn the resident process behind one work item and wire its streams.
   *
   * Extracted from `start()` because a finished item has to be able to open a
   * NEW process in the same directory: the old `send()` threw
   * "work item … is not running", which left a dead item with a transcript and
   * no way to continue it.
   */
  async function openProcess(item) {
    const executable = await ctx.subprocess.resolveExecutable('claude')
    const argv = [
      executable,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', item.mode,
      '--permission-prompt-tool', 'stdio',
      // Answers arrive as token deltas instead of in one lump at the end, which
      // is what `handleRecord` turns into the live row. Without it a long answer
      // shows nothing at all until it is finished — measured with
      // `tools/probe-stream.mjs`: 17 `text_delta` records for one 30-line reply.
      '--include-partial-messages',
    ]
    // `--add-dir` puts the project root in the permission scope explicitly, so
    // `Read(//<path>/**)` rules resolve even when the session was resumed from a
    // transcript whose working directory differs. It is harmless when the cwd is
    // already in scope.
    //
    // Deliberately NOT done: telling the model to drop its `cd` prefix. Measured
    // over 670 Bash calls in four sessions, 88% start with `cd` and only 1% of
    // those `cd` targets are the session cwd — most commands reach into a second
    // checkout (`.../claude-dsh-bridge` while the session runs in another project).
    // The `cd` is load-bearing, not redundant.
    if (item.cwd !== '') argv.push('--add-dir', item.cwd)
    // Continue the CLI's own conversation when there is one.
    //
    // The CLI writes its transcript to `~/.claude/projects/<slug>/<sessionId>.jsonl`
    // even in `-p` mode (measured on 2.1.310 by `tools/probe-resume.mjs`: the file
    // appears, and `--resume <id>` answers from it in a fresh process — also after
    // the first process was SIGKILLed). An earlier design note recorded the opposite for an
    // earlier build and the plugin was designed around replaying its own log as a
    // text primer; `--resume` is strictly better because the model gets the real
    // conversation (tool calls, results, reasoning) instead of the last 4 KB of
    // chat. The primer stays as the fallback for when the transcript is gone.
    // `--resume` of an id the CLI cannot find exits with "No conversation found
    // with session ID" as a result record, so this is only used when the file is
    // actually there.
    if (item.sessionId !== '' && transcriptExists(item.sessionId)) {
      argv.push('--resume', item.sessionId)
    }
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: item.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5_000,
    })
    item.handle = handle
    item.state = STATE.idle
    item.exitCode = undefined
    item.streaming = null
    // A new process starts its own token counters at zero, so the cumulative
    // baseline has to start at zero too. Carrying the dead process's totals over
    // would make the first answer of the reopened session report a delta of 0 (or
    // a negative one clamped to 0) and its usage line would be empty.
    item.usageTotals = { output: 0, input: 0, cacheRead: 0 }
    // Same reasoning as the cache-write baseline: the new process counts from
    // zero, but `item.tokens` is a transcript-wide total and stays.
    item.cacheWriteTotals = 0
    const reader = createLineReader((line) => {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      handleRecord(item, parsed)
    })
    item.reader = reader

    handle.stdout.setEncoding?.('utf8')
    handle.stdout.on('data', (chunk) => reader.push(String(chunk)))
    handle.stderr.setEncoding?.('utf8')
    handle.stderr.on('data', (chunk) => {
      const text = String(chunk)
      if (text.includes('unrecognized_model')) return
      record(item, { kind: 'stderr', text: tail(text, 500) })
    })

    handle.done.then((outcome) => {
      reader.flush()
      item.handle = null
      item.pendingApproval = null
      item.streaming = null
      item.turnStartedAt = 0
      // A turn that ended on an unreachable API makes the CLI exit, so the state
      // it just set would be overwritten by `done` here and the panel would lose
      // the only thing the reader needs from that failure. `done` means "the work
      // finished"; this one did not.
      if (item.state !== STATE.error) item.state = STATE.done
      item.exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : undefined
      record(item, { kind: 'exit', code: item.exitCode ?? 0 })
    }, (failure) => {
      reader.flush()
      item.handle = null
      item.pendingApproval = null
      item.streaming = null
      item.turnStartedAt = 0
      if (item.state !== STATE.error) item.state = STATE.done
      record(item, { kind: 'stderr', text: tail(failure instanceof Error ? failure.message : String(failure), 500) })
    })
  }

  /** Open one resident process and register it as a work item. */
  async function start(request) {
    const cwd = trimDir(request?.cwd)
    if (cwd === '') throw new Error('cwd is required to open a work item')
    const id = String(request?.id ?? `cc-${Date.now().toString(36)}-${++sequence}`)
    const existing = items.get(id)
    if (existing !== undefined) return { item: view(existing) }

    const item = new WorkItem({
      id,
      title: String(request?.title ?? '') || cwd.split(/[\\/]/).pop() || id,
      cwd,
      mode: request?.mode,
    })
    items.set(id, item)
    persistHeader(item)

    await openProcess(item)
    record(item, { kind: 'opened', text: cwd })
    item.touch()

    return { item: view(item) }
  }

  /**
   * The newest `count` rows, extended back to the question they belong to.
   *
   * A plain `slice(-count)` cuts wherever the count lands, and a long turn is
   * thousands of process rows: the window then starts in the MIDDLE of a turn —
   * a tool result, a tool call — with no `user` row anywhere in it. The panel
   * groups by question, so with no question in the window that first orphan row
   * became a turn of its own and its heading read `up after 4s`, which looked
   * like the user had asked it.
   *
   * So the window is widened back to the last question, and when even that is a
   * long way off it is capped — a single tool call cannot be allowed to drag the
   * whole transcript into one poll.
   * @param transcript - every row held in memory, oldest first.
   * @param count - how many rows the caller asked for.
   * @returns the rows to return.
   */
  function windowOf(transcript, count) {
    const start = Math.max(0, transcript.length - count)
    let first = start
    // Look back for the question this window begins inside.
    while (first > 0 && transcript[first].kind !== 'user') first -= 1
    const HEADROOM = 400
    if (start - first > HEADROOM) return transcript.slice(start)
    return transcript.slice(first)
  }

  /**
   * The context line a reopened session needs when the CLI cannot resume it.
   *
   * This is the FALLBACK path. When the CLI still has its own transcript,
   * `openProcess` passes `--resume` and the model gets the real conversation;
   * this primer only runs when that transcript is gone (a different machine, a
   * cleaned `~/.claude`, a build that does not persist). The next best thing is
   * to hand the new process the tail of the previous conversation in its first
   * user message, and say plainly that it is a new process — otherwise the model
   * believes it did work the previous one did.
   */
  function contextPrimer(item) {
    const picked = []
    let budget = 4000
    for (let index = item.transcript.length - 1; index >= 0 && budget > 0; index -= 1) {
      const row = item.transcript[index]
      if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'result') continue
      const text = String(row.text ?? '').trim()
      if (text === '') continue
      const slice = text.slice(0, 600)
      picked.unshift(`${row.kind === 'user' ? '我' : '你'}：${slice}`)
      budget -= slice.length
    }
    return picked.join('\n')
  }
  /** One work item plus the newest transcript rows. */
  function read(id, limit) {
    const item = itemOrThrow(id)
    const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 40
    const rows = windowOf(item.transcript, count)
    // The answer being written right now is not in the log yet, so it is appended
    // as a row of its own. The kind is one the log never contains; the panel
    // renders it as Claude talking and drops the fold/toggle on it, because a
    // growing row that offers "Show all · N" while it grows is nonsense.
    if (item.streaming !== null && item.streaming.text !== '') {
      rows.push({ at: item.streaming.at, kind: STREAMING_KIND, text: item.streaming.text })
    }
    return { item: view(item), rows: rows.map(rowView) }
  }

  /**
   * Write one user turn, reopening the session first if it has ended.
   *
   * The old version threw "work item … is not running" and left the panel's
   * composer looking usable against a dead item. A work item that has ended is
   * not a broken thing to type into: reopening in the same directory is what the
   * user asked for, and the previous conversation is replayed as context so the
   * new process is not starting from nothing.
   */
  /**
   * One user turn, with the images that were pasted along with it.
   *
   * The CLI accepts an image as a content block of the user message
   * (`{type:'image', source:{type:'base64', media_type, data}}`), measured with
   * `tools/probe-image.mjs`: a resident `-p` session answers questions about the
   * picture. Text and images travel in ONE message so the model sees them as one
   * utterance, and an image alone is a legal turn — refusing it because the text
   * box was empty is a rule the CLI does not have.
   * @param id - work item id.
   * @param text - the user's text; may be empty when `attachments` is given.
   * @param attachments - `[{ mediaType, data, name? }]` in base64.
   */
  async function send(id, text, attachments) {
    const item = itemOrThrow(id)
    const body = String(text ?? '')
    const images = []
    for (const entry of Array.isArray(attachments) ? attachments : []) {
      if (entry === null || typeof entry !== 'object') continue
      const mediaType = String(entry.mediaType ?? '')
      const data = String(entry.data ?? '')
      // A malformed image would make the CLI reject the whole turn, so a bad
      // attachment is dropped rather than allowed to break the message.
      if (!mediaType.startsWith('image/') || data === '') continue
      images.push({ mediaType, data, name: String(entry.name ?? '') })
    }
    if (body.trim() === '' && images.length === 0) {
      throw new Error('text or at least one image is required to send a turn')
    }
    let reopened = false
    let primer = ''
    let resumed = false
    if (item.handle === null) {
      // Only prime when the CLI cannot resume: a resumed process already has the
      // conversation, and repeating its tail in the next message would make the
      // model read the same exchange twice and believe it said things twice.
      resumed = item.sessionId !== '' && transcriptExists(item.sessionId)
      if (!resumed) primer = contextPrimer(item)
      await openProcess(item)
      reopened = true
      // Say it in the transcript, not only in the reply: the panel keeps the old
      // rows, and a reader who scrolls up must be able to see where the old
      // process ended and where this one began. The row carries a count, not the
      // primer itself — the primer is already in the message that was just sent,
      // and repeating 4 KB of it would fill the transcript with itself.
      record(item, {
        kind: 'reopened',
        text: resumed
          ? `resumed session ${item.sessionId.slice(0, 8)}`
          : (primer === '' ? 'no prior context' : `${primer.split('\n').length} prior line(s) as context`),
        // Which of the two handovers this was. The panel says something different
        // for each — a resumed session IS the old conversation, a primed one only
        // carries a summary of it — and parsing the sentence above to find out
        // would break the moment the wording changed.
        resumed,
      })
    }
    // On a resume the CLI already owns the conversation, so the message carries
    // only the new turn — no primer. The `session_id` echo is harmless there
    // (measured: a resumed process accepts it and keeps answering, and reports the
    // same id at `init`), and a fresh process ignores it.
    sendLine(item, {
      type: 'user',
      message: {
        role: 'user',
        // Images first, then the text: that is the order the CLI's own TUI sends,
        // and a model reads a question after the thing it is about.
        content: [
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
          ...(body.trim() === '' && images.length > 0
            ? []
            : [{
              type: 'text',
              text: reopened && primer !== ''
                ? `（这是一次新的会话进程，之前的会话已经中断。以下是上一次对话的最近内容，供你了解上下文：\n\n${primer}\n\n）\n\n${body}`
                : body,
            }]),
        ],
      },
      parent_tool_use_id: null,
      session_id: item.sessionId || undefined,
    })
    item.state = item.pendingApproval === null ? STATE.running : STATE.waitingApproval
    item.turns += 1
    // The rail's live timer counts from here until the turn's `result` lands.
    item.turnStartedAt = Date.now()
    // The transcript says an image came with the turn. The image itself is not
    // written to the event log: a 3 MB base64 blob per paste would make the log
    // unreadable and is not what a replay needs — it needs to know the turn had
    // one, and how many.
    record(item, {
      kind: 'user',
      text: body === '' && images.length > 0
        ? `[${String(images.length)} image(s)]`
        : body,
      ...(images.length > 0 ? { images: images.length } : {}),
    })
    return { item: view(item) }
  }

  /** Answer a pending approval with allow. */
  function approve(id, remember) {
    const item = itemOrThrow(id)
    if (!respondToApproval(item, 'allow', undefined, remember === true)) {
      throw new Error(`work item ${item.id} has no pending approval`)
    }
    return { item: view(item) }
  }

  /** Answer a pending approval with deny. */
  function deny(id, message) {
    const item = itemOrThrow(id)
    if (!respondToApproval(item, 'deny', message, false)) {
      throw new Error(`work item ${item.id} has no pending approval`)
    }
    return { item: view(item) }
  }

  /**
   * Answer a pending AskUserQuestion request with the choices the user made.
   *
   * This is NOT the same as approving it. The CLI's AskUserQuestion tool reads its
   * answers out of the tool input it is handed back (`call({ answers })`), so an
   * `{behavior:'allow'}` reply with the original input runs the tool with no
   * answers at all and the model is told "The user did not answer the questions."
   * That is exactly the bug this method exists to fix: `updatedInput` has to carry
   * an `answers` map keyed by the question text.
   *
   * The value is always a STRING: the tool's own schema declares `answers` as
   * `Record<string, string>` and the CLI's interactive path sends exactly that,
   * joining a multi-select with ", ". An array there is read as absent.
   * @param id - work item id.
   * @param answers - `[{ question, picked: [value, …] }, …]`, in the order asked.
   *   A choice question's `picked` holds labels; a text/number question's holds
   *   the single typed value, so both go through the same method.
   */
  function answer(id, answers) {
    const item = itemOrThrow(id)
    const request = item.pendingApproval
    if (request === null) throw new Error(`work item ${item.id} has no pending approval`)
    const questions = questionsOf(request)
    if (questions.length === 0) {
      throw new Error(`work item ${item.id} is not waiting on a question`)
    }
    const chosen = new Map()
    for (const entry of Array.isArray(answers) ? answers : []) {
      const question = String(entry?.question ?? '')
      if (question === '') continue
      const picked = (Array.isArray(entry?.picked) ? entry.picked : [])
        .map((label) => String(label))
        .filter((label) => label !== '')
      if (picked.length > 0) chosen.set(question, picked)
    }
    for (const question of questions) {
      if (!chosen.has(question.question)) {
        throw new Error(`every question needs an answer; "${question.question}" has none`)
      }
    }
    // Shape the map the tool reads. The tool's own result schema declares
    // `answers` as string -> STRING ("multi-select answers are comma-separated"),
    // and the CLI's interactive path sends exactly `{[question]: label}`. So every
    // value is a string here, and a multi-select joins with ", " — sending an
    // array instead makes the CLI treat the answer as absent.
    const map = {}
    for (const question of questions) {
      const picked = chosen.get(question.question)
      map[question.question] = picked.join(', ')
    }
    sendLine(item, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.requestId,
        response: {
          behavior: 'allow',
          updatedInput: { ...(request.input ?? {}), answers: map },
        },
      },
    })
    const summary = questions
      .map((question) => {
        const picked = chosen.get(question.question)
        return `${question.header ? `${question.header}: ` : ''}${picked.join(' / ')}`
      })
      .join(' · ')
    record(item, { kind: 'approval-answered', tool: request.tool, text: `answer: ${summary}` })
    item.pendingApproval = null
    item.state = STATE.running
    item.touch()
    return { item: view(item) }
  }

  /**
   * Rename a work item.
   *
   * The title defaults to the directory's last segment, which is ambiguous the
   * moment two checkouts share a name, and says nothing about what the session is
   * for. Renaming is Host state, not CLI state: the header is what a reload
   * rebuilds from, so the new title has to be written there too.
   * @param id - work item id.
   * @param title - the new display title; blank is refused rather than stored.
   */
  function rename(id, title) {
    const item = itemOrThrow(id)
    const next = String(title ?? '').trim()
    if (next === '') throw new Error('title is required to rename a work item')
    item.title = next
    persistHeader(item)
    item.touch()
    return { item: view(item) }
  }

  /** Switch the permission mode mid-session. */
  function setMode(id, mode) {
    const item = itemOrThrow(id)
    const target = mode === 'manual' ? 'manual' : 'auto'
    if (item.handle === null) throw new Error(`work item ${item.id} is not running`)
    sendLine(item, {
      type: 'control_request',
      request_id: `mode-${++sequence}`,
      request: { subtype: 'set_permission_mode', mode: target },
    })
    item.mode = target
    // The mode used to live only in memory: the header was written once by
    // `start()` and never again, so a reload rebuilt the item as whatever it
    // was opened with and the switch silently evaporated. Record it (P1 replay
    // has to show that it happened) and rewrite the header (the reload path
    // reads it back).
    record(item, { kind: 'mode', text: target })
    persistHeader(item)
    item.touch()
    return { item: view(item) }
  }

  /** Interrupt the turn in flight. */
  function interrupt(id) {
    const item = itemOrThrow(id)
    if (item.handle === null) throw new Error(`work item ${item.id} is not running`)
    sendLine(item, {
      type: 'control_request',
      request_id: `int-${++sequence}`,
      request: { subtype: 'interrupt' },
    })
    // The interrupted turn will never close its block, so the half-written answer
    // is dropped instead of sitting on screen as if it were still arriving.
    item.streaming = null
    item.turnStartedAt = 0
    record(item, { kind: 'interrupt', text: '' })
    return { item: view(item) }
  }

  /** Terminate the resident process, keeping the transcript. */
  async function stop(id) {
    const item = itemOrThrow(id)
    if (item.handle !== null) {
      try {
        await item.handle.terminate()
      } catch {
        // A process that already exited needs no termination.
      }
      item.handle = null
    }
    item.pendingApproval = null
    item.streaming = null
    item.turnStartedAt = 0
    item.state = STATE.done
    record(item, { kind: 'stopped', text: '' })
    return { item: view(item) }
  }

  /** Forget a stopped work item and delete its event log. */
  function remove(id) {
    const item = itemOrThrow(id)
    if (item.handle !== null) throw new Error(`work item ${item.id} is still running; stop it first`)
    items.delete(item.id)
    try {
      rmSync(join(root, `${item.id}.jsonl`), { force: true })
      rmSync(join(root, `${item.id}.meta.json`), { force: true })
    } catch {
      // Removing the log is best effort.
    }
    return { ok: true }
  }

  /** Every work item, oldest first. */
  function list() {
    return { items: [...items.values()].map(view) }
  }

  // -------------------------------------------------------------- persistence

  /** Rebuild the list from the event logs written by earlier runs. */
  function loadHistory() {
    let names
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue
      let meta
      try {
        meta = JSON.parse(readFileSync(join(root, name), 'utf8'))
      } catch {
        continue
      }
      const id = String(meta.id ?? '')
      if (id === '' || items.has(id)) continue
      const item = new WorkItem({
        id,
        title: String(meta.title ?? id),
        cwd: trimDir(meta.cwd),
        mode: meta.mode,
      })
      item.sessionId = String(meta.sessionId ?? '')
      item.startedAt = typeof meta.startedAt === 'number' ? meta.startedAt : Date.now()
      item.lastActivityAt = item.startedAt
      for (const rule of Array.isArray(meta.allowRules) ? meta.allowRules : []) item.allowRules.add(String(rule))
      let log
      try {
        log = readFileSync(join(root, `${id}.jsonl`), 'utf8')
      } catch {
        log = ''
      }
      for (const line of log.split('\n')) {
        if (line.trim() === '') continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row.kind === 'result') {
          item.lastResult = String(row.text ?? '')
          // The rail's figures are the last turn's, so the reload keeps the LAST
          // result row's numbers rather than summing every one of them.
          const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
          item.tokens = {
            output: count(row.outputTokens),
            input: count(row.inputTokens),
            cacheRead: count(row.cacheReadTokens),
            cacheWrite: count(row.cacheWriteTokens),
          }
          if (count(row.contextTokens) > 0) item.contextTokens = count(row.contextTokens)
        }
        if (typeof row.seq === 'number' && row.seq > item.rowSeq) item.rowSeq = row.seq
        if (countsAsStep(row.kind)) item.steps += 1
        if (row.kind === 'user') item.turns += 1
        // The log is the authority on the current mode: a switch is appended
        // when it happens, so the last `mode` row wins over the header that
        // `start()` wrote.
        if (row.kind === 'mode') item.mode = row.text === 'manual' ? 'manual' : 'auto'
        // Same for the session id, and for a stronger reason: older headers were
        // written before the id was known (`start()` writes the header, the CLI
        // reports the id later, and `persistHeader` did not run on `init`), so a
        // header can say `""` while the `init` row on disk carries the real id.
        // Without this the item could not be resumed after a restart.
        if (row.kind === 'init') {
          const reported = String(row.text ?? '').split(' · ').pop() ?? ''
          if (reported !== '') item.sessionId = reported
        }
        if (row.kind === 'policy') {
          const tool = String(row.text ?? '').replace(/^allow\s+/, '')
          if (tool !== '') item.allowRules.add(tool)
        }
        item.transcript.push(row)
      }
      item.state = STATE.done
      items.set(id, item)
    }
  }

  // ------------------------------------------------------------------ wiring

  try {
    mkdirSync(root, { recursive: true })
    ready = true
  } catch {
    ready = false
  }
  loadHistory()

  const service = {
    list,
    read,
    start,
    send,
    approve,
    deny,
    answer,
    rename,
    setMode,
    interrupt,
    stop,
    // Named `forget`, not `remove`: the Client gateway refuses a Remote method
    // whose name collides with its own namespace service, and `remove` is one of
    // them. `tools/api-spec.mjs` records the exact set.
    forget: remove,
  }
  // The Gateway resolves a strict descriptor to a Service and then validates the
  // service's own `typertRemote` binding before dispatching. `bindTypertRemote`
  // from @deepseek-ai/dsh-typert-protocol would build this, but that specifier
  // does not resolve from this package; the binding is the whole contract, so it
  // is spelled out here instead of imported.
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: SERVICE, namespace: SERVICE }),
    enumerable: false,
    configurable: false,
    writable: false,
  })
  ctx.provide(SERVICE, service)

  // ---------------------------------------------------------------- agent tool
  //
  // One tool, one `action` switch, calling the same service methods the panel
  // calls. `approve` and `deny` are absent on purpose: granting authority stays
  // with the human in front of the panel.
  ctx.effect(() => ctx.tools.register({
    name: 'claude_session',
    description:
      'Manage Claude Code work items this plugin opened inside DeepSeek Harness '
      + '(it never sees sessions you start in your own shell). '
      + 'start opens a resident `claude -p` process in a directory, list shows every item and its state, '
      + 'read returns the newest transcript rows, send writes one user turn, rename changes the display title, '
      + 'setMode switches auto/manual, interrupt stops the turn in flight, stop ends the process, '
      + 'remove forgets a stopped item. '
      + 'Sending to a finished item reopens the CLI conversation with `--resume` when its transcript still exists, '
      + 'and otherwise opens a NEW process in the same directory with the previous turns as context. '
      + 'Answering a tool approval or a question is user-only and unavailable here.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'read', 'send', 'rename', 'setMode', 'interrupt', 'stop', 'remove'],
          description: 'Operation to perform.',
        },
        id: { type: 'string', description: 'Work item id (every action except list).' },
        title: { type: 'string', description: 'Display title for start.' },
        cwd: { type: 'string', description: 'Absolute directory for start.' },
        mode: { type: 'string', enum: ['auto', 'manual'], description: 'Permission mode for start, or the target of setMode.' },
        newTitle: { type: 'string', description: 'New display title for rename.' },
        text: { type: 'string', description: 'User turn text for send.' },
        limit: { type: 'number', description: 'Rows to return for read; defaults to 40.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                mode: { type: 'string' },
                state: { type: 'string' },
                turns: { type: 'number' },
                pendingApproval: { type: 'string' },
              },
              required: ['id', 'state'],
              additionalProperties: false,
            },
          },
          item: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              cwd: { type: 'string' },
              mode: { type: 'string' },
              state: { type: 'string' },
              turns: { type: 'number' },
              pendingApproval: { type: 'string' },
            },
            required: ['id', 'state'],
            additionalProperties: false,
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                at: { type: 'number' },
                kind: { type: 'string' },
                text: { type: 'string' },
                tool: { type: 'string' },
                code: { type: 'number' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      if (USER_ONLY.has(action)) {
        return { ok: false, error: `${action} grants or refuses authority and is available only in the panel` }
      }
      try {
        switch (action) {
          case 'start': {
            const item = (await start({ id: args?.id, title: args?.title, cwd: args?.cwd, mode: args?.mode })).item
            return { ok: true, item: toolItem(items.get(item.id)) }
          }
          case 'list':
            return { ok: true, items: [...items.values()].map(toolItem) }
          case 'read': {
            const result = read(args?.id, args?.limit)
            return { ok: true, item: toolItem(items.get(result.item.id)), rows: result.rows }
          }
          case 'send':
            return { ok: true, item: toolItem(items.get((await send(args?.id, args?.text)).item.id)) }
          case 'rename':
            return { ok: true, item: toolItem(items.get(rename(args?.id, args?.newTitle).item.id)) }
          case 'setMode':
            return { ok: true, item: toolItem(items.get(setMode(args?.id, args?.mode).item.id)) }
          case 'interrupt':
            return { ok: true, item: toolItem(items.get(interrupt(args?.id).item.id)) }
          case 'stop': {
            const item = (await stop(args?.id)).item
            return { ok: true, item: toolItem(items.get(item.id)) }
          }
          case 'remove':
            return { ok: true, ...remove(args?.id) }
          default:
            return { ok: false, error: `unknown action: ${action}` }
        }
      } catch (failure) {
        return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
      }
    },
  }), 'claude-sessions: work item tool')

  // Never leave a resident process behind when the plugin unloads.
  ctx.effect(() => async () => {
    await Promise.allSettled([...items.values()].filter((item) => item.live).map((item) => stop(item.id)))
  }, 'claude-sessions: stop resident processes')
}
