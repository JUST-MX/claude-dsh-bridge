// Single source of truth for the claudeSessions Remote surface.
//
// `tools/gen-typert.mjs` reads this file and emits three artifacts:
//
//   plugin/packages/claude-sessions/typert.js   Host face   -> export const TYPERT
//   plugin/packages/claude-sessions/remote.js   Client face -> export const TYPERT_REMOTE
//   plugin/packages/claude-sessions/client.js   Browser bundle (carries its own copy)
//
// Both wire faces need *strict* codecs: the Client gateway refuses to mount a
// descriptor whose parameter codec is not `mode: 'strict'`, and the Host
// registry refuses one without a `typeSymbol` and a `create()` factory. The
// generated artifacts therefore carry a self-contained codec builder instead of
// importing `zod` or `@deepseek-ai/dsh-typert-protocol/remote-info`: neither
// resolves from this workspace (no node_modules, no reachable registry). The
// emitted descriptor shapes are the ones the official generator produces.

/** Package name; it is also the Client module id and TYPERT.package. */
export const PACKAGE = '@local/dsh-plugin-claude-sessions'

/** Cordis service key, Remote namespace, and Client inject key suffix. */
export const SERVICE = 'claudeSessions'

// ------------------------------------------------------------------- shapes

/** One replayable transcript row. */
const ROW = {
  type: 'object',
  properties: {
    at: { type: 'number' },
    // A stable identity, assigned by `record()`. The panel keys folded turns by
    // it; position in the returned window is not stable once that window slides.
    seq: { type: 'number' },
    kind: { type: 'string' },
    text: { type: 'string' },
    tool: { type: 'string' },
    // How many images a `user` row carried. The blobs stay out of the log.
    images: { type: 'number' },
    // On a `reopened` row: true when the CLI resumed its own transcript, false
    // when the earlier turns were replayed as a text primer. The panel words its
    // banner differently for each, so it must not have to parse the sentence.
    resumed: { type: 'boolean' },
    code: { type: 'number' },
    // Per-turn usage, present only on a `result` row. `tokens` are per turn (the
    // CLI reports process-wide totals), and `tps` follows the DSH chat UI's own
    // tok/s rule so the two surfaces read the same.
    durationMs: { type: 'number' },
    inputTokens: { type: 'number' },
    outputTokens: { type: 'number' },
    cacheReadTokens: { type: 'number' },
    cacheWriteTokens: { type: 'number' },
    // The prompt size at the end of the turn, so the rail's context gauge
    // survives a reload without re-deriving it from cumulative counters.
    contextTokens: { type: 'number' },
    tps: { type: 'number' },
  },
  required: ['kind'],
}

/**
 * One question a pending AskUserQuestion request is waiting on.
 *
 * `pendingApproval` alone is a display string, and answering a question needs
 * more than that: Claude Code reads its answers out of the tool input it is
 * given back, so the panel has to render the real choices and send the chosen
 * labels. Asking to "allow" without an answer is exactly what produced "The user
 * did not answer the questions."
 */
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    header: { type: 'string' },
    // "choice" is the default and is therefore omitted; "text" and "number" are
    // the tool's two other shapes, and they carry no options.
    kind: { type: 'string' },
    multiSelect: { type: 'boolean' },
    placeholder: { type: 'string' },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number' },
    defaultValue: { type: 'number' },
    unit: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['label'],
      },
    },
  },
  required: ['question'],
}

/** One image the panel pasted into a message. */
const ATTACHMENT = {
  type: 'object',
  properties: {
    // The media type goes on the wire because the CLI's image block requires it,
    // and the panel is the only side that saw the original File.
    mediaType: { type: 'string' },
    // Base64, no data-URL prefix. `btoa` output is what a browser has cheaply, and
    // stripping the prefix on the Host would mean parsing a second format.
    data: { type: 'string' },
    // The file's own name, for the transcript and for the log.
    name: { type: 'string' },
  },
  required: ['mediaType', 'data'],
}

/** One question's chosen labels, as the panel sends them back. */
const ANSWERS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      picked: { type: 'array', items: { type: 'string' } },
    },
    required: ['question'],
  },
}

/** One work item. `pendingApproval` is a display string, not the raw request. */
const ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    cwd: { type: 'string' },
    mode: { type: 'string' },
    state: { type: 'string' },
    sessionId: { type: 'string' },
    model: { type: 'string' },
    turns: { type: 'number' },
    pendingApproval: { type: 'string' },
    pendingQuestions: { type: 'array', items: QUESTION },
    allowRules: { type: 'string' },
    startedAt: { type: 'number' },
    lastActivityAt: { type: 'number' },
    lastResult: { type: 'string' },
    costUsd: { type: 'number' },
    durationMs: { type: 'number' },
    exitCode: { type: 'number' },
    revision: { type: 'number' },
    // The rail's totals. `steps` is every process row of every turn; the token
    // fields are summed across the whole transcript (not just the live process),
    // and `contextTokens` is the most recent turn's prompt size.
    steps: { type: 'number' },
    outputTokens: { type: 'number' },
    inputTokens: { type: 'number' },
    cacheReadTokens: { type: 'number' },
    cacheWriteTokens: { type: 'number' },
    contextTokens: { type: 'number' },
    contextLimit: { type: 'number' },
    turnStartedAt: { type: 'number' },
  },
  required: ['id', 'title', 'cwd', 'mode', 'state', 'turns', 'startedAt', 'lastActivityAt', 'revision'],
}

const ITEM_ONLY = { type: 'object', properties: { item: ITEM }, required: ['item'] }
const ID = { type: 'string' }
const MODE = { type: 'string' }

// -------------------------------------------------------------------- calls
//
// `optional: true` marks a parameter the Host accepts as absent. The Client
// omits an argument whose value is `undefined`, and the Host rejects an
// unexpected field, so optionality must be declared on both sides.
//
// `userOnly: true` marks an operation that grants or refuses authority. The
// agent tool refuses those: only a human in the panel may answer an approval.

export const API = [
  {
    method: 'list',
    summary: 'Every work item opened inside DeepSeek Harness, in creation order.',
    params: [],
    result: { type: 'object', properties: { items: { type: 'array', items: ITEM } }, required: ['items'] },
  },
  {
    method: 'read',
    summary: 'One work item plus the newest rows of its transcript.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'limit', schema: { type: 'number' }, optional: true, summary: 'Rows to return, newest last; defaults to 40.' },
    ],
    result: {
      type: 'object',
      properties: { item: ITEM, rows: { type: 'array', items: ROW } },
      required: ['item', 'rows'],
    },
  },
  {
    method: 'start',
    summary: 'Open one resident `claude -p` process in a directory and register it as a work item.',
    params: [
      {
        wire: 'request',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            cwd: { type: 'string' },
            mode: MODE,
          },
          required: ['cwd'],
        },
        summary: 'Identity, display title, working directory, and initial permission mode.',
      },
    ],
    result: ITEM_ONLY,
  },
  {
    method: 'send',
    summary: 'Write one user turn to a resident process and wake it, optionally with pasted images.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'text', schema: { type: 'string' }, summary: 'User turn text; may be empty when attachments are given.' },
      {
        wire: 'attachments',
        schema: { type: 'array', items: ATTACHMENT },
        optional: true,
        summary: 'Images pasted into the composer, as base64 with no data-URL prefix.',
      },
    ],
    result: ITEM_ONLY,
  },
  {
    method: 'approve',
    summary: 'Answer a pending tool approval with allow, optionally remembering that tool for this session.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'remember', schema: { type: 'boolean' }, optional: true, summary: 'Also allow this tool without asking again in this work item.' },
    ],
    result: ITEM_ONLY,
    userOnly: true,
  },
  {
    method: 'deny',
    summary: 'Answer a pending tool approval with deny, optionally explaining why.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'message', schema: { type: 'string' }, optional: true, summary: 'Reason shown to Claude.' },
    ],
    result: ITEM_ONLY,
    userOnly: true,
  },
  {
    // A separate method rather than an extra argument on `approve`: an approval
    // and an answered question are different wire payloads, and the panel must
    // only offer this one when the parked request actually carries questions.
    method: 'answer',
    summary: 'Answer a pending AskUserQuestion request with the chosen option labels.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'answers', schema: ANSWERS, summary: 'Chosen labels per question, in the order asked.' },
    ],
    result: ITEM_ONLY,
    userOnly: true,
  },
  {
    method: 'rename',
    summary: 'Change the display title of one work item.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'title', schema: { type: 'string' }, summary: 'New display title.' },
    ],
    result: ITEM_ONLY,
  },
  {
    method: 'setMode',
    summary: 'Switch one work item between auto and manual permission handling mid-session.',
    params: [
      { wire: 'id', schema: ID, summary: 'Work item id.' },
      { wire: 'mode', schema: MODE, summary: 'Target permission mode: auto or manual.' },
    ],
    result: ITEM_ONLY,
  },
  {
    method: 'interrupt',
    summary: 'Interrupt the turn in flight without ending the process.',
    params: [{ wire: 'id', schema: ID, summary: 'Work item id.' }],
    result: ITEM_ONLY,
  },
  {
    method: 'stop',
    summary: 'Terminate the resident process; the transcript stays readable.',
    params: [{ wire: 'id', schema: ID, summary: 'Work item id.' }],
    result: ITEM_ONLY,
  },
  {
    // NOT `remove`: the Client gateway rejects any method name that collides
    // with its own namespace service (`add`, `has`, `install`, `installDirect`,
    // `installScoped`, `remove`, plus the reserved fields `ctx`, `empty`,
    // `invokeRemote`, `methods`, `name`, `namespace`), and a collision makes
    // `ctx.remote.$mount()` throw — after which the whole Client half never
    // registers a single slot.
    method: 'forget',
    summary: 'Forget a stopped work item and delete its event log.',
    params: [{ wire: 'id', schema: ID, summary: 'Work item id.' }],
    result: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
]
