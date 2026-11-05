// Browser half of @local/dsh-plugin-claude-sessions.
//
// `tools/gen-typert.mjs` wraps this body in the module-loader factory and
// prepends the codec core plus this package's own TYPERT_REMOTE descriptors, so
// the bundle is one self-contained script. Edit this file, then regenerate.
//
// Two jobs:
//   1. mount the Host Remote namespace, so `ctx.remote.claudeSessions.*` exists;
//   2. contribute the sidebar entry and the main panel that drives it.

const NS = 'claudeSessions'
const PANEL_ID = 'claude-sessions'
const POLL_MS = 2000

// The namespace service is a Cordis Service named `remote.<namespace>`, and
// Cordis throws on reading a service the plugin did not inject — so `remote`
// alone does not make `ctx.remote.claudeSessions` readable, and the full key
// cannot join the list below because `apply` is what creates that service.
// `apply` therefore mounts first and runs the UI half as a child plugin
// injected with the installed key.
const REMOTE_KEY = 'remote.claudeSessions'

const inject = ['slots', 'locale', 'remote', 'uiWorkspace']

/**
 * One work item's composer when the reader has not touched it yet.
 *
 * A single frozen object rather than a fresh `{ draft: '', … }` per render: the
 * object identity is a dependency of the paste and drop callbacks, and a new one
 * every tick would rebuild them every tick.
 */
const EMPTY_COMPOSER = Object.freeze({ draft: '', attachments: [], attachError: '' })

/**
 * The commands the composer's menu offers, in the order the menu shows them.
 *
 * A fixed list rather than the CLI's own `slash_commands` from `system/init`.
 * The init list is ~50 entries, mixes in every installed skill, and several of
 * those are aliases (`goal`, `teleport`, `__remote-workflow`); a menu built from
 * it would be a second, worse copy of the CLI's own help. These ten are the ones
 * a reader of a transcript panel actually reaches for, each measured against
 * `claude -p --input-format stream-json` in this environment.
 *
 * `arg: true` marks a command that needs something after it: those are filled in
 * with a trailing space so the caret lands where the argument goes, and the rest
 * are filled in bare. `confirms: true` is for the one command that destroys
 * something the panel cannot get back (`/clear` swaps the CLI's session id, so
 * the earlier turns can no longer be resumed): it takes a second click, and the
 * confirmation line names the consequence.
 *
 * Nothing here sends. The menu writes into the textarea and stops, so a
 * mis-click costs one Backspace and never compacts or clears a live
 * conversation.
 */
const COMMANDS = [
  { key: 'cmdCompact', slash: 'compact' },
  { key: 'cmdContext', slash: 'context' },
  { key: 'cmdCost', slash: 'cost' },
  { key: 'cmdModel', slash: 'model' },
  { key: 'cmdEffort', slash: 'effort', arg: true },
  { key: 'cmdRename', slash: 'rename', arg: true },
  { key: 'cmdInit', slash: 'init' },
  { key: 'cmdDoctor', slash: 'doctor' },
  { key: 'cmdMcp', slash: 'mcp' },
  { key: 'cmdClear', slash: 'clear', confirms: true },
]

const DICT = {
  en: {
    panel: 'Claude',
    title: 'Claude Code work items',
    subtitle: 'Resident sessions opened from here. Nothing you start in your own shell appears in this list.',
    newItem: 'New work item',
    empty: 'No work item yet.',
    emptyHint: 'Open one to start a resident Claude Code session in a directory.',
    pickOne: 'Select a work item on the left.',
    pickOneHint: 'Its transcript, its state, and its pending approvals appear here.',
    cwd: 'Directory',
    mode: 'Approvals',
    modeAuto: 'auto',
    modeManual: 'manual',
    switchTo: 'Switch to',
    stateRunning: 'running',
    stateWaiting: 'waiting for approval',
    stateIdle: 'idle',
    stateDenied: 'denied',
    stateError: 'API error',
    stateDone: 'finished',
    turns: 'turns',
    approve: 'Allow',
    approveRemember: 'Always allow this tool',
    deny: 'Deny',
    interrupt: 'Interrupt',
    stop: 'Stop',
    forget: 'Forget',
    send: 'Send',
    placeholder: 'Message this session…',
    pending: 'Wants to run',
    startedAt: 'Started',
    lastActive: 'Last activity',
    sessionId: 'Session',
    cost: 'Cost',
    filter: 'Filter work items',
    noMatch: 'No work item matches the filter.',
    rename: 'Rename',
    save: 'Save',
    cancel: 'Cancel',
    noTranscript: 'No rows yet.',
    expand: 'Show all',
    collapse: 'Collapse',
    errorAction: 'The action failed',
    errorShape: 'Unexpected reply from the Host',
    // Transcript row labels. The Host emits a fixed set of `kind`s; the log shows
    // the raw kind otherwise, which is readable English but not a translated UI.
    kindUser: 'you',
    kindAssistant: 'claude',
    kindThinking: 'thinking',
    // The answer as it is still being written (before the turn ends). The panel
    // shows it in the same voice as a finished reply.
    kindStreaming: 'claude',
    kindToolUse: 'tool',
    kindToolResult: 'result',
    kindToolError: 'error',
    kindInit: 'session',
    kindResult: 'done',
    kindDenied: 'denied',
    kindStderr: 'stderr',
    kindPolicy: 'rule',
    kindOpened: 'open',
    kindStopped: 'stop',
    kindExit: 'exit',
    kindInterrupt: 'interrupt',
    kindMode: 'mode',
    kindApproval: 'approval',
    kindReopened: 'reopen',
    // The CLI's own API-retry loop, and the background notices it considers
    // actionable. Both used to be dropped by the Host, which is why a session
    // whose endpoint had gone away looked frozen rather than retrying.
    kindRetry: 'retry',
    kindNotice: 'notice',
    kindApiError: 'API error',
    // A finished turn folds to one line; these label the two halves of it.
    turnSteps: 'steps',
    turnRunning: 'running',
    turnDenied: 'refused',
    turnFailed: 'errors',
    // The per-turn usage line under an answer, worded like the chat surface's
    // own "本轮用量" panel: duration, then the token split, then tok/s.
    usageDuration: 'took',
    usageOutput: 'out',
    usageInput: 'in',
    usageCache: 'cached',
    usageCacheWrite: 'written',
    // Two different handovers, two different sentences. A resumed session IS the
    // conversation above; a primed one only carries a text summary of it, and
    // saying "resumed" there would be a lie the reader would act on.
    resumeNotice: 'This conversation was resumed: the turns above belong to the same session, and this process remembers them.',
    reopenNotice: 'The previous session had ended. This is a NEW process in the same directory: the earlier question and answer were passed to Claude as a text summary, so the transcript above is history this process does not remember.',
    doneNotice: 'This session has ended. Sending a message starts it again: it resumes the CLI conversation when the transcript still exists, and otherwise passes the previous turns as context.',
    errorNotice: 'The API could not be reached, so this turn ended and the process exited. Check the endpoint or the network first; sending a message then starts it again, resuming the CLI conversation when it still exists.',
    askTitle: 'Claude needs an answer',
    askPickOne: 'pick one',
    askPickMany: 'pick one or more',
    askFreeText: 'type an answer',
    askNumber: 'enter a number',
    askSend: 'Send answer',
    allowedTools: 'Always allowed in this session',
    // Pasted images in the composer.
    attachHint: 'Paste or drop an image here',
    attachRemove: 'Remove this image',
    attachTooLarge: 'That image is too large (max 5 MB)',
    attachTooMany: 'At most 6 images per message',
    attachUnsupported: 'Only image files can be pasted',
    imagesOnly: 'image',
    // The live numbers on each work item in the rail.
    context: 'ctx',
    lastTurnTokens: 'Tokens used by the last turn',
    turnElapsed: 'This turn has been running for',
    turnTook: 'Duration of the last turn',
    // The composer's slash-command menu. One label per command, because the menu
    // is the only place a reader learns what `/compact` does here.
    cmdButton: 'Commands',
    cmdTitle: 'Common commands',
    cmdCompact: 'Compact the conversation',
    cmdContext: 'Show context usage',
    cmdCost: 'Cost and time so far',
    cmdModel: 'Show or switch the model',
    cmdEffort: 'Set the reasoning effort',
    cmdInit: 'Write a CLAUDE.md for this project',
    cmdDoctor: 'Run the read-only health check',
    cmdRename: 'Rename this session',
    cmdMcp: 'MCP server status',
    cmdClear: 'Clear the conversation and start a new session',
    cmdClearWarn: '/clear gives the CLI a NEW session id: the turns above stay in this panel, but the new process will not remember them, and they can no longer be resumed. Fill it in anyway?',
    cmdFill: 'Fill it in',
    // Under the list: the menu is short on purpose, and a reader who expected
    // the CLI's own full help has to be told the box still understands it.
    cmdMore: 'Any other slash command still works — just type it and send.',
  },
  zh: {
    panel: 'Claude',
    title: 'Claude Code 工作项',
    subtitle: '只显示从这里打开的常驻会话；你自己在终端里开的不会出现在这里。',
    newItem: '新建工作项',
    empty: '还没有工作项。',
    emptyHint: '新建一个，在某个目录里启动常驻 Claude Code 会话。',
    pickOne: '在左边选一个工作项。',
    pickOneHint: '它的对话记录、状态和待处理的批准会显示在这里。',
    cwd: '目录',
    mode: '批准方式',
    modeAuto: '自动',
    modeManual: '手动',
    switchTo: '切换为',
    stateRunning: '运行中',
    stateWaiting: '等待批准',
    stateIdle: '空闲',
    stateDenied: '已拒绝',
    stateError: '接口错误',
    stateDone: '已结束',
    turns: '轮',
    approve: '允许',
    approveRemember: '本会话总是允许该工具',
    deny: '拒绝',
    interrupt: '打断',
    stop: '停止',
    forget: '移除',
    send: '发送',
    placeholder: '给这个会话发消息…',
    pending: '请求执行',
    startedAt: '开始时间',
    lastActive: '最后活动',
    sessionId: '会话',
    cost: '花费',
    filter: '筛选工作项',
    noMatch: '没有符合筛选条件的工作项。',
    rename: '重命名',
    save: '保存',
    cancel: '取消',
    noTranscript: '暂无记录。',
    expand: '展开全文',
    collapse: '收起',
    errorAction: '操作失败',
    errorShape: 'Host 返回了意外的数据',
    kindUser: '你',
    kindAssistant: 'claude',
    kindThinking: '思考',
    kindStreaming: 'claude',
    kindToolUse: '工具',
    kindToolResult: '结果',
    kindToolError: '错误',
    kindInit: '会话',
    kindResult: '完成',
    kindDenied: '拒绝',
    kindStderr: '错误流',
    kindPolicy: '规则',
    kindOpened: '打开',
    kindStopped: '停止',
    kindExit: '退出',
    kindInterrupt: '打断',
    kindMode: '模式',
    kindApproval: '批准',
    kindReopened: '重开',
    kindRetry: '重连',
    kindNotice: '提示',
    kindApiError: '接口错误',
    turnSteps: '步',
    turnRunning: '进行中',
    turnDenied: '次被拒',
    turnFailed: '有报错',
    // 与 DSH 对话区的「本轮用量」用同一套说法：耗时、输出/输入 token、缓存读取、tok/s。
    usageDuration: '耗时',
    usageOutput: '输出',
    usageInput: '未缓存输入',
    usageCache: '缓存读取',
    usageCacheWrite: '缓存写入',
    // 两种接续方式，两句话。resume 的情况下上面就是同一段对话；只有 primer
    // 才是「历史还在，进程不记得」，混着说会让人误判模型到底知道多少。
    resumeNotice: '已续接上一次的会话：上面的对话属于同一个会话，这个进程记得它们。',
    reopenNotice: '之前的会话已中断，当前是新进程：在同一个目录里重新启动，并把上一轮的问答作为文本摘要交给了 Claude。上面是历史记录，不是这个进程记得的内容。',
    doneNotice: '这个会话已经结束。发消息会让它重新开始：CLI 还能找到这段对话就续接，否则把之前的问答作为上下文交过去。',
    errorNotice: '接口连不上，这一轮就此结束、进程已退出。先确认端点或网络恢复；之后发消息会让它重新开始：CLI 还能找到这段对话就续接，否则把之前的问答作为上下文交过去。',
    askTitle: 'Claude 需要你回答',
    askPickOne: '单选',
    askPickMany: '可多选',
    askFreeText: '填写回答',
    askNumber: '填数字',
    askSend: '发送答案',
    allowedTools: '本会话已放行',
    // 输入框里的图片附件。
    attachHint: '粘贴或拖入图片',
    attachRemove: '移除这张图',
    attachTooLarge: '图片太大了（上限 5 MB）',
    attachTooMany: '一条消息最多 6 张图',
    attachUnsupported: '只能粘贴图片文件',
    imagesOnly: '图片',
    // 列表行里的实时数字。
    context: '上下文',
    lastTurnTokens: '上一轮用掉的 token',
    turnElapsed: '这一轮已经进行',
    turnTook: '上一轮耗时',
    // 输入框旁的指令菜单。每条命令一句说明：这个菜单是读者了解 /compact
    // 在这里干什么的唯一地方。
    cmdButton: '指令',
    cmdTitle: '常用指令',
    cmdCompact: '压缩对话上下文',
    cmdContext: '查看上下文用量',
    cmdCost: '累计花费与用时',
    cmdModel: '查看或切换模型',
    cmdEffort: '调整推理强度',
    cmdInit: '为项目生成 CLAUDE.md',
    cmdDoctor: '运行只读健康检查',
    cmdRename: '给这个会话改名',
    cmdMcp: 'MCP 服务器状态',
    cmdClear: '清空对话，换一个新会话',
    cmdClearWarn: '/clear 会让 CLI 换一个新的会话 id：上面的对话仍然留在面板里，但新进程不再记得它们，也不能再用 --resume 接回去。仍然填入吗？',
    cmdFill: '仍然填入',
    // 列表下方：菜单是刻意短的一截，期望看到 CLI 全部帮助的人需要知道输入框
    // 照样认其余命令。
    cmdMore: '其余斜杠命令照样能用：直接输入并发送。',
  },
}

const CSS = `
/* Importance tiers (item 2 of the review).
   Every row used to be the same 12px grey, so a thinking fragment and the answer
   the user asked for carried identical weight. Four tiers, from the palette:
     low    — italic, tertiary label: bookkeeping and the model's asides
     mid    — upright, secondary label: tool traffic
     high   — upright, primary label: what the human and the model actually said
     answer — larger, violet on a violet wash: the reply the turn was for
   The violet has no alias in the palette (see tools/find-hue.mjs — the only
   violet values published are the syntax-highlighting pair), so it is declared
   here as a local property with both theme values, which is how the palette
   itself pairs them. */
.ccw-root {
  --ccw-answer: #6741d9;
  /* A wash rather than a solid: the answer text stays the readable thing, the
     background only marks where the turn ends. Mixed from the same violet so the
     two never drift apart. */
  --ccw-answer-bg: color-mix(in srgb, #6741d9 9%, transparent);
  /* Deep blue for the question (item 2 of the review). Straight from the
     palette's blue ramp, not mixed: --dsw-static-deepseek-500. */
  --ccw-question: var(--dsw-static-deepseek-500);
  /* The pinned question's frosted pane. A translucent grey plus a blur, so the
     rows scrolling underneath are still visible as movement — the head reads as
     a layer above the transcript rather than as a row that happens to sit first.
     In the light theme the base colour is white, so a grey tint is what makes
     the pane distinguishable from the sheet behind it; in the dark theme the
     fork is inverted (black base, white tint) — see the dark block below. */
  --ccw-glass: color-mix(in srgb, var(--dsw-static-neutral-bluish-1000) 7%, transparent);
  --ccw-glass-edge: color-mix(in srgb, var(--dsw-static-neutral-bluish-1000) 12%, transparent);
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
}
body[data-ds-dark-theme] .ccw-root {
  --ccw-answer: #b197fc;
  --ccw-answer-bg: color-mix(in srgb, #b197fc 14%, transparent);
  /* The 500 step is too dark to read on a dark base; 400 is its light partner. */
  --ccw-question: var(--dsw-static-deepseek-400);
  /* On the dark base a black tint would be invisible, so the frosted pane is
     mixed from white instead — the same relation the palette uses for every
     overlay it publishes. */
  --ccw-glass: color-mix(in srgb, var(--dsw-static-neutral-00) 8%, transparent);
  --ccw-glass-edge: color-mix(in srgb, var(--dsw-static-neutral-00) 14%, transparent);
}
.ccw-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 13px; }
.ccw-head-text { flex: 1 1 auto; min-width: 0; }
.ccw-title { font-size: 15px; font-weight: 600; line-height: 1.35; margin: 0; }
.ccw-subtitle { font-size: 11.5px; line-height: 1.55; margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.ccw-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 1; padding: 6px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
/* The hover rule must NOT repaint the background of a coloured button.
   It used to apply to every button, so the solid "New" and "Allow" buttons turned
   near-white under the cursor — the label stayed light and the text vanished.
   The neutral rule still applies to .ccw-btn, but each coloured variant declares
   its OWN hover afterwards; equal specificity means the later rule wins. */
.ccw-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ccw-btn:disabled { opacity: .5; cursor: default; }
/* The brand colour is near-black in the light theme and near-white in the dark
   one, so the ink is the BASE colour: white-ish on black, black-ish on white, in
   both themes without a second declaration. */
.ccw-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.ccw-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); opacity: .86; }
/* The approval decision. It used to be the same near-black as "New", which made
   the one irreversible choice on the screen look like a generic action; it now
   uses the same amber as the approval card's own border, so the button and the
   box it belongs to read as one thing.
   The ink is white, as asked. Amber-500 against white is about 2.0:1, which is
   under every contrast threshold — so the hover state darkens rather than
   lightens (brightness .88 → about 2.6:1) and the weight is bumped to 600 so the
   label still separates from the fill at a glance. If it ever reads as washed
   out, one step down the same ramp (amber-600) takes white to 2.8:1. */
.ccw-btn-approve { background: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); color: #fff; font-weight: 600; }
.ccw-btn-approve:hover:not(:disabled) {
  background: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
  /* Darken in place: keep the hue, drop the lightness. A white wash here would
     make the label vanish, which is exactly the bug this replaces. */
  filter: brightness(.88);
}
/* Two severities, not three.
   "Interrupt" and "Stop" both act on a live session and are both recoverable
   (the work item survives either), so they are ordinary buttons. "Forget"
   deletes the record, so it is de-emphasised and moved away from them rather
   than painted the same red — the screenshot that prompted this showed all
   three in identical danger styling, which made the safe one look as final as
   the destructive one. */
.ccw-body { display: flex; flex: 1 1 auto; min-height: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
/* Item 1 of the review: the rail and the transcript were both painted white, so
   the split view read as one undivided sheet and the selected row had nothing to
   stand out against. This copies the layout package's own split view
   (dsh-client-ui-layout/lib/client.js): the rail gets the sidebar fill, the
   content keeps the base background, and the seam is the same hairline. */
.ccw-list {
  width: 244px; flex: 0 0 auto; overflow-y: auto; padding: 8px 7px;
  background: var(--dsw-specific-sidebar-fill);
  border-right: .5px solid var(--dsw-alias-border-l3);
  display: flex; flex-direction: column; gap: 6px;
}
.ccw-rows { display: flex; flex-direction: column; gap: 2px; }
/* The title is clickable to rename; it must look like the heading it is, not like
   a link, and only reveal the affordance on hover. */
.ccw-title-edit { cursor: text; }
.ccw-title-edit:hover { color: var(--dsw-alias-brand-primary); }
.ccw-detail { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); }
.ccw-row { display: block; width: 100%; text-align: left; appearance: none; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
/* The rail is tinted now, so the hover and selected fills have to be the
   interactive tokens rather than bg-layer-1, which is the same colour as the
   rail itself and would have made both states invisible. */
.ccw-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ccw-row[data-active='true'] { background: var(--dsw-alias-interactive-bg-active); border-color: var(--dsw-alias-border-l2); }
.ccw-row-top { display: flex; align-items: center; gap: 7px; }
/* Item 5 of the review: one hue per meaning, and the mapping is the one the user
   named — idle blue, running green, waiting amber, dead red, finished grey.
   The denied state covers both "the CLI refused a tool" and "the process died
   with a non-zero code"; both are failures, so both are red. Done stays the
   hollow ring: a filled grey dot would look like a state, and it is the absence
   of one. NB running used the brand colour, which is near-black in this theme —
   it read as "stopped" rather than "working". */
.ccw-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.ccw-dot[data-state='idle'] { background: var(--dsw-alias-state-business-primary); }
.ccw-dot[data-state='running'] { background: var(--dsw-alias-state-success-primary); }
.ccw-dot[data-state='waiting-approval'] { background: var(--dsw-alias-state-warn-primary); }
.ccw-dot[data-state='denied'] { background: var(--dsw-alias-state-error-primary); }
/* An API failure is the same bucket as a refusal from the reader's point of view:
   this went wrong, and it is not coming back on its own. */
.ccw-dot[data-state='error'] { background: var(--dsw-alias-state-error-primary); }
/* A finished item used the border colour, which is a hairline meant to be barely
   visible — on screen the dot disappeared entirely. A hollow ring reads as
   "closed" and still shows up in both themes. */
.ccw-dot[data-state='done'] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); opacity: .55; }
.ccw-row-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
/* The model sits at the end of the title line, small and tertiary: it tells two
   sessions apart and nothing more, so it must not compete with the title. It is
   allowed to shrink (and is the first thing ellipsised) when the title is long. */
.ccw-row-model { flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ccw-row-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The turn's clock, on the title line. Tabular figures so a counting clock does
   not shuffle the model tag sideways every second. Live is the running one and
   takes the running state's green, which is the same colour as the dot beside it;
   a finished clock stays tertiary — it is context, not a signal. */
.ccw-row-clock { flex: 0 0 auto; font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ccw-row-clock[data-live='true'] { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
/* The spend line: total tokens, then the context gauge. One line, because the
   rail is 244px and a third line of text would be the row's whole height. */
.ccw-row-usage { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; overflow: hidden; white-space: nowrap; }
.ccw-row-tok { flex: 0 0 auto; }
/* Separated by a hairline rule rather than a middle dot: the two numbers are not
   a sentence and the dot read as punctuation between them. */
.ccw-row-tok + .ccw-row-ctx { border-left: 1px solid var(--dsw-alias-border-l2); padding-left: 8px; }
.ccw-row-ctx { display: inline-flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; }
.ccw-ctx-label { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
/* The gauge: 34px wide is enough to read as a fraction at a glance without
   competing with the number it annotates. */
.ccw-ctx-bar { flex: 0 0 34px; height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.ccw-ctx-fill { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary); }
.ccw-ctx-fill[data-level='warn'] { background: var(--dsw-alias-state-warn-primary); }
.ccw-ctx-fill[data-level='error'] { background: var(--dsw-alias-state-error-primary); }
.ccw-empty { padding: 28px 18px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }
.ccw-empty strong { display: block; color: var(--dsw-alias-label-primary); font-size: 13px; margin-bottom: 5px; }
.ccw-pane { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.ccw-pane-head { padding: 13px 18px 11px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ccw-pane-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 600; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The meta line carried seven facts with no separator between them, so on screen
   it read as one run-on sentence ("已结束 目录: … 批准方式: 自动 2 轮 …"). */
.ccw-pane-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
.ccw-pane-meta > span + span::before { content: '·'; margin-right: 10px; opacity: .45; }
/* The state badge is already a bordered pill; a separator dot immediately after
   it reads as a stray mark, so the pill gets plain spacing instead. */
.ccw-pane-meta > .ccw-badge + span::before { content: none; }
/* The button group is not another fact on the line: no separator before it. */
.ccw-pane-meta > .ccw-pane-actions::before { content: none; }
.ccw-pane-meta > span[title] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
/* The session id is a control, not just text: clicking copies the full value. It
   is set in tabular figures so two ids are comparable letter by letter, and it
   underlines on hover so the affordance is visible. */
.ccw-pane-sid { cursor: pointer; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.ccw-pane-sid:hover { text-decoration: underline; }
/* The badge follows the same five-hue mapping as the list dot (item 5), so the
   colour a row shows in the rail means the same thing in the header. Running used
   the brand colour, which is near-black here and read as "off". */
.ccw-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 7px; border-radius: 20px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.ccw-badge[data-state='idle'] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.ccw-badge[data-state='running'] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ccw-badge[data-state='waiting-approval'] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ccw-badge[data-state='denied'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ccw-badge[data-state='error'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
/* The controls live at the right end of the meta line. margin-left: auto is what
   pushes them there: the meta row is a wrapping flex container, so the group takes
   the leftover space on its own line when the header is narrow. */
.ccw-pane-actions { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
/* The pane header's buttons are one step smaller than the panel's own: they sit
   inside a line of 11px meta text, and at the composer's size they would set the
   height of the whole row. */
.ccw-pane-actions .ccw-btn { padding: 4px 8px; font-size: 11px; }
/* "Forget" deletes the record and cannot be undone, so it is the one filled
   button in the group. It used to be the faintest one, on the theory that
   de-emphasis prevents accidents — but a control nobody sees is not a safer
   control, it is a control people hunt for. */
.ccw-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; font-weight: 600; }
.ccw-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); filter: brightness(.88); }
.ccw-approval { margin: 10px 18px 0; padding: 10px 12px 10px 13px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary); border-left-width: 3px; background: var(--dsw-alias-bg-layer-1); }
.ccw-approval-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ccw-approval-tool { font-size: 13px; font-weight: 600; margin-top: 3px; word-break: break-all; }
.ccw-approval-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap; }
.ccw-check { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.ccw-log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 18px 16px; }
/* A left accent bar per row replaces the "wall of identical grey text" the long
   tool results produced: the eye can now find where a block starts. */
.ccw-log-row { display: flex; gap: 10px; padding: 4px 0 4px 9px; font-size: 12px; line-height: 1.65; border-left: 2px solid transparent; }
.ccw-log-row:hover { border-left-color: var(--dsw-alias-border-l2); }
.ccw-log-kind { flex: 0 0 62px; display: flex; flex-direction: column; gap: 1px; font-size: 10px; letter-spacing: .03em; padding-top: 3px; overflow: hidden; }
/* The row's own clock, under its label (item 3 of the review). Both states show a
   time: an open turn stamps every row, a collapsed turn stamps its heading.
   The palette's dimmed ink is its faintest step, and the screenshot that prompted
   this showed the time as almost invisible. The tertiary step is still clearly
   secondary but actually reads. */
.ccw-log-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccw-log-when { font-size: 10.5px; font-style: normal; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ccw-log-body { flex: 1 1 auto; min-width: 0; }
.ccw-log-text { display: block; white-space: pre-wrap; word-break: break-word; }
/* A tool result can be thousands of characters; the screenshot that prompted
   this showed one 1927-character block swallowing the entire transcript. Clamp
   it to a handful of lines with a fade at the bottom, and let the reader open the
   one row they care about — the shape stays visible, the run-on wall does not.

   The answer folds to TWO lines, as asked: a folded answer is a reminder of what
   it said, and the reader who wants more has the control right there. The process
   rows keep six, because a tool result's first two lines are usually its least
   informative. */
.ccw-log-row[data-clamped='true'] .ccw-log-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent);
  mask-image: linear-gradient(to bottom, #000 72%, transparent);
}
.ccw-log-row[data-kind='result'][data-clamped='true'] .ccw-log-text { -webkit-line-clamp: 2; }
/* The fold control is the one thing on a long block a reader has to find, so it
   is primary ink at 700 weight with a chevron in front — the screenshot that
   prompted this showed a violet 11px "收起" that read as a caption. It used to
   take the answer's own violet on the wash, which made it fade into the block it
   was meant to close. Icon and label are one flex row so the chevron never wraps
   away from the word. */
.ccw-log-toggle { display: inline-flex; align-items: center; gap: 4px; appearance: none; border: 0; background: none; padding: 2px 0 0; margin: 0; font: inherit; font-size: 11.5px; font-weight: 700; color: var(--dsw-alias-label-primary); cursor: pointer; }
.ccw-log-toggle:hover { text-decoration: underline; }
.ccw-log-toggle-icon { flex: 0 0 auto; display: block; }

/* --- importance tiers -------------------------------------------------------
   tier 3 (low): italic + tertiary, the quietest thing on the page
   tier 2 (mid): upright + secondary
   tier 1 (high): upright + primary
   tier 0 (answer): violet + 13.5px, the largest body text in the panel       */

/* tier 3 — bookkeeping and the model talking to itself */
.ccw-log-row[data-kind='thinking'],
.ccw-log-row[data-kind='init'],
.ccw-log-row[data-kind='mode'],
.ccw-log-row[data-kind='opened'],
.ccw-log-row[data-kind='reopened'],
.ccw-log-row[data-kind='policy'],
.ccw-log-row[data-kind='stopped'],
.ccw-log-row[data-kind='exit'],
.ccw-log-row[data-kind='interrupt'] { font-size: 11px; }
.ccw-log-row[data-kind='thinking'] .ccw-log-text,
.ccw-log-row[data-kind='init'] .ccw-log-text,
.ccw-log-row[data-kind='mode'] .ccw-log-text,
.ccw-log-row[data-kind='opened'] .ccw-log-text,
.ccw-log-row[data-kind='reopened'] .ccw-log-text,
.ccw-log-row[data-kind='policy'] .ccw-log-text,
.ccw-log-row[data-kind='stopped'] .ccw-log-text,
.ccw-log-row[data-kind='exit'] .ccw-log-text,
.ccw-log-row[data-kind='interrupt'] .ccw-log-text { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.ccw-log-row[data-kind='thinking'] .ccw-log-kind,
.ccw-log-row[data-kind='init'] .ccw-log-kind,
.ccw-log-row[data-kind='mode'] .ccw-log-kind,
.ccw-log-row[data-kind='opened'] .ccw-log-kind,
.ccw-log-row[data-kind='reopened'] .ccw-log-kind,
.ccw-log-row[data-kind='policy'] .ccw-log-kind,
.ccw-log-row[data-kind='stopped'] .ccw-log-kind,
.ccw-log-row[data-kind='exit'] .ccw-log-kind,
.ccw-log-row[data-kind='interrupt'] .ccw-log-kind { color: var(--dsw-alias-label-tertiary); font-style: italic; }

/* tier 2 — tool traffic: readable, but not competing with the prose */
.ccw-log-row[data-kind='tool-use'],
.ccw-log-row[data-kind='tool-result'],
.ccw-log-row[data-kind='approval-requested'],
.ccw-log-row[data-kind='approval-answered'] { border-left-color: var(--dsw-alias-border-l2); }
.ccw-log-row[data-kind='tool-use'] .ccw-log-text,
.ccw-log-row[data-kind='tool-result'] .ccw-log-text,
.ccw-log-row[data-kind='approval-requested'] .ccw-log-text,
.ccw-log-row[data-kind='approval-answered'] .ccw-log-text { color: var(--dsw-alias-label-secondary); }
.ccw-log-row[data-kind='tool-use'] .ccw-log-kind,
.ccw-log-row[data-kind='tool-result'] .ccw-log-kind { color: var(--dsw-alias-label-secondary); }
.ccw-log-row[data-kind='approval-requested'] .ccw-log-kind,
.ccw-log-row[data-kind='approval-answered'] .ccw-log-kind { color: var(--dsw-alias-state-warn-primary); }
.ccw-log-row[data-kind='approval-requested'],
.ccw-log-row[data-kind='approval-answered'] { border-left-color: var(--dsw-alias-state-warn-primary); }

/* tier 1 — the conversation itself */
/* The question is the darkest text in the panel (item 2 of the review: deep
   blue). --dsw-static-deepseek-500 is the palette's own blue; dark mode takes the
   400 step, which is the lighter half of the same hue, exactly as the palette
   pairs its other aliases. */
.ccw-log-row[data-kind='user'] { border-left-color: var(--ccw-question); }
.ccw-log-row[data-kind='user'] .ccw-log-text { color: var(--ccw-question); font-weight: 600; }
.ccw-log-row[data-kind='assistant'] .ccw-log-text { color: var(--dsw-alias-label-primary); }
/* The answer still being written. It is the same voice as a finished assistant
   row, with a caret at the end so the row reads as "still arriving" rather than
   as a sentence that stops mid-word (which is exactly what it looks like). */
.ccw-log-row[data-kind='streaming'] .ccw-log-text { color: var(--dsw-alias-label-primary); }
.ccw-log-row[data-kind='streaming'] .ccw-log-text::after {
  content: '▍';
  margin-left: 1px;
  color: var(--ccw-answer);
  animation: ccw-blink 1.1s steps(1, end) infinite;
}
@keyframes ccw-blink { 50% { opacity: 0; } }

/* tier 0 — the answer. Larger, violet, and never clamped: this is the reason the
   turn happened, so it is the one thing the reader must not have to click. */
/* The answer gets the violet wash (item 4 of the review): a tinted block reads as
   "this is the product of the turn" from a distance, which a coloured left bar
   alone does not manage in a long transcript. */
.ccw-log-row[data-kind='result'] {
  border-left-color: var(--ccw-answer);
  background: var(--ccw-answer-bg);
  border-radius: 0 7px 7px 0;
  padding: 7px 11px 8px 9px;
  margin: 3px 0 7px;
}
.ccw-log-row[data-kind='result'] .ccw-log-kind { color: var(--ccw-answer); font-weight: 600; font-style: normal; }
.ccw-log-row[data-kind='result'] .ccw-log-text { color: var(--ccw-answer); font-size: 13.5px; font-weight: 500; line-height: 1.62; }
/* The usage line under an answer: present but clearly secondary — small, secondary
   ink (tertiary sat almost invisibly on the violet wash), and tabular so the
   numbers of two turns line up. */
.ccw-log-usage { display: block; margin-top: 6px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; letter-spacing: .01em; }

/* Failures stay red at every tier: colour is the cheapest way to make them
   findable inside a collapsed turn. */
.ccw-log-row[data-kind='tool-error'],
.ccw-log-row[data-kind='stderr'],
.ccw-log-row[data-kind='denied'],
.ccw-log-row[data-kind='api-error'] { border-left-color: var(--dsw-alias-state-error-primary); }
.ccw-log-row[data-kind='tool-error'] .ccw-log-text,
.ccw-log-row[data-kind='stderr'] .ccw-log-text,
.ccw-log-row[data-kind='denied'] .ccw-log-text,
.ccw-log-row[data-kind='api-error'] .ccw-log-text { color: var(--dsw-alias-state-error-primary); font-style: normal; }

/* Reconnects take the amber warning hue, not red: nothing has failed yet, the CLI
   is still trying. Without this row a dead endpoint looked exactly like a slow
   answer — the panel sat at "running" with a blank transcript and no way to tell
   the two apart. Amber also matches the "waiting" state the rail already uses. */
.ccw-log-row[data-kind='retry'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.ccw-log-row[data-kind='retry'] .ccw-log-text { color: var(--dsw-alias-state-warn-primary); font-style: normal; }
/* A notice is the CLI telling the human something actionable; secondary ink with
   the accent bar is enough to find it without shouting. */
.ccw-log-row[data-kind='notice'] { border-left-color: var(--dsw-alias-state-business-primary); }
.ccw-log-row[data-kind='notice'] .ccw-log-text { color: var(--dsw-alias-label-secondary); font-style: normal; }

/* --- Markdown ---------------------------------------------------------------
   Claude answers in Markdown, and the transcript used to show the source: a table
   read as a row of pipes, a list as "- item". These rules give the parsed blocks
   the shapes they have everywhere else people read chat answers, using the same
   label tokens as the surrounding text so an answer stays one colour family.
   Everything inherits the row's font-size and ink: a heading inside an answer
   must not look like the panel's own heading. */
.ccw-md { white-space: normal; }
.ccw-md > *:first-child { margin-top: 0; }
.ccw-md > *:last-child { margin-bottom: 0; }
/* A paragraph keeps the model's own line breaks (pre-wrap) but not its leading
   indentation, which Markdown treats as insignificant. */
.ccw-md-p { margin: 0 0 .55em; white-space: pre-wrap; }
.ccw-md-h { margin: .75em 0 .35em; font-weight: 600; line-height: 1.4; }
.ccw-md-h[data-level='1'] { font-size: 1.35em; }
.ccw-md-h[data-level='2'] { font-size: 1.22em; }
.ccw-md-h[data-level='3'] { font-size: 1.12em; }
.ccw-md-h[data-level='4'],
.ccw-md-h[data-level='5'],
.ccw-md-h[data-level='6'] { font-size: 1.02em; color: var(--dsw-alias-label-secondary); }
.ccw-md-strong { font-weight: 700; }
.ccw-md-em { font-style: italic; }
/* Inline code: a tinted chip, because a backticked identifier in running text is
   a different kind of token and the eye should be able to pick it out. */
.ccw-md-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; padding: .1em .32em; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l2); white-space: pre-wrap; word-break: break-word; }
/* A fenced block is the one place the text must keep its exact spacing, so it
   overrides the row's wrapping rules. Horizontal scroll rather than wrap: a
   wrapped diff or a wrapped log line is unreadable. */
.ccw-md-pre { position: relative; margin: .5em 0 .6em; padding: 9px 11px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l2); overflow-x: auto; }
.ccw-md-codelines { display: block; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; line-height: 1.55; white-space: pre; color: var(--dsw-alias-label-primary); }
/* The language tag from the fence's info string: small, upper right, and dimmed,
   so it can be read without competing with the code. */
.ccw-md-lang { position: absolute; top: 4px; right: 8px; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); unicode-bidi: plaintext; }
.ccw-md-list { margin: .35em 0 .55em; padding-left: 1.35em; }
.ccw-md-li { margin: .1em 0; }
.ccw-md-rule { border: 0; border-top: 1px solid var(--dsw-alias-border-l2); margin: .7em 0; }
.ccw-md-quote { margin: .5em 0; padding: 2px 0 2px 11px; border-left: 3px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
/* Tables. The wrapper scrolls horizontally so a wide table does not stretch the
   transcript column; the table itself draws its own grid, which is what makes a
   matrix readable at all. Header ink is secondary and the header fill is one step
   up from the row, so the first row reads as a label bar rather than as data. */
.ccw-md-table-wrap { margin: .5em 0 .65em; overflow-x: auto; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2); }
/* max-content with a min-width floor: a three-column table fills the column, and
   an eight-column one overflows into the wrapper's horizontal scroll instead of
   squeezing every cell down to one character per line. */
.ccw-md-table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: .95em; }
.ccw-md-th, .ccw-md-td { padding: 5px 10px; border-bottom: .5px solid var(--dsw-alias-border-l2); border-right: .5px solid var(--dsw-alias-border-l2); text-align: left; vertical-align: top; }
.ccw-md-th:last-child, .ccw-md-td:last-child { border-right: 0; }
.ccw-md-tr:last-child .ccw-md-td { border-bottom: 0; }
.ccw-md-th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ccw-md-td { color: var(--dsw-alias-label-primary); }
.ccw-md-tr:nth-child(even) .ccw-md-td { background: var(--dsw-alias-interactive-bg-hover); }
/* A clamped row that contains tables or code cannot use the -webkit-box line
   clamp: the parsed tree is a stack of block elements, and line clamping a box
   with block children behaves inconsistently across engines. The fold uses a
   max-height with the same fade instead.

   Height, not max-height: answer lengths here run from 1 200 to 3 000 characters,
   which is 20-50 lines, and a max-height tuned for the long end left the short
   ones fully visible with only a fade painted over them — a fold that visibly
   folds nothing. A fixed height is what a folded block should be: the same size
   every time, so the transcript's shape is predictable while scrolling.
   The height is TWO lines expressed in em: the answer's line-height is 1.62, so
   two lines are 3.24em. Matching the plain-text path's line count through a
   length instead of through line-clamp is what keeps the two identical — get the
   multiplier wrong and they silently differ by a line (9.72em with a 1.62
   line-height was six lines, not the two that were asked for).

   The parser also has to beat the plain rule above, which is why the selector
   carries an extra class: both are [data-clamped='true'] rules, and the later one
   would otherwise lose to the more specific answer rule. */
.ccw-log-row[data-clamped='true'] .ccw-log-text.ccw-md {
  display: block;
  height: 3.24em;
  overflow: hidden;
  -webkit-line-clamp: unset;
  -webkit-mask-image: linear-gradient(to bottom, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, #000 82%, transparent);
}

/* --- per-turn folding (items 3 and 4 of the review) -------------------------
   A finished turn folds to a single line, and its answer stays open underneath
   it: the process is evidence, the answer is the product. */
.ccw-turn { display: flex; flex-direction: column; gap: 2px; }
.ccw-turn + .ccw-turn { margin-top: 4px; }
/* The question stays pinned to the top of the transcript while its own turn is
   on screen: scrolling through a long answer used to take the question away and
   leave the reader with a wall of reply and no idea what it was replying to.
   Sticky (not a JS overlay) is what makes it hand over cleanly: the next turn's
   head pushes this one out as it arrives, with no measurement and no timer.

   It is a FROSTED PANE, not an opaque row. A solid background made the pinned
   head look like the first row of the transcript — on the dark theme it was a
   black bar with no edge, and the reader could not tell it was pinned at all. The
   glass is a translucent tint plus a backdrop blur: the rows sliding underneath
   stay visible as movement, which is what says "this is floating". The bottom
   hairline is the pane's edge; without it a translucent pane has no boundary to
   read against a same-coloured background.

   backdrop-filter is what makes it opaque enough to read against; where it is
   unsupported the tint alone still leaves the text legible, because the tint is
   built from the same ink the text uses. */
.ccw-turn-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  appearance: none;
  background: var(--ccw-glass);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
  border: 0;
  border-bottom: 1px solid var(--ccw-glass-edge);
  border-radius: 6px;
  color: inherit;
  font: inherit;
  padding: 5px 6px 5px 8px;
  cursor: pointer;
}
/* No hover repaint: a translucent pane that brightens under the cursor reads as
   the transcript flickering while it scrolls. The faint edge is the only state
   change, and only when the pointer is actually on it. */
.ccw-turn-head:hover { border-bottom-color: var(--dsw-alias-border-l3); }
/* The chevron reads as a control, not as bookkeeping, so it is a step darker than
   the meta text it sits beside. */
.ccw-turn-marker { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-secondary); width: 9px; }
/* The folded heading is the question, so it is set at the same size as the answer
   text below it (13.5px): the screenshot that prompted this showed a 12px grey
   line above a 13.5px violet block, which made the question look like a caption
   for the answer rather than the thing that was asked. It keeps the primary label
   colour rather than the question blue, because a folded row is a heading, not the
   utterance itself — opening the turn shows the real question in blue. */
.ccw-turn-text { flex: 1 1 auto; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A heading that is NOT a question — a transcript window whose first row is a
   tool result — is set in the low tier and prefixed by the row's kind label in the
   markup. It must not look like something the reader typed: that was the bug this
   marks, where a line of shell output took the question styling. */
.ccw-turn-head[data-user='false'] .ccw-turn-text { color: var(--dsw-alias-label-tertiary); font-weight: 500; font-style: italic; font-size: 12.5px; }
/* The turn's start time, in the heading, so it is visible while the turn is folded
   and while it is open (item 3 of the review). Same ink as the row clocks: the
   dimmed step was invisible on screen, and a timestamp nobody can read is the same
   as no timestamp. */
.ccw-turn-when { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ccw-turn-meta { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
/* A folded turn hides its own failures, so the heading carries them: "1 次拒绝"
   or "有报错". Red, small, and placed before the step count so the eye reaches it
   while scanning the left edge of the list. */
.ccw-turn-flag { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-state-error-primary); border: 1px solid currentColor; border-radius: 999px; padding: 0 5px; line-height: 15px; white-space: nowrap; }
.ccw-turn-body { display: flex; flex-direction: column; padding-left: 9px; }
.ccw-composer { flex: 0 0 auto; display: flex; gap: 8px; align-items: flex-end; padding: 10px 18px 14px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
/* The command menu floats out of the composer and opens UPWARD over the
   transcript, so the composer has to stack above everything it covers.
   The level is 5 and not 2 because a turn's heading is position: sticky with
   z-index 3 inside the transcript, and the transcript's scroll box declares no
   stacking context of its own — so the sticky heading and the composer compete
   directly, and at 2 the pinned question painted OVER the open menu. The menu's
   own z-index 20 cannot help there: it lives inside the composer's stacking
   context, which caps the whole subtree at the composer's level. Anything the
   menu must cover has to be numbered below this. */
.ccw-composer { position: relative; z-index: 5; }
/* The attachment strip sits above the textarea, inside the composer's wrapping
   flex column: thumbnails are a property of the message, not of the input box, and
   putting them inside the box would fight the resize handle. */
.ccw-attach-strip { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 2px; }
/* One thumbnail: a fixed 44px square, the image cropped to fill it, and a remove
   button in the corner. Fixed size keeps the strip from reflowing while a big
   image decodes. */
.ccw-attach { position: relative; width: 44px; height: 44px; border-radius: 6px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ccw-attach img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ccw-attach-remove { position: absolute; top: 1px; right: 1px; width: 15px; height: 15px; padding: 0; line-height: 13px; text-align: center; font-size: 11px; appearance: none; border: 0; border-radius: 50%; cursor: pointer; background: var(--dsw-alias-bg-mask-3); color: #fff; }
.ccw-attach-remove:hover { background: var(--dsw-alias-state-error-primary); }
/* The composer's own column of controls, so the textarea and the send button stay
   on one line while the strip wraps above them. */
.ccw-composer-input { flex: 1 1 auto; display: flex; gap: 8px; align-items: flex-end; min-width: 0; }
/* The command menu's anchor. It has to be a positioned box of its own: the menu
   opens UPWARD from the composer, and the composer sits at the bottom of the
   pane, so a menu positioned against the pane would be cut off or would force a
   scrollbar. align-self: flex-end keeps the button on the send button's line
   even when the textarea has been dragged taller. */
.ccw-cmd { position: relative; flex: 0 0 auto; align-self: flex-end; }
.ccw-cmd-menu {
  position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 20;
  width: 268px; max-height: 320px; overflow-y: auto; padding: 4px;
  display: flex; flex-direction: column; gap: 1px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  /* The transcript scrolls under this: a shadow is what separates a floating
     panel from the rows behind it without a second border. */
  box-shadow: 0 8px 22px var(--dsw-alias-bg-mask-3);
}
.ccw-cmd-title { padding: 5px 8px 6px; font-size: 10.5px; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); }
.ccw-cmd-item {
  appearance: none; border: 0; background: transparent; font: inherit; text-align: left;
  display: flex; flex-direction: column; gap: 2px; padding: 5px 8px;
  border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-primary);
}
.ccw-cmd-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ccw-cmd-item:disabled { opacity: .5; cursor: default; }
/* The command itself is what the reader types, so it is the heading of the row
   and is set in the code face; the sentence under it is what it does. */
.ccw-cmd-name { font-size: 12px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.ccw-cmd-desc { font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); }
/* The one destructive entry. Red on the name only: a red row background would
   read as "selected", which is the opposite of what it means. */
.ccw-cmd-item[data-danger='true'] .ccw-cmd-name { color: var(--dsw-alias-state-error-primary); }
/* The second click's warning, inside the menu, above the entries it applies to. */
.ccw-cmd-warn {
  margin: 4px 4px 2px; padding: 7px 8px; border-radius: 6px;
  font-size: 11px; line-height: 1.55; color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-state-error-primary);
}
.ccw-cmd .ccw-btn[data-open='true'] { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
/* The note under the list: the menu is short on purpose, and this is where the
   reader is told the box still understands every other command. */
.ccw-cmd-more { padding: 4px 8px 2px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 3px; }
/* Dropping a file on the composer has to look like it will be accepted. */
.ccw-composer[data-dropping='true'] { background: var(--dsw-alias-interactive-bg-hover); outline: 1px dashed var(--dsw-alias-border-l3); outline-offset: -4px; }
/* A refused paste says why, in the same red as every other refusal here. */
.ccw-attach-error { flex: 1 0 100%; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
/* A turn that carried images says so in the transcript; the blobs are not kept.
   It sits under the question, next to it, because it describes that turn. */
.ccw-log-images { display: block; margin-top: 3px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
/* A column flex child with flex-grow let the textarea absorb leftover height, so
   the composer was twice as tall as its two lines of text. A fixed starting
   height plus a vertical resize handle is the right affordance. */
.ccw-input { flex: 1 1 auto; height: 62px; min-height: 38px; max-height: 180px; resize: vertical; font: inherit; font-size: 12px; line-height: 1.55; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.ccw-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
/* These two reuse the composer's skin but must NOT inherit its size. They have to
   come AFTER .ccw-input: both selectors are one class, so the last declaration
   wins, and having them earlier (which is where they started) left the rail's
   filter 62px tall with a resize handle. */
.ccw-filter { height: 26px; min-height: 0; max-height: none; resize: none; font-size: 11.5px; padding: 4px 8px; flex: 0 0 auto; }
.ccw-title-input { height: 26px; min-height: 0; font-size: 14px; padding: 3px 8px; flex: 1 1 auto; min-width: 0; }
.ccw-error { margin: 8px 18px 0; padding: 7px 10px; border-radius: 7px; font-size: 11px; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
/* The head banner sits above the split view rather than inside the detail pane,
   so it spans the full width and needs its own gutter — it was rendered with
   this class all along but had no rule, so it looked identical to the in-pane
   banner and its margin was wrong. */
.ccw-error-head { margin: 0 20px 8px; }
/* Revision, and then the question card. */
.ccw-ask { margin: 10px 18px 0; padding: 10px 12px 11px 13px; border-radius: 8px; border: 1px solid var(--ccw-answer); border-left-width: 3px; background: var(--dsw-alias-bg-layer-1); }
.ccw-ask-head { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ccw-ask-q { margin-top: 9px; }
.ccw-ask-q:first-of-type { margin-top: 6px; }
.ccw-ask-text { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
/* AskUserQuestion's header field is a topic chip, not a sentence: the CLI renders
   it as a small label above the question. Here it sits inline, so it needs to be
   visually subordinate to the question it introduces. */
.ccw-ask-head-label { display: inline-block; font-size: 10px; font-weight: 500; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 1px 5px; margin-right: 7px; vertical-align: 1px; }
.ccw-ask-note { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-left: 6px; }
.ccw-ask-options { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 0; }
.ccw-ask-option { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 4px 7px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
.ccw-ask-option:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l1); }
.ccw-ask-option[data-picked='true'] { border-color: var(--ccw-answer); color: var(--dsw-alias-label-primary); }
.ccw-ask-label { font-weight: 500; }
/* A free-text / number question has no options, so the answer box needs the panel
   input's look without the composer's fixed height. */
.ccw-ask-input { width: 100%; height: 30px; min-height: 0; resize: none; font-size: 12px; }
.ccw-ask-desc { color: var(--dsw-alias-label-tertiary); }
/* The tools this session answers without asking. Secondary ink and no border: it
   is a note next to the approval card, not a second card. */
.ccw-allow-rules { margin-top: 7px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
/* Banner shown when the transcript contains a reopened row: the reader is
   looking at a history the live process no longer has. */
.ccw-reopen { margin: 10px 18px 0; padding: 8px 11px; border-radius: 8px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-1); }
/* The API-failure banner is red rather than amber: a reopened session is a
   routine handover, this one is a fault the reader has to resolve first. */
.ccw-reopen-error { border-left-color: var(--dsw-alias-state-error-primary); }
.ccw-reopen strong { color: var(--dsw-alias-label-primary); font-weight: 600; }
`

// ------------------------------------------------------------------ helpers

/** Format a timestamp as a short local clock time. */
function clock(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The localized label for one work-item state. */
function stateLabel(t, state) {
  if (state === 'running') return t('stateRunning')
  if (state === 'waiting-approval') return t('stateWaiting')
  if (state === 'denied') return t('stateDenied')
  if (state === 'error') return t('stateError')
  if (state === 'done') return t('stateDone')
  return t('stateIdle')
}

/**
 * The short left-column label for one transcript row.
 *
 * A tool row shows the tool's own name (Write, Bash) because that is the
 * information the reader wants; every other row shows its kind, translated. The
 * Host may add a kind this panel has never heard of, so an unknown kind falls
 * back to the raw string rather than to a blank column.
 */
function kindLabel(t, row) {
  const kind = String(row?.kind ?? '')
  if (kind === 'tool-use' && typeof row?.tool === 'string' && row.tool !== '') return row.tool
  // A refusal is about a tool, so it names it: "denied" alone left the reader
  // hunting the transcript for which call was refused.
  if (kind === 'denied' && typeof row?.tool === 'string' && row.tool !== '') return row.tool
  const KEYS = {
    'user': 'kindUser',
    'approval-requested': 'kindApproval',
    'approval-answered': 'kindApproval',
    'assistant': 'kindAssistant',
    'thinking': 'kindThinking',
    'streaming': 'kindStreaming',
    'tool-use': 'kindToolUse',
    'tool-result': 'kindToolResult',
    'tool-error': 'kindToolError',
    'init': 'kindInit',
    'result': 'kindResult',
    'denied': 'kindDenied',
    'stderr': 'kindStderr',
    'policy': 'kindPolicy',
    'opened': 'kindOpened',
    'reopened': 'kindReopened',
    'stopped': 'kindStopped',
    'exit': 'kindExit',
    'interrupt': 'kindInterrupt',
    'mode': 'kindMode',
    'delta': 'kindAssistant',
    'retry': 'kindRetry',
    'notice': 'kindNotice',
    'api-error': 'kindApiError',
  }
  const key = KEYS[kind]
  return key === undefined ? kind : t(key)
}

/**
 * The per-turn usage line: 耗时 · tokens · tok/s, in the DSH chat UI's words.
 *
 * The chat surface prints `{tps} tok/s` and a "本轮用量" panel with cache hit and
 * input/output split; this is the compact one-line version of the same facts so
 * the two views of the same session do not disagree.
 * @param row - a `result` row carrying the usage fields.
 * @returns the line, or null when the Host reported none (an older log).
 */
function usageLine(t, row) {
  const parts = []
  if (typeof row.durationMs === 'number' && row.durationMs > 0) {
    parts.push(`${t('usageDuration')} ${seconds(row.durationMs)}`)
  }
  if (typeof row.outputTokens === 'number' && row.outputTokens > 0) {
    parts.push(`${t('usageOutput')} ${compact(row.outputTokens)}`)
  }
  if (typeof row.inputTokens === 'number' && row.inputTokens > 0) {
    parts.push(`${t('usageInput')} ${compact(row.inputTokens)}`)
  }
  if (typeof row.cacheReadTokens === 'number' && row.cacheReadTokens > 0) {
    parts.push(`${t('usageCache')} ${compact(row.cacheReadTokens)}`)
  }
  if (typeof row.cacheWriteTokens === 'number' && row.cacheWriteTokens > 0) {
    parts.push(`${t('usageCacheWrite')} ${compact(row.cacheWriteTokens)}`)
  }
  if (typeof row.tps === 'number' && row.tps > 0) parts.push(`${row.tps} tok/s`)
  if (parts.length === 0) return null
  return h('span', { key: 'u', className: 'ccw-log-usage' }, parts.join(' · '))
}

/**
 * A token count in the shortest form that still reads as a quantity.
 *
 * Counts here range from 12 to a few hundred thousand, and a raw number in that
 * range cannot be compared at a glance: 1 048 576 against 98 304 is a subtraction
 * nobody does while scanning a list. So the rule is the one every chat surface
 * uses — thousands below ten thousand (exact), `K` above it, `M` above a million —
 * with one decimal only where it still means something (`12.4K`, never `12.0K`).
 * The comparison is done in tokens, not in locale collation, so it does not drift
 * between `zh` and `en`.
 * @param value - a token count.
 * @returns the compact form, or an empty string for a non-number.
 */
function compact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  if (value < 10_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const thousands = value / 1_000
    // One decimal below 100K (12.4K); whole numbers above it (124K), because the
    // decimal stops being information once the number is that large.
    return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/, '') : String(Math.round(thousands))}K`
  }
  const millions = value / 1_000_000
  return `${millions < 100 ? millions.toFixed(1).replace(/\.0$/, '') : String(Math.round(millions))}M`
}

/**
 * A running clock: whole seconds, then `m:ss`, then `h:mm:ss`.
 *
 * Distinct from `seconds()` on purpose. That one summarises a finished duration
 * and switches units by magnitude; this one counts up in front of a reader, so it
 * must keep a steady shape instead of jumping between `5.2s` and `12s`. Minutes
 * and hours are zero-padded because an unpadded clock jitters as it grows.
 * @param ms - milliseconds elapsed since the turn started.
 * @returns the clock text.
 */
function elapsed(ms) {
  const total = Math.max(0, Math.floor((typeof ms === 'number' && Number.isFinite(ms) ? ms : 0) / 1000))
  const pad = (value) => String(value).padStart(2, '0')
  if (total < 60) return `${String(total)}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${String(minutes)}:${pad(total % 60)}`
  return `${String(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(total % 60)}`
}

/**
 * The chevron in front of a fold control.
 *
 * Drawn as an SVG rather than as a character: the arrow glyphs that read
 * correctly in one font (the filled triangles, the angle quote) come out as boxes
 * in another, and this panel is rendered in the host's font, not ours. 10px and
 * currentColor, so it follows the button's state exactly like the label does.
 * @param direction - 'down' when the row can be opened, 'up' when it can close.
 * @param keyName - element key.
 * @returns the icon element.
 */
function chevron(direction, keyName) {
  const path = direction === 'up' ? 'M2 6.5 L5 3.5 L8 6.5' : 'M2 3.5 L5 6.5 L8 3.5'
  return h('svg', {
    key: keyName,
    className: 'ccw-log-toggle-icon',
    width: '10',
    height: '10',
    viewBox: '0 0 10 10',
    'aria-hidden': 'true',
  }, h('path', {
    key: 'p',
    d: path,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }))
}

/** A duration in the shortest form that still reads as a duration. */
function seconds(ms) {
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  const value = ms / 1000
  if (value < 10) return `${value.toFixed(1)}s`
  if (value < 60) return `${String(Math.round(value))}s`
  const minutes = Math.floor(value / 60)
  const rest = Math.round(value - minutes * 60)
  return `${String(minutes)}m${String(rest).padStart(2, '0')}s`
}

/**
 * The `-p` session's id, shortened for the header.
 *
 * The full uuid is 36 characters and would push every other field in the meta
 * row off the line; the first eight are what the CLI's own pickers show and are
 * enough to tell two sessions apart. The full value stays in the element's
 * `title`, and clicking copies it.
 * @param id - the session id the CLI reported at `init`.
 * @returns the short form.
 */
function shortId(id) {
  const text = String(id ?? '')
  return text.length <= 8 ? text : text.slice(0, 8)
}

/**
 * Put text on the clipboard, best effort.
 *
 * `navigator.clipboard` needs a secure context and a user gesture; the panel runs
 * inside the DSH shell where both normally hold, but a failure here must not break
 * the click, so the older `execCommand` path and a silent give-up are the backup.
 * @param text - what to copy.
 */
function copyText(text) {
  const value = String(text ?? '')
  if (value === '') return
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    clipboard.writeText(value).catch(() => {})
    return
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  } catch {
    // Copying is a convenience; the id is still in `title` and in the log.
  }
}

/** The last path segment of a directory, for the compact list row. */
function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? String(path ?? '') : parts[parts.length - 1]
}

/**
 * One model id, shortened to what distinguishes it in a 244px rail.
 *
 * The CLI reports ids like `deepseek-v4.1-flash[1m]` and
 * `claude-sonnet-5-5-20260101`; the context tag and the date stamp are the noise
 * on a list row, and the full id stays available as the row's `title`. A model
 * that is not a string (an older log, a Host that never saw `init`) renders as
 * nothing rather than as the word "undefined".
 * @param model - the `model` field of one work item.
 * @returns the short label, or an empty string.
 */
function shortModel(model) {
  const text = String(model ?? '').trim()
  if (text === '') return ''
  return text.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
}

/**
 * Unwrap one Remote outcome.
 *
 * Every Client-Remote call resolves to a `RemoteResult` envelope — `{ ok: true,
 * value }` on success, `{ ok: false, error }` on any failure — and never
 * rejects for a Host-side refusal. Reading the payload off the envelope instead
 * of off the return value is what turns a working call into `undefined`, which
 * is exactly the shape that used to blank the panel: `list()` yielded the
 * envelope, `envelope.items` was `undefined`, and the first `items.length`
 * inside render threw. Nothing here may assume the envelope is absent.
 * @param outcome - the `RemoteResult` a namespace method resolved to.
 * @returns the decoded value.
 */
function unwrap(outcome) {
  if (isEnvelope(outcome)) {
    if (outcome.ok) return outcome.value
    const error = outcome.error
    throw new Error(typeof error?.message === 'string' ? error.message : JSON.stringify(error))
  }
  // A bare value means the transport changed under us; pass it through rather
  // than pretending it failed, so the panel still shows whatever it received.
  return outcome
}

/**
 * Whether a resolved value is a `RemoteResult` rather than the payload itself.
 *
 * The discriminator has to be narrow: several of this package's own payloads
 * carry a boolean `ok` of their own, so "has an `ok` key" would misread them as
 * envelopes and hand back `undefined` for a perfectly good reply.
 * @param value - the resolved value of a namespace call.
 * @returns true for a success envelope with `value` present, or a failure one.
 */
function isEnvelope(value) {
  if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') return false
  if (value.ok) return Object.prototype.hasOwnProperty.call(value, 'value')
  return value.error !== undefined
}

/** A short, safe rendering of an unexpected wire value, for the error banner. */
function describe(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, 180)
  } catch {
    return String(value)
  }
}

// ------------------------------------------------------------------ markdown
//
// Claude answers in Markdown, and the transcript used to print it verbatim: a
// table arrived as a row of `| --- |` pipes and a list as `- item`, which is the
// one place in this panel where the text on screen is not what the model meant.
// This is a deliberately SMALL renderer — no HTML, no images, no links that can
// navigate — covering the shapes a chat transcript actually contains:
//
//   # … ######      headings          >= and >     block quotes
//   - * +           bullet lists     1. 2)        numbered lists
//   | a | b |       tables            ```          fenced code
//   ---             rules             **b** *i* `c`  inline emphasis
//
// Everything else stays literal text, which is the safe failure: a construct the
// renderer does not know reads exactly as it did before, rather than disappearing.
// The output is plain React elements with class names from this panel's own CSS,
// so it is themed by the same tokens as the rest of the transcript.
//
// Blank lines split blocks; two lines of paragraph text inside one block stay one
// paragraph, which is what Markdown says and what a terminal answer looks like.

/** One inline run: code, strong, or emphasis. */
//
// Only the asterisk forms become emphasis. Markdown also allows `_x_` and `__x__`,
// but in a developer transcript those are indistinguishable from identifiers —
// `my_file_name` and `__init__.py` are files, not emphasis — and every attempt to
// tell them apart by context gets one of the two wrong. Underscores therefore stay
// literal, which is the safe direction: the text still reads, it just is not
// italic.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/

/**
 * Parse one line into inline runs.
 *
 * Order matters: code spans are matched first so `*` inside them is literal, and
 * an asterisk that opens but never closes simply stays a character — the regex
 * cannot match an unpaired one.
 * @param line - one line of text with no block marker.
 * @param keyBase - a prefix so the element keys are unique within the block.
 * @returns an array of strings and elements.
 */
function inlineNodes(line, keyBase) {
  const out = []
  let rest = String(line ?? '')
  let index = 0
  while (rest !== '') {
    const match = INLINE.exec(rest)
    if (match === null) {
      out.push(rest)
      break
    }
    if (match.index > 0) out.push(rest.slice(0, match.index))
    const token = match[0]
    const key = `${keyBase}-${String(index)}`
    index += 1
    if (token.startsWith('`')) {
      out.push(h('code', { key, className: 'ccw-md-code' }, token.slice(1, -1)))
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(h('strong', { key, className: 'ccw-md-strong' }, token.slice(2, -2)))
    } else {
      out.push(h('em', { key, className: 'ccw-md-em' }, token.slice(1, -1)))
    }
    rest = rest.slice(match.index + token.length)
  }
  return out
}

/**
 * Split one table row `| a | b |` into trimmed cells.
 * @param line - one line of a Markdown table.
 * @returns the cell texts.
 */
function tableCells(line) {
  let text = String(line ?? '').trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

/**
 * The alignment a table's separator row asks for.
 *
 * `|:---|---:|:---:|` are the three forms GitHub renders, and alignment is the
 * only thing the separator row is FOR, so reading it is the difference between a
 * table that lines its numbers up and one that does not.
 * @param line - the `|---|` row.
 * @returns one alignment per column: left, right, center, or an empty string.
 */
function tableAligns(line) {
  return tableCells(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
}

/**
 * Whether a line is a table's separator row (`| --- | :-: |`).
 * @param line - one line of a Markdown table.
 * @returns true for a separator row.
 */
function isTableRule(line) {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

/** Whether a line starts a block the paragraph collector must stop at. */
function startsBlock(line) {
  if (/^\s*(```|~~~)/.test(line)) return true
  if (/^#{1,6}\s+/.test(line)) return true
  if (/^\s*>\s?/.test(line)) return true
  if (/^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(line)) return true
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return true
  return false
}

/**
 * Render the whole answer as blocks.
 *
 * The parser is a single pass with lookahead for the multi-line constructs
 * (fenced code, tables, lists), because every other shape is one line. It never
 * throws: an unclosed fence runs to the end of the text, which is what the model
 * meant when its output was cut off inside a block.
 * @param text - the raw Markdown.
 * @param keyBase - a prefix for element keys, so two blocks never collide.
 * @returns an array of React elements.
 */
function markdownBlocks(text, keyBase) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0
  let slice = 0
  const nextKey = () => {
    const key = `${keyBase}-b${String(slice)}`
    slice += 1
    return key
  }

  while (index < lines.length) {
    const line = lines[index]

    // Blank lines separate blocks; they are not blocks themselves.
    if (line.trim() === '') {
      index += 1
      continue
    }

    // Fenced code. The info string (`js`, `powershell`) is kept: it is the only
    // way to tell a diff from a shell transcript at a glance.
    const fence = /^\s*(```|~~~)(.*)$/.exec(line)
    if (fence !== null) {
      const markerText = fence[1]
      const language = fence[2].trim()
      const body = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(markerText)) {
        body.push(lines[index])
        index += 1
      }
      // Skip the closing fence when there is one; an unterminated block keeps
      // whatever arrived.
      index += 1
      blocks.push(h('pre', { key: nextKey(), className: 'ccw-md-pre' }, [
        language === '' ? null : h('span', { key: 'lang', className: 'ccw-md-lang' }, language),
        h('code', { key: 'code', className: 'ccw-md-codelines' }, body.join('\n')),
      ]))
      continue
    }

    // A table: a header row followed by a separator row. Without the separator it
    // is a paragraph containing pipes, which is how a model writes "a | b" in
    // prose, so the separator is what makes a table a table.
    if (line.includes('|') && index + 1 < lines.length && isTableRule(lines[index + 1])) {
      const head = tableCells(line)
      const aligns = tableAligns(lines[index + 1])
      const rows = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      const tableKey = nextKey()
      const cellStyle = (column) => (aligns[column] === undefined || aligns[column] === ''
        ? undefined
        : { textAlign: aligns[column] })
      blocks.push(h('div', { key: tableKey, className: 'ccw-md-table-wrap' }, [
        h('table', { key: 'table', className: 'ccw-md-table' }, [
          h('thead', { key: 'head' }, [
            h('tr', { key: 'row' }, head.map((cell, column) => h('th', {
              key: `h${String(column)}`,
              className: 'ccw-md-th',
              style: cellStyle(column),
            }, inlineNodes(cell, `${tableKey}-th${String(column)}`)))),
          ]),
          h('tbody', { key: 'body' }, rows.map((cells, row) => h('tr', {
            key: `r${String(row)}`,
            className: 'ccw-md-tr',
            // A short row is padded rather than dropped: the cell count comes
            // from the header, which is the row Markdown defines.
          }, head.map((_unused, column) => h('td', {
            key: `c${String(column)}`,
            className: 'ccw-md-td',
            style: cellStyle(column),
          }, inlineNodes(cells[column] ?? '', `${tableKey}-td${String(row)}-${String(column)}`)))))),
        ]),
      ]))
      continue
    }

    // Headings. `#` runs of seven or more are not headings in Markdown.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      blocks.push(h(`h${String(level)}`, {
        key: nextKey(),
        className: 'ccw-md-h',
        'data-level': String(level),
      }, inlineNodes(heading[2], `${keyBase}-h`)))
      index += 1
      continue
    }

    // A horizontal rule: three or more of the same marker, alone on the line.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(h('hr', { key: nextKey(), className: 'ccw-md-rule' }))
      index += 1
      continue
    }

    // Block quote: consecutive `>` lines become one quote, and a quote can hold
    // any block, so its body goes back through the parser.
    if (/^\s*>/.test(line)) {
      const body = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(h('blockquote', { key: nextKey(), className: 'ccw-md-quote' },
        markdownBlocks(body.join('\n'), `${keyBase}-q`)))
      continue
    }

    // Lists. The marker decides ordered vs bullet, and the INDENT decides nesting;
    // one extra level is enough for what a chat answer contains, and anything
    // deeper is rendered as another item of the same list rather than mis-nested.
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null
      const items = []
      while (index < lines.length) {
        const next = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[index])
        if (next === null) {
          // An indented line that is not a new item continues the one above it.
          if (lines[index].trim() !== '' && items.length > 0 && /^\s+\S/.test(lines[index])) {
            items[items.length - 1].text += `\n${lines[index].trim()}`
            index += 1
            continue
          }
          break
        }
        const isOrdered = /^\s*\d/.test(next[2])
        if (isOrdered !== ordered) break
        items.push({ indent: next[1].length, text: next[3] })
        index += 1
      }
      const listKey = nextKey()
      const ListTag = ordered ? 'ol' : 'ul'
      const baseIndent = items.length === 0 ? 0 : Math.min(...items.map((item) => item.indent))
      blocks.push(h(ListTag, {
        key: listKey,
        className: 'ccw-md-list',
        'data-ordered': ordered ? 'true' : 'false',
      }, items.map((item, order) => h('li', {
        key: `i${String(order)}`,
        className: 'ccw-md-li',
        style: item.indent > baseIndent
          ? { marginLeft: '1.1em', listStyleType: ordered ? 'lower-alpha' : 'circle' }
          : undefined,
      }, inlineNodes(item.text, `${listKey}-li${String(order)}`)))))
      continue
    }

    // Plain paragraph: everything up to the next blank line or block marker.
    const body = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index]
      if (next.trim() === '') break
      if (startsBlock(next)) break
      if (next.includes('|') && index + 1 < lines.length && isTableRule(lines[index + 1])) break
      body.push(next)
      index += 1
    }
    blocks.push(h('p', { key: nextKey(), className: 'ccw-md-p' },
      inlineNodes(body.join('\n'), `${keyBase}-p${String(index)}`)))
  }

  return blocks
}

/**
 * Whether a block of text contains any Markdown at all.
 *
 * The transcript shows command output, file paths and CLI errors in the same
 * component as Claude's prose. Running the parser over all of it would turn a
 * shell comment starting with `#` into a heading, so the parser is only used when
 * the text contains a marker that means something: a fence, a table, a heading, a
 * quote, or a list marker at the start of a line. Emphasis alone is not enough —
 * a path full of underscores is not emphasis.
 * @param text - the row's text.
 * @returns true when rendering it as Markdown is worth it.
 */
function hasMarkdown(text) {
  const value = String(text ?? '')
  if (value.trim() === '') return false
  // Block markers, which only mean anything at the start of a line.
  if (/^\s*(```|~~~)/m.test(value)) return true
  if (/^\s*#{1,6}\s+\S/m.test(value)) return true
  if (/^\s*>\s?/m.test(value)) return true
  if (/^\s*[-*+]\s+\S/m.test(value) || /^\s*\d{1,9}[.)]\s+\S/m.test(value)) return true
  if (value.includes('|') && /^\s*\|?\s*:?-{2,}/m.test(value)) return true
  // Inline markers. These apply to a one-line reply too — "**done**" in a single
  // sentence is still emphasis — but each pattern has to be one that cannot
  // plausibly be a glob: a code span needs both backticks, `**` needs both pairs,
  // and a single `*` has to enclose something. Underscore emphasis is not
  // recognised at all; see the note on INLINE.
  if (/\*\*[^*\n]+\*\*/.test(value)) return true
  if (/`[^`\n]+`/.test(value)) return true
  if (/\*[^*\n]+\*/.test(value)) return true
  return false
}

/**
 * The element tree for one row's text.
 *
 * A streaming row is never parsed: its text grows by a few characters per poll, so
 * a half-arrived table would reflow on every tick and the caret at the end would
 * land in the middle of a cell. It is parsed the moment the block closes and the
 * finished `assistant` row takes over.
 * @param text - the row's text.
 * @param keyBase - a prefix for element keys.
 * @param plain - force literal text (streaming rows).
 * @returns one span or an array of block elements.
 */
function renderText(text, keyBase, plain) {
  if (plain === true || !hasMarkdown(text)) {
    return h('span', { key: 't', className: 'ccw-log-text' }, text)
  }
  return h('div', { key: 't', className: 'ccw-log-text ccw-md' }, markdownBlocks(text, keyBase))
}

// ----------------------------------------------------------------- the panel

/**
 * Build the panel component over one Client context.
 * @param ctx - the Client plugin context (slots, locale).
 * @param remote - reads the mounted Remote namespace.
 * @returns a React component rendering the list and the selected work item.
 */
function createPage(ctx, remote) {
  return function ClaudeSessionsPage() {
    const [items, setItems] = React.useState([])
    const [selected, setSelected] = React.useState(null)
    const [rows, setRows] = React.useState([])
    // The composer's contents — the text, the images and a paste refusal — per
    // WORK ITEM, not per panel.
    //
    // They used to be three flat pieces of panel state, which meant switching
    // work items carried the half-written message across: the draft typed for
    // session A appeared in session B's box, one Send away from being delivered
    // to the wrong conversation. Keying by id keeps each box with its own
    // session and still remembers a draft when the reader comes back.
    const [composers, setComposers] = React.useState({})
    const composerId = selected === null ? null : String(selected.id)
    const composer = (composerId !== null && composers[composerId]) || EMPTY_COMPOSER
    const draft = composer.draft
    const attachments = composer.attachments
    const attachError = composer.attachError
    // One writer for all three fields, resolving the target item at call time.
    // `setComposers` takes a function of the previous map so two edits in flight
    // (a paste landing while the reader types) cannot clobber each other.
    const editComposer = React.useCallback((change) => {
      if (composerId === null) return
      setComposers((previous) => {
        const current = previous[composerId] ?? EMPTY_COMPOSER
        return { ...previous, [composerId]: { ...current, ...change(current) } }
      })
    }, [composerId])

    /** Replace the draft text of the selected item's box. */
    const setDraftText = React.useCallback((value) => {
      editComposer(() => ({ draft: String(value ?? '') }))
    }, [editComposer])
    // The approval card's "always allow" tick. This one IS panel state: the
    // choice is consumed by the next Approve and must not outlive the card.
    const [remember, setRemember] = React.useState(false)
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    // Whether the composer's slash-command menu is open, and — when the reader
    // has clicked the one destructive entry — which command is waiting for the
    // confirming second click. Two pieces of state rather than one union, because
    // closing the menu must also forget the warning: a menu reopened later must
    // not still be armed.
    const [commandsOpen, setCommandsOpen] = React.useState(false)
    const [pendingCommand, setPendingCommand] = React.useState('')
    // Which long transcript rows the reader opened, keyed by row key. A Set would
    // need a fresh copy on every toggle; a plain object keeps the handler simple.
    const [opened, setOpened] = React.useState({})
    // Which finished turns the reader reopened, keyed by turn key. Absent means
    // "the default", which is folded for a finished turn and open for the one in
    // flight — see the grouping code in render.
    const [folded, setFolded] = React.useState({})
    // Chosen option labels for a pending AskUserQuestion, keyed by question text.
    const [picks, setPicks] = React.useState({})
    // The rename field: null when closed, otherwise the draft title. A separate
    // state rather than a contenteditable title, because the title is Host state
    // and a rename that is half-typed must not look saved.
    const [renaming, setRenaming] = React.useState(null)
    // The text in the rail's filter box. The rail is 244px wide and every item is
    // one row, so once a few sessions are open the list is the slow way to find
    // one; the filter matches the title, the directory and the state.
    const [filter, setFilter] = React.useState('')
    // Whether a drag is over the composer, so the drop target can look like one.
    const [dropping, setDropping] = React.useState(false)
    // The transcript is append-only, so the interesting end is the bottom. Without
    // this the panel opened every item scrolled to its FIRST row, and a 50-row
    // session meant scrolling down before you could read the reply you just asked
    // for. `logRef.current` is null under the offline harnesses, hence the guard.
    const logRef = React.useRef(null)
    // Auto-scroll bookkeeping, declared before `readItem` so the callback can
    // force a jump when the selection changes.
    //
    // `shapeRef` is a signature of the WHOLE transcript, not just its length. The
    // length was the original test, and it is wrong for the most common growth
    // there is: while an answer streams, the last row's TEXT grows and the row
    // count does not change at all — so the panel never scrolled during a reply,
    // and the sentence being written walked off the bottom of the screen. The
    // signature covers the count, the newest row's identity and how much text is
    // in the last rows.
    const stickRef = React.useRef(true)
    const shapeRef = React.useRef('')
    const jumpRef = React.useRef(false)
    const t = React.useMemo(() => ctx.locale.bind(NS), [])

    // The poll reads the selection through a ref, NOT through the state value.
    //
    // `list()` returns freshly built snapshots, so `setSelected(current)` hands
    // React a new object identity on every tick. With `selected` in the refresh
    // callback's dependency list, that identity change rebuilt `refresh`, which
    // is the only dependency of the polling effect — so the effect tore down and
    // restarted, whose first act is an immediate `list()`. The intended 2s
    // interval collapsed into a tight loop against the Host. Reading the id from
    // a ref keeps `refresh` stable, so the effect installs exactly one timer.
    const selectedId = React.useRef(null)

    const readItem = React.useCallback(async (id, limit = 120) => {
      selectedId.current = id ?? null
      // A different item starts a different transcript, so the next effect must
      // place the viewport at the bottom regardless of where the old one was.
      jumpRef.current = true
      // The menu is about ONE session; leaving it open across a switch would let
      // the next click act on a session the reader did not open it against.
      setCommandsOpen(false)
      setPendingCommand('')
      if (!id) {
        setSelected(null)
        setRows([])
        return
      }
      const result = unwrap(await remote().read(id, limit))
      setSelected(result?.item ?? null)
      setRows(Array.isArray(result?.rows) ? result.rows : [])
    }, [])

    const refresh = React.useCallback(async () => {
      const listed = unwrap(await remote().list())
      // The wire shape is the Host's to define and this panel must survive a
      // surprise: an undefined `items` used to throw inside render, and the
      // renderer answers a throwing keyed occupant by discarding it, so the
      // whole panel vanished. Report the mismatch instead of dying on it.
      if (!Array.isArray(listed?.items)) {
        setItems([])
        setError(`${t('errorShape')}: ${describe(listed)}`)
        return
      }
      setItems(listed.items)
      const id = selectedId.current
      if (id === null) return
      const current = listed.items.find((entry) => entry.id === id)
      // `find()` yields `undefined` when the id is gone. Answering a missing
      // selection with `null` slipped past an `=== undefined` guard elsewhere
      // and fell through to `read(current.id)` — a throw on EVERY poll tick.
      if (current === undefined) {
        selectedId.current = null
        setSelected(null)
        setRows([])
        return
      }
      setSelected(current)
      const detail = unwrap(await remote().read(id, 120))
      setSelected(detail?.item ?? current)
      setRows(Array.isArray(detail?.rows) ? detail.rows : [])
    }, [t])

    // Poll the Host: the Remote surface is request/response only, so the panel
    // refreshes on a timer and immediately after every action it takes.
    React.useEffect(() => {
      let cancelled = false
      let handle
      const tick = async () => {
        try {
          if (!cancelled) await refresh()
        } catch (failure) {
          if (!cancelled) setError(String(failure?.message ?? failure))
        }
        if (!cancelled) handle = setTimeout(tick, POLL_MS)
      }
      tick()
      return () => {
        cancelled = true
        clearTimeout(handle)
      }
    }, [refresh])

    // A one-second tick for the rail's running timer.
    //
    // The poll is every two seconds, and a clock that only moves on a poll ticks in
    // 2s jumps — which reads as a stalled process. This effect re-renders once a
    // second and NOTHING else: it holds no state, calls no Remote method, and only
    // runs while at least one item is in flight, so an idle panel still makes one
    // list() per poll and nothing more.
    const anyLive = items.some((item) => typeof item.turnStartedAt === 'number' && item.turnStartedAt > 0)
    // The clock value itself lives in state because a ref would not re-render.
    const [now, setNow] = React.useState(0)
    React.useEffect(() => {
      if (!anyLive) return undefined
      setNow(Date.now())
      const handle = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(handle)
    }, [anyLive])

    // Keep the newest row in view — but only when the reader is already at the
    // bottom. The poll hands back a fresh `rows` array every 2s even when nothing
    // changed, so an unconditional scroll would yank the viewport down while
    // someone was reading scrollback. `jumpRef` forces one scroll after the user
    // picks a different work item, where starting at the top would be wrong.
    //
    // The growth test is on CONTENT, not on row count (see `shapeRef`): a streaming
    // answer grows inside one row, and a Markdown answer re-renders the same rows
    // taller once it settles. Both have to bring the viewport along.
    React.useEffect(() => {
      const node = logRef.current
      if (node === null || node === undefined) return
      const shape = rows.length === 0
        ? ''
        : `${String(rows.length)}|${String(rows.at(-1)?.seq ?? rows.at(-1)?.at ?? '')}|${String(rows.at(-1)?.text ?? '').length}`
      const grew = shape !== shapeRef.current
      shapeRef.current = shape
      if (!jumpRef.current && !(grew && stickRef.current)) return
      jumpRef.current = false
      // Scroll, then scroll again after layout. A row that grows by re-rendering
      // Markdown (or a pasted image finishing its decode) changes the height after
      // this effect has already measured it, and one scroll would land short.
      node.scrollTop = node.scrollHeight
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
      if (raf !== null) raf(() => { if (stickRef.current) node.scrollTop = node.scrollHeight })
      stickRef.current = true
    }, [rows])

    const run = React.useCallback(async (operation) => {
      setBusy(true)
      setError('')
      try {
        await operation()
        await refresh()
      } catch (failure) {
        setError(`${t('errorAction')}: ${String(failure?.message ?? failure)}`)
      } finally {
        setBusy(false)
      }
    }, [refresh, t])

    const onNew = React.useCallback(() => run(async () => {
      const picked = await ctx.uiWorkspace.pickDirectory()
      if (picked === null) return
      const created = unwrap(await remote().start({ cwd: picked, title: baseName(picked) }))
      if (created?.item?.id !== undefined) await readItem(created.item.id)
    }), [run, readItem])

    /**
     * Accept one pasted or dropped file list into the composer.
     *
     * Only images are taken: the CLI's image block is the one non-text payload a
     * user turn can carry without writing a file first (`tools/probe-image.mjs`
     * measured it). The limits are this panel's own — 5 MB and six per message —
     * because a bigger request is not an error to the API, it is a message nobody
     * wants to wait for.
     *
     * Reading is asynchronous and ORDER IS NOT GUARANTEED, so a placeholder is
     * inserted first and replaced in place when its file finishes decoding.
     * Appending on load instead would order the thumbnails by decode speed.
     * @param files - a FileList or array of File.
     */
    const addFiles = React.useCallback((files) => {
      const list = Array.from(files ?? [])
      if (list.length === 0) return
      let problem = ''
      const usable = []
      for (const file of list) {
        if (!String(file.type ?? '').startsWith('image/')) { problem = t('attachUnsupported'); continue }
        if (file.size > 5 * 1024 * 1024) { problem = t('attachTooLarge'); continue }
        usable.push(file)
      }
      const slots = Math.max(0, 6 - attachments.length)
      if (usable.length > slots) problem = t('attachTooMany')
      const chosen = usable.slice(0, slots)
      editComposer(() => ({ attachError: problem }))
      if (chosen.length === 0) return
      const placeholders = chosen.map((file) => ({
        id: `a${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        name: file.name === '' ? t('imagesOnly') : file.name,
        mediaType: file.type,
        data: '',
        url: '',
      }))
      editComposer((current) => ({ attachments: [...current.attachments, ...placeholders] }))
      chosen.forEach((file, index) => {
        const slot = placeholders[index]
        const reader = new FileReader()
        reader.onload = () => {
          const url = String(reader.result ?? '')
          const comma = url.indexOf(',')
          if (comma < 0) return
          // `data:image/png;base64,AAAA` -> media type and payload. The declared
          // type wins when present, because a file from the clipboard can carry
          // an empty `type`.
          const head = url.slice(0, comma)
          const data = url.slice(comma + 1)
          const mediaType = /^data:([^;]+)/.exec(head)?.[1] ?? file.type
          editComposer((current) => ({
            attachments: current.attachments.map((entry) => (entry.id === slot.id
              ? { ...entry, mediaType, data, url }
              : entry)),
          }))
        }
        reader.onerror = () => {
          editComposer((current) => ({
            attachments: current.attachments.filter((entry) => entry.id !== slot.id),
            attachError: t('attachUnsupported'),
          }))
        }
        reader.readAsDataURL(file)
      })
    }, [attachments.length, t, editComposer])

    const onPaste = React.useCallback((event) => {
      const items = event.clipboardData?.items
      if (items === undefined || items === null) return
      const files = []
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file !== null) files.push(file)
        }
      }
      // Pasting text — a path, a command — must behave exactly as before.
      if (files.length === 0) return
      event.preventDefault()
      addFiles(files)
    }, [addFiles])

    const onDrop = React.useCallback((event) => {
      event.preventDefault()
      setDropping(false)
      const files = event.dataTransfer?.files
      if (files !== undefined && files !== null && files.length > 0) addFiles(files)
    }, [addFiles])

    /** Remove one attachment; a placeholder that is still decoding goes too. */
    const removeAttachment = React.useCallback((id) => {
      editComposer((current) => ({
        attachments: current.attachments.filter((entry) => entry.id !== id),
        attachError: '',
      }))
    }, [editComposer])

    const onSend = React.useCallback(() => {
      const text = draft.trim()
      const ready = attachments.filter((entry) => entry.data !== '')
      if ((text === '' && ready.length === 0) || selected === null) return
      const sending = ready.map((entry) => ({
        mediaType: entry.mediaType,
        data: entry.data,
        name: entry.name,
      }))
      editComposer(() => ({ draft: '', attachments: [], attachError: '' }))
      // The menu has done its job once the text is on its way.
      setCommandsOpen(false)
      setPendingCommand('')
      run(async () => { unwrap(await remote().send(selected.id, text, sending)) })
    }, [draft, attachments, selected, run, editComposer])

    /** Open or close the command menu, always disarming the warning with it. */
    const toggleCommands = React.useCallback(() => {
      setCommandsOpen((previous) => !previous)
      setPendingCommand('')
    }, [])

    /**
     * Act on one command entry.
     *
     * The textarea is the whole delivery mechanism: the command is written into
     * the draft and the reader presses Enter. Nothing is sent from here — the menu
     * is a convenience for typing `/compact` correctly, not a second way to run
     * the session, and that is what makes a mis-click harmless.
     *
     * A `confirms` entry arms itself on the first click and fills in only on the
     * second, with the consequence spelled out in between.
     */
    const onCommand = React.useCallback((entry) => {
      if (selected === null) return
      if (entry.confirms === true && pendingCommand !== entry.slash) {
        setPendingCommand(entry.slash)
        return
      }
      const text = `/${entry.slash}${entry.arg === true ? ' ' : ''}`
      // Replace, not append: the menu is opened to put a command in the box, and
      // leaving a half-written sentence in front of it would send `/compact` to
      // the model as prose.
      setDraftText(text)
      setCommandsOpen(false)
      setPendingCommand('')
    }, [selected, pendingCommand, setDraftText])

    const onRename = React.useCallback(() => {
      const title = String(renaming ?? '').trim()
      if (title === '' || selected === null) return
      setRenaming(null)
      run(async () => { unwrap(await remote().rename(selected.id, title)) })
    }, [renaming, selected, run])

    const onApprove = React.useCallback(() => run(async () => {
      unwrap(await remote().approve(selected.id, remember))
      setRemember(false)
    }), [selected, remember, run])

    /**
     * Send the picked labels for a pending AskUserQuestion.
     *
     * Approving without this is what produced "The user did not answer the
     * questions.": the CLI reads its answers out of the tool input it gets back,
     * so the label has to travel with the control response.
     */
    const onAnswer = React.useCallback(() => run(async () => {
      const questions = Array.isArray(selected?.pendingQuestions) ? selected.pendingQuestions : []
      const payload = questions.map((question) => ({
        question: String(question.question ?? ''),
        picked: (Array.isArray(picks[String(question.question ?? '')]) ? picks[String(question.question ?? '')] : [])
          .map((label) => String(label)),
      }))
      unwrap(await remote().answer(selected.id, payload))
      setPicks({})
    }), [selected, picks, run])

    /** Toggle one option; single-choice questions replace instead of appending. */
    const onPick = React.useCallback((question, label, multi) => {
      setPicks((previous) => {
        const current = Array.isArray(previous[question]) ? previous[question] : []
        if (multi !== true) return { ...previous, [question]: current.includes(label) && current.length === 1 ? [] : [label] }
        const next = current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]
        return { ...previous, [question]: next }
      })
    }, [])

    // Building the element tree is the last thing that can fail, and the
    // renderer contains a throwing occupant by ABDICATING it: the panel shows
    // nothing at all and the error never reaches the page. Catching here keeps
    // the failure on screen, which is the only place a user can see it.
    try {
    // ------------------------------------------------------------------ rows
    //
    // One transcript row -> one element. Kept separate from the turn grouping
    // below because a row is rendered identically whether it appears under a
    // folded turn or an open one.
    const rowElement = (row, index) => {
      // Identity first, position second. The transcript arrives as the newest 120
      // rows, so once a session passes that the window slides and every index
      // shifts by one — which silently re-pointed every fold at a different row.
      const key = typeof row.seq === 'number' ? `s${String(row.seq)}` : `${String(row.at ?? '')}-${String(index)}`
      const text = row.text ?? (row.code !== undefined ? String(row.code) : '')
      // The closing row of a turn: the violet answer block, or the API error that
      // ended the turn instead. Both are the product of the turn and both stay
      // open below the folded process.
      const isAnswer = row.kind === 'result' || row.kind === 'api-error'
      // The row the Host appends while an answer is still being written. It gets
      // no fold toggle: the text grows between polls, so a "Show all · N" button
      // that changes its number under the cursor is noise, and the whole point of
      // the row is to show everything that has arrived.
      const isStreaming = row.kind === 'streaming'
      // Markdown only where the text is prose Claude wrote. A tool result is a
      // shell transcript or a JSON blob: `#` there is a comment, `*` is a glob,
      // and `|` is a pipe — running the parser over it would mangle exactly the
      // text a reader needs verbatim. A streaming row is prose as well, but it is
      // only parsed once it is finished (see `renderText`).
      const prose = row.kind === 'assistant' || row.kind === 'result' || row.kind === 'streaming'
        || row.kind === 'user' || row.kind === 'thinking'
      // The fold control only appears when folding would actually hide something.
      // It was briefly offered on every answer, which put "展开全文 · 78" under a
      // 78-character API error — a control that folds nothing and teaches the
      // reader to ignore the one control that matters.
      //
      // The test is an estimate of rendered height: a plain column of ~500px at
      // 13.5px holds about 50 characters a line, and a folded answer shows TWO of
      // them — so anything past ~110 characters is already being hidden, and the
      // control earns its place from there. A Markdown answer gets a lower bar
      // because its blocks (a table row, a fenced line) take vertical space a
      // character count does not see. A short API error, the case that put a
      // pointless control here, is still below both.
      const lines = text.split('\n').length
      const foldable = isAnswer
        ? (text.length > 110 || lines > 2 || (hasMarkdown(text) && (text.length > 80 || lines > 1)))
        : text.length > 600
      const canFold = !isStreaming && foldable
      // Answers start OPEN: item 4 of the first review was "show the whole answer",
      // and that is still the right default — the fold is there for a reply long
      // enough to push the next turn off screen. `opened[key]` only records a
      // deliberate deviation from that default.
      const isOpen = opened[`${selected?.id ?? ''}:${key}`] === undefined ? isAnswer : opened[`${selected?.id ?? ''}:${key}`] === true
      return h('div', {
        key,
        className: 'ccw-log-row',
        'data-kind': row.kind,
        'data-clamped': canFold && !isOpen ? 'true' : 'false',
      }, [
        // The left column carries the label and, under it, when the row happened.
        // Every row shows its own time when the turn is open; the collapsed turn
        // shows the question's time in its heading instead (see below).
        h('span', { key: 'k', className: 'ccw-log-kind' }, [
          h('span', { key: 'l', className: 'ccw-log-label' }, kindLabel(t, row)),
          h('span', { key: 'w', className: 'ccw-log-when' }, clock(row.at)),
        ]),
        h('div', { key: 'b', className: 'ccw-log-body' }, [
          renderText(text, key, isStreaming || !prose),
          canFold
            ? h('button', {
              key: 'm',
              type: 'button',
              className: 'ccw-log-toggle',
              // The icon says which way the control goes; the size suffix stays
              // beside the word because it is the one thing that says how much is
              // hidden.
              onClick: () => setOpened((previous) => ({ ...previous, [`${selected?.id ?? ''}:${key}`]: !isOpen })),
            }, [
              chevron(isOpen ? 'up' : 'down', 'i'),
              h('span', { key: 'l' }, isOpen ? t('collapse') : `${t('expand')} · ${String(text.length)}`),
            ])
            : null,
          // The per-turn figures sit under the answer only, because that is where
          // they describe something: how long THIS turn took and what it cost.
          isAnswer ? usageLine(t, row) : null,
          // A turn that carried pasted images says how many. The blobs are not in
          // the event log, so this line is the only trace in a replay; without it
          // an answer about an image would refer to something invisible.
          typeof row.images === 'number' && row.images > 0
            ? h('span', { key: 'img', className: 'ccw-log-images' }, `${String(row.images)} ${t('imagesOnly')}`)
            : null,
        ]),
      ])
    }

    // ------------------------------------------------------------- turn folding
    //
    // Items 3 and 4 of the review. A transcript is a sequence of turns, each
    // starting at a `user` row, and a finished turn is mostly process: thinking,
    // tool calls, tool results. Rendering every one of those at full length is
    // what made the old panel a wall of text.
    //
    // A turn now renders as a one-line heading that can be reopened, plus its
    // answer. The turn in flight stays open — folding the thing that is currently
    // happening would hide the only live feedback the panel has.
    const live = selected !== null && (selected.state === 'running' || selected.state === 'waiting-approval')
    // A real transcript always starts with lifecycle rows (`opened`, `init`)
    // BEFORE the first question. Letting those form a turn of their own gave the
    // panel a first heading that read "open E:\…" instead of what was asked, so
    // they are collected as a preamble and hung under the first turn's process.
    const firstUser = rows.findIndex((row) => row.kind === 'user')
    const preamble = firstUser <= 0 ? [] : rows.slice(0, firstUser)
    const turns = []
    for (let index = Math.max(0, firstUser); index < rows.length; index += 1) {
      const row = rows[index]
      if (row.kind === 'user' || turns.length === 0) turns.push({ at: index, rows: [row], answerAt: -1 })
      else {
        const turn = turns[turns.length - 1]
        turn.rows.push(row)
        // A turn closes on its final record, which is `result` when the turn
        // produced an answer and `api-error` when it ended on an unreachable
        // endpoint. Both must stay visible below the folded process: an error the
        // reader has to click to see is an error they will miss.
        if (row.kind === 'result' || row.kind === 'api-error') turn.answerAt = index
      }
    }
    // Give the preamble to the first turn so it is never lost, and never becomes
    // a heading on its own.
    const log = turns.flatMap((turn, order) => {
      const key = `t${String(turn.at)}`
      const last = order === turns.length - 1
      // The heading text: what the human asked, or the turn's first row when the
      // transcript starts with something else (an interrupted turn with no user).
      //
      // A turn whose first row is NOT a question is a transcript that was cut, and
      // its heading must not pretend otherwise: `up after 4s` was a line of shell
      // output standing where a question goes, which read as something the reader
      // had typed. Such a heading is marked and shown in the low tier, so the
      // orange question styling only ever belongs to an actual question.
      const first = turn.rows[0]
      const fromUser = first.kind === 'user'
      const heading = fromUser
        ? String(first.text ?? '')
        : `${kindLabel(t, first)} ${String(first.text ?? '').slice(0, 80)}`
      // The turn in flight is OPEN by default — folding the thing that is
      // happening would hide the only live feedback the panel has — but it is no
      // longer unrepeatable: the reader can close it, and `folded[key]` records
      // that. The old rule forced it open with no way back, so a long running turn
      // filled the screen with process rows and the only way past it was to
      // scroll. Closing it stays closed for the rest of that turn and reopens when
      // the next turn starts, because the next turn has its own key.
      const inFlight = turn.answerAt < 0 && last && live
      // `folded[key]` stores the DELIBERATE choice: true = the reader closed it.
      // Only a deliberate choice can override the default, and the default is
      // "open while it runs, closed once it is done".
      //
      // The key is scoped to the WORK ITEM. A bare `t0`/`t3` collides across
      // sessions — turn 0 of every transcript — so a turn folded in one session
      // came back folded in another, the same cross-session leak the composer
      // had. `selected` is the item the rows belong to, so its id is the scope.
      const scope = `${selected?.id ?? ''}:`
      const foldKey = `${scope}${key}`
      const isOpen = folded[foldKey] === undefined ? inFlight : folded[foldKey] === false
      const ordered = order === 0
        ? [...preamble.map((row, offset) => ({ row, index: offset })), ...turn.rows.map((row, offset) => ({ row, index: turn.at + offset }))]
        : turn.rows.map((row, offset) => ({ row, index: turn.at + offset }))
      const process = ordered
        .filter((entry) => entry.index !== turn.answerAt)
        .map((entry) => rowElement(entry.row, entry.index))
      const answer = turn.answerAt < 0 ? null : rowElement(rows[turn.answerAt], turn.answerAt)
      // The heading keeps the turn's start time in BOTH states (item 3 of the
      // review: "展开和收起时都展示时间戳"). A collapsed turn is one line, so its
      // single time is the question's; the rows' own times come back when it opens.
      const startAt = first.at
      // A refusal happens INSIDE a turn and does not close it, so a folded body
      // hides it completely. Measured on a real session (cc-mvyml3x4-4): Claude
      // was refused permission to write settings.json at 11:04:02, kept going,
      // and the user stopped the turn 43 seconds later — so the turn had no
      // answer either, and the panel showed a heading, "N 步", and nothing else.
      // The refusal was the only thing that had happened.
      const refusals = turn.rows.filter((row) => row.kind === 'denied').length
      const failures = turn.rows.filter((row) => row.kind === 'tool-error' || row.kind === 'api-error').length
      const head = h('button', {
        key: `${key}-head`,
        type: 'button',
        className: 'ccw-turn-head',
        'data-open': isOpen ? 'true' : 'false',
        // Only a real question gets the question style; a cut transcript's orphan
        // turn is labelled and de-emphasised instead.
        'data-user': fromUser ? 'true' : 'false',
        onClick: () => setFolded((previous) => ({ ...previous, [`${selected?.id ?? ''}:${key}`]: isOpen })),
      }, [
        h('span', { key: 'm', className: 'ccw-turn-marker' }, isOpen ? 'v' : '>'),
        h('span', { key: 'c', className: 'ccw-turn-when' }, clock(startAt)),
        h('span', { key: 't', className: 'ccw-turn-text' }, heading),
        refusals > 0
          ? h('span', { key: 'r', className: 'ccw-turn-flag' }, `${String(refusals)} ${t('turnDenied')}`)
          : failures > 0
            ? h('span', { key: 'f', className: 'ccw-turn-flag' }, t('turnFailed'))
            : null,
        // While the turn runs its size is not final, so the heading shows the
        // live clock beside the step count: a folded running turn that shows only
        // "12 steps" looks like a dead one.
        h('span', { key: 's', className: 'ccw-turn-meta' },
          `${String(process.length)} ${t('turnSteps')}${inFlight && !isOpen ? ` · ${t('turnRunning')}` : ''}`),
      ])
      return [
        h('div', { key, className: 'ccw-turn' }, [
          head,
          isOpen ? h('div', { key: `${key}-body`, className: 'ccw-turn-body' }, process) : null,
          answer,
        ]),
      ]
    })

    // The filter hides rows; it never hides the selection, so the right pane keeps
    // showing the item the reader was on even while the rail is narrowed.
    const needle = filter.trim().toLowerCase()
    const visible = needle === ''
      ? items
      : items.filter((item) => `${item.title} ${item.cwd} ${item.state}`.toLowerCase().includes(needle))
    // One rail row: what the work item is, then what it has spent.
    //
    // The second and third lines are the numbers a reader opens the panel for —
    // how far along it is, how much it has cost in tokens, how full its context
    // is, and (while it runs) how long the current turn has been going. They are
    // separate lines rather than one long one because the rail is 244px wide and
    // a single line would truncate exactly the part being scanned for.
    const railRow = (item) => {
      const live = typeof item.turnStartedAt === 'number' && item.turnStartedAt > 0
      const spent = (typeof item.outputTokens === 'number' ? item.outputTokens : 0)
        + (typeof item.inputTokens === 'number' ? item.inputTokens : 0)
        + (typeof item.cacheReadTokens === 'number' ? item.cacheReadTokens : 0)
        + (typeof item.cacheWriteTokens === 'number' ? item.cacheWriteTokens : 0)
      const context = typeof item.contextTokens === 'number' ? item.contextTokens : 0
      const limit = typeof item.contextLimit === 'number' ? item.contextLimit : 0
      // The turn's own clock: the live one counts up, the finished one shows the
      // duration the CLI reported for the last result — the same figure the
      // answer's usage line prints, so the two cannot disagree.
      const lastMs = typeof item.durationMs === 'number' ? item.durationMs : 0
      const clockText = live
        ? elapsed((now > 0 ? now : Date.now()) - item.turnStartedAt)
        : (lastMs > 0 ? seconds(lastMs) : '')
      // A gauge needs both numbers; with no window reported the fraction is
      // unknown, so only the used figure is shown and no bar is drawn.
      const ratio = limit > 0 && context > 0 ? Math.min(1, context / limit) : 0
      return h('button', {
        key: item.id,
        type: 'button',
        className: 'ccw-row',
        'data-active': selected !== null && selected.id === item.id ? 'true' : 'false',
        // The full path, because the row truncates the last segment to fit the
        // 244px rail and two checkouts with the same directory name are otherwise
        // indistinguishable in this list.
        title: item.cwd,
        onClick: () => { readItem(item.id).catch((failure) => setError(String(failure?.message ?? failure))) },
      }, [
        h('span', { key: 'top', className: 'ccw-row-top' }, [
          h('span', { key: 'd', className: 'ccw-dot', 'data-state': item.state }),
          h('span', { key: 't', className: 'ccw-row-title' }, item.title),
          // The clock sits on the title line: while a turn runs it is the only
          // thing on the row that changes every second.
          clockText === ''
            ? null
            : h('span', {
              key: 'clock',
              className: 'ccw-row-clock',
              'data-live': live ? 'true' : 'false',
              title: live ? t('turnElapsed') : t('turnTook'),
            }, clockText),
          // What the session is, at a glance, without opening it: the model is the
          // first thing a reader wants when two sessions run against different
          // endpoints, and it was already on the wire (`init` records it) but only
          // ever shown inside the transcript.
          h('span', {
            key: 'm',
            className: 'ccw-row-model',
            title: item.model === undefined || item.model === '' ? '' : item.model,
          }, shortModel(item.model)),
        ]),
        h('span', { key: 'meta', className: 'ccw-row-meta' },
          // `onNew` names an item after its directory's last segment, so the title
          // and the directory repeat each other. Printing both produced
          // "my-project / my-project · 已结束 · 2 轮" in the list.
          `${item.title === baseName(item.cwd) ? '' : `${baseName(item.cwd)} · `}${stateLabel(t, item.state)} · ${String(item.turns)} ${t('turns')} · ${String(item.steps ?? 0)} ${t('turnSteps')}`),
        spent > 0 || context > 0
          ? h('span', { key: 'usage', className: 'ccw-row-usage' }, [
            spent > 0
              ? h('span', {
                key: 'tok',
                className: 'ccw-row-tok',
                // The rail's numbers are the LAST turn's, not a session total: the
                // CLI's `usage` counter is cumulative per process and a long
                // session pushes it past anything a reader would believe. The
                // tooltip says which turn so the number cannot be misread as a
                // lifetime cost.
                title: t('lastTurnTokens'),
              }, compact(spent))
              : null,
            context > 0
              ? h('span', {
                key: 'ctx',
                className: 'ccw-row-ctx',
                // The exact pair, because the compact form rounds and a reader
                // checking a limit wants the number it rounded.
                title: limit > 0 ? `${compact(context)} / ${compact(limit)}` : '',
              }, [
                h('span', { key: 'l', className: 'ccw-ctx-label' },
                  `${t('context')} ${compact(context)}${limit > 0 ? `/${compact(limit)}` : ''}`),
                limit > 0
                  ? h('span', { key: 'bar', className: 'ccw-ctx-bar' }, [
                    h('span', {
                      key: 'fill',
                      className: 'ccw-ctx-fill',
                      // Amber past 80%, red past 95%: the colours the state rail
                      // already uses for "attention" and "problem".
                      'data-level': ratio >= 0.95 ? 'error' : (ratio >= 0.8 ? 'warn' : 'ok'),
                      // A bar of zero width is invisible; 2% is the smallest
                      // mark that still reads as "some".
                      style: { width: `${String(Math.max(2, Math.round(ratio * 100)))}%` },
                    }),
                  ])
                  : null,
              ])
              : null,
          ])
          : null,
      ])
    }

    const list = items.length === 0
      // The list column is 258px wide; the hint belongs in the detail pane,
      // which is where it has room to read as an instruction.
      ? h('div', { className: 'ccw-empty' }, [h('strong', { key: 'a' }, t('empty'))])
      // A filter that matches nothing must say so: otherwise the rail looks like
      // every work item was deleted.
      : visible.length === 0
        ? h('div', { className: 'ccw-empty' }, [h('span', { key: 'a' }, t('noMatch'))])
        : visible.map(railRow)

    // "Nothing selected" is the state a first-time visitor sees, so it explains
    // what to do rather than repeating the empty list's message — which is what
    // it used to do, verbatim, in the same split view. With no items at all the
    // list column already said "no work items", so the pane only adds the hint.
    /**
     * Which standing notice, if any, belongs above the transcript.
     *
     * Three situations, one banner: a session has to be restarted (finished, or
     * the process died), or it already was and the reader should know how. The
     * restart happened either by resuming the CLI's own conversation or by
     * replaying a text primer, and those are not the same promise — saying
     * "resumed" over a primer would tell the reader the model remembers exchanges
     * it only ever saw as a summary.
     *
     * The reopen banner is dismissed by the first answer of the new session: the
     * row that says "resumed" is followed by a fresh `result` only once the new
     * process has actually replied, so the notice disappears exactly then and not
     * a moment earlier.
     * @param selected - the selected work item projection.
     * @param rows - its transcript rows, newest last.
     * @returns `{ text, tone }` for the banner, or null.
     */
    function bannerFor(selected, rows) {
      const reopenAt = rows.findLastIndex((row) => row.kind === 'reopened')
      if (reopenAt >= 0) {
        // Everything after the reopen row. A `result` there means this process has
        // answered, so the handover notice has done its job.
        const answered = rows.slice(reopenAt + 1).some((row) => row.kind === 'result' || row.kind === 'api-error')
        if (answered) return null
        const resumed = rows[reopenAt].resumed === true
        // The strings are resolved here, not by key, so the locale guard can see
        // every notice in the source and a renamed key cannot survive as a
        // runtime lookup that silently prints the key itself.
        return { text: resumed ? t('resumeNotice') : t('reopenNotice'), tone: 'warn' }
      }
      if (selected.state === 'error') return { text: t('errorNotice'), tone: 'error' }
      // BEFORE it is restarted the composer looks usable against a dead item: the
      // user types, Send is refused with "is not running", and there is no hint
      // that sending is the way back. Say it up front instead.
      if (selected.state === 'done') return { text: t('doneNotice'), tone: 'warn' }
      return null
    }

    // `allowRules` is a comma-joined string on the wire; an empty one means
    // nothing was remembered yet.
    const remembered = selected === null
      ? []
      : String(selected.allowRules ?? '').split(',').map((rule) => rule.trim()).filter((rule) => rule !== '')
    const banner = selected === null ? null : bannerFor(selected, rows)
    const detail = selected === null
      ? h('div', { className: 'ccw-empty' }, items.length === 0
        ? [h('span', { key: 'b' }, t('emptyHint'))]
        : [h('strong', { key: 'a' }, t('pickOne')), h('span', { key: 'b' }, t('pickOneHint'))])
      : h('div', { className: 'ccw-pane' }, [
        h('div', { key: 'head', className: 'ccw-pane-head' }, [
          // The title doubles as the rename control: clicking it opens an input
          // holding the current title, Enter saves, Escape cancels. It is a button
          // and an input rather than always-an-input because the title is the
          // heading a reader scans, not a field to click into by accident.
          renaming === null
            ? h('p', {
              key: 'title',
              className: 'ccw-pane-title ccw-title-edit',
              title: t('rename'),
              onClick: () => setRenaming(String(selected.title ?? '')),
            }, selected.title)
            : h('div', { key: 'title', className: 'ccw-pane-title ccw-title-edit' }, [
              h('input', {
                key: 'input',
                className: 'ccw-input ccw-title-input',
                value: renaming,
                autoFocus: true,
                onChange: (event) => setRenaming(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') { event.preventDefault(); onRename() }
                  if (event.key === 'Escape') { event.preventDefault(); setRenaming(null) }
                },
              }),
              h('button', { key: 'save', type: 'button', className: 'ccw-btn ccw-btn-primary', disabled: busy || String(renaming).trim() === '', onClick: onRename }, t('save')),
              h('button', { key: 'cancel', type: 'button', className: 'ccw-btn', onClick: () => setRenaming(null) }, t('cancel')),
            ]),
          h('div', { key: 'meta', className: 'ccw-pane-meta' }, [
            h('span', { key: 'state', className: 'ccw-badge', 'data-state': selected.state }, stateLabel(t, selected.state)),
            h('span', { key: 'cwd', title: selected.cwd }, `${t('cwd')}: ${selected.cwd}`),
            h('span', { key: 'mode' }, `${t('mode')}: ${selected.mode === 'manual' ? t('modeManual') : t('modeAuto')}`),
            h('span', { key: 'turns' }, `${String(selected.turns)} ${t('turns')}`),
            h('span', { key: 'at' }, `${t('lastActive')}: ${clock(selected.lastActivityAt)}`),
            h('span', { key: 'started' }, `${t('startedAt')}: ${clock(selected.startedAt)}`),
            // Which conversation this is, and what it cost so far. The id is the
            // one field a reader needs outside this panel (to attach, to resume by
            // hand, to find the CLI's own transcript); it used to be reachable
            // only by opening the JSON log.
            selected.sessionId === undefined || selected.sessionId === ''
              ? null
              : h('span', {
                key: 'sid',
                className: 'ccw-pane-sid',
                title: selected.sessionId,
                // Clicking copies: the id is here to be taken somewhere else.
                onClick: () => { copyText(selected.sessionId) },
              }, `${t('sessionId')}: ${shortId(selected.sessionId)}`),
            typeof selected.costUsd === 'number' && selected.costUsd > 0
              ? h('span', { key: 'cost' }, `${t('cost')}: $${selected.costUsd.toFixed(3)}`)
              : null,
          // The controls sit on the meta line, after the session id and the cost
          // they act on, pushed to the right edge. They used to occupy their own
          // full-width strip below the header, which separated two things that
          // describe one object and cost an entire row of vertical space.
          h('span', { key: 'actions', className: 'ccw-pane-actions' }, [
            h('button', {
              key: 'mode',
              type: 'button',
              className: 'ccw-btn',
              disabled: busy || selected.state === 'done',
              onClick: () => run(async () => {
                unwrap(await remote().setMode(selected.id, selected.mode === 'manual' ? 'auto' : 'manual'))
              }),
            }, `${t('switchTo')} ${selected.mode === 'manual' ? t('modeAuto') : t('modeManual')}`),
            h('button', {
              key: 'interrupt',
              type: 'button',
              className: 'ccw-btn',
              disabled: busy || selected.state === 'done',
              onClick: () => run(async () => { unwrap(await remote().interrupt(selected.id)) }),
            }, t('interrupt')),
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'ccw-btn',
              disabled: busy || selected.state === 'done',
              onClick: () => run(async () => { unwrap(await remote().stop(selected.id)) }),
            }, t('stop')),
            // The destructive one is separated from the three recoverable controls
            // and filled with the error colour. De-emphasising it (the previous
            // treatment) made the one irreversible action look like a footnote.
            h('button', {
              key: 'forget',
              type: 'button',
              className: 'ccw-btn ccw-btn-danger',
              disabled: busy || selected.state !== 'done',
              onClick: () => run(async () => {
                unwrap(await remote().forget(selected.id))
                await readItem(null)
              }),
            }, t('forget')),
          ]),
          ]),
        ]),
        // A pending request that carries questions is NOT an approval to grant:
        // Claude is waiting for a choice, and pressing Allow without one is what
        // produced "The user did not answer the questions." So the two render as
        // different cards, and the answer card is the only one that can be sent.
        Array.isArray(selected.pendingQuestions) && selected.pendingQuestions.length > 0
          ? h('div', { key: 'ask', className: 'ccw-ask' }, [
            h('div', { key: 'head', className: 'ccw-ask-head' }, t('askTitle')),
            ...selected.pendingQuestions.map((question, order) => {
              const name = String(question.question ?? '')
              const picked = Array.isArray(picks[name]) ? picks[name] : []
              const multi = question.multiSelect === true
              // Three shapes, all from the tool's own schema: a choice list, a
              // free-text box, and a number stepper. A text/number question has
              // no options at all, so rendering the option list alone would draw
              // an unanswerable card.
              const kind = question.kind === 'text' || question.kind === 'number' ? question.kind : 'choice'
              const note = kind === 'text'
                ? t('askFreeText')
                : kind === 'number'
                  ? t('askNumber')
                  : multi ? t('askPickMany') : t('askPickOne')
              return h('div', { key: `q${String(order)}`, className: 'ccw-ask-q' }, [
                h('div', { key: 'text', className: 'ccw-ask-text' }, [
                  // The header is a short topic ("Format"); the question is the
                  // sentence. Both used to be concatenated into one span, which
                  // put a stray space between them and gave them equal weight.
                  question.header === undefined
                    ? null
                    : h('span', { key: 'q', className: 'ccw-ask-head-label' }, String(question.header)),
                  h('span', { key: 'v' }, name),
                  h('span', { key: 'n', className: 'ccw-ask-note' }, note),
                ]),
                kind === 'choice'
                  ? h('div', { key: 'options', className: 'ccw-ask-options' }, (Array.isArray(question.options) ? question.options : []).map((option, index) => {
                    const label = String(option.label ?? '')
                    return h('label', {
                      key: `o${String(index)}`,
                      className: 'ccw-ask-option',
                      'data-picked': picked.includes(label) ? 'true' : 'false',
                    }, [
                      h('input', {
                        key: 'box',
                        type: multi ? 'checkbox' : 'radio',
                        name: `ask-${String(order)}`,
                        checked: picked.includes(label),
                        onChange: () => onPick(name, label, multi),
                      }),
                      h('span', { key: 'l', className: 'ccw-ask-label' }, label),
                      option.description === undefined
                        ? null
                        : h('span', { key: 'd', className: 'ccw-ask-desc' }, ` ${String(option.description)}`),
                    ])
                  }))
                  : h('div', { key: 'options', className: 'ccw-ask-options' }, [
                    h('input', {
                      key: 'free',
                      type: 'text',
                      className: 'ccw-input ccw-ask-input',
                      value: picked[0] ?? '',
                      placeholder: String(question.placeholder ?? ''),
                      inputMode: kind === 'number' ? 'decimal' : undefined,
                      onChange: (event) => setPicks((previous) => ({
                        ...previous,
                        [name]: event.target.value === '' ? [] : [event.target.value],
                      })),
                    }),
                    kind === 'number' && question.min !== undefined && question.max !== undefined
                      ? h('span', { key: 'range', className: 'ccw-ask-note' },
                        `${String(question.min)}–${String(question.max)}${question.unit === undefined ? '' : ` ${String(question.unit)}`}`)
                      : null,
                  ]),
              ])
            }),
            h('div', { key: 'row', className: 'ccw-approval-row' }, [
              h('button', {
                key: 'send',
                type: 'button',
                // Same amber as the Allow button: both are "the human decides
                // something here", and the card they sit in is outlined in it.
                className: 'ccw-btn ccw-btn-approve',
                disabled: busy || selected.pendingQuestions.some((question) => {
                  const name = String(question.question ?? '')
                  return !(Array.isArray(picks[name]) && picks[name].length > 0)
                }),
                onClick: onAnswer,
              }, t('askSend')),
              h('button', {
                key: 'deny',
                type: 'button',
                className: 'ccw-btn',
                disabled: busy,
                onClick: () => run(async () => { unwrap(await remote().deny(selected.id, undefined)) }),
              }, t('deny')),
            ]),
          ])
          : selected.pendingApproval === undefined || selected.pendingApproval === ''
            ? null
            : h('div', { key: 'approval', className: 'ccw-approval' }, [
              h('div', { key: 'label', className: 'ccw-approval-label' }, t('pending')),
              h('div', { key: 'tool', className: 'ccw-approval-tool' }, selected.pendingApproval),
              h('div', { key: 'row', className: 'ccw-approval-row' }, [
                h('button', {
                  key: 'allow',
                  type: 'button',
                  // Item 1 of the review: the decision button takes the card's own
                  // amber instead of the generic near-black "primary" fill, so the
                  // button and the box it belongs to read as one object.
                  className: 'ccw-btn ccw-btn-approve',
                  disabled: busy,
                  onClick: onApprove,
                }, t('approve')),
                h('button', {
                  key: 'deny',
                  type: 'button',
                  className: 'ccw-btn',
                  disabled: busy,
                  // `message` is optional on the wire but still POSITIONAL: the
                  // gateway counts arguments and refuses a short call with
                  // "expected 2 argument(s), got 1". Pass `undefined` to decline
                  // without a reason — it is dropped before serialising.
                  onClick: () => run(async () => { unwrap(await remote().deny(selected.id, undefined)) }),
                }, t('deny')),
                h('label', { key: 'remember', className: 'ccw-check' }, [
                  h('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: remember,
                    onChange: (event) => setRemember(event.target.checked),
                  }),
                  t('approveRemember'),
                ]),
              ]),
              // "Always allow" is a Host-side memory, not a CLI permission mode, and
              // the tick box says nothing about which tools were remembered earlier.
              // This line is the only place the reader can see that list without
              // opening the event log.
              remembered.length > 0
                ? h('div', { key: 'rules', className: 'ccw-allow-rules' }, `${t('allowedTools')}: ${remembered.join(' · ')}`)
                : null,
            ]),
        // Item 5 of the review: a reopened session must say so on screen. Which
        // SENTENCE depends on how it was reopened — a resumed process owns the
        // conversation above, a primed one only carries a summary of it — and the
        // Host says which on the row instead of leaving the panel to parse the
        // description. The banner hides once the new session has answered: after
        // that the transcript speaks for itself, and a standing warning reads as
        // "something is still wrong".
        // Two literal class names rather than one interpolated string: the CSS
        // guard reads class names out of the source, and a template literal hides
        // them from it.
        banner === null
          ? null
          : banner.tone === 'error'
            ? h('div', { key: 'reopen', className: 'ccw-reopen ccw-reopen-error' }, banner.text)
            : h('div', { key: 'reopen', className: 'ccw-reopen' }, banner.text),
        // The failure banner is rendered ONCE, in the head (`ccw-error-head`)
        // below. It used to be drawn here too, so every failed action printed the
        // same sentence twice, one line apart. It stays in the head because
        // before a selection this pane is an empty state — exactly the moment a
        // Host that cannot be reached matters most.
        h('div', {
          key: 'log',
          className: 'ccw-log',
          ref: logRef,
          // Within 24px of the bottom counts as "following"; anything further up
          // means the reader is looking at history, so new rows must not move it.
          onScroll: (event) => {
            const node = event.target
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          },
        }, log.length === 0 ? [h('div', { key: 'none', className: 'ccw-row-meta' }, t('noTranscript'))] : log),
        h('div', {
          key: 'composer',
          className: 'ccw-composer',
          'data-dropping': dropping ? 'true' : 'false',
          // Dropping anywhere on the composer works, not only on the textarea:
          // the natural target for a dragged screenshot is the box you type in.
          onDragOver: (event) => { event.preventDefault(); setDropping(true) },
          onDragLeave: () => setDropping(false),
          onDrop,
        }, [
          attachments.length === 0
            ? null
            : h('div', { key: 'attachments', className: 'ccw-attach-strip' }, attachments.map((entry) => h('div', {
              key: entry.id,
              className: 'ccw-attach',
              title: entry.name,
            }, [
              // `src` is empty while the file is still decoding; the placeholder
              // keeps the strip's height steady.
              entry.url === ''
                ? null
                : h('img', { key: 'img', src: entry.url, alt: entry.name }),
              h('button', {
                key: 'x',
                type: 'button',
                className: 'ccw-attach-remove',
                title: t('attachRemove'),
                onClick: () => removeAttachment(entry.id),
              }, '×'),
            ]))),
          attachError === ''
            ? null
            : h('div', { key: 'attach-error', className: 'ccw-attach-error' }, attachError),
          h('div', { key: 'row', className: 'ccw-composer-input' }, [
            h('textarea', {
              key: 'input',
              className: 'ccw-input',
              value: draft,
              placeholder: attachments.length === 0 ? t('placeholder') : t('attachHint'),
              onChange: (event) => setDraftText(event.target.value),
              onPaste,
              onKeyDown: (event) => {
                // Escape closes the menu before it means anything else: while the
                // list is open it is the topmost thing on screen, and a key that
                // does nothing is worse than one that dismisses.
                if (event.key === 'Escape' && commandsOpen) {
                  event.preventDefault()
                  toggleCommands()
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onSend()
                }
              },
            }),
            // The command menu. Its own box, not an entry in the row's flex
            // sequence, because the popup has to be positioned against it.
            h('div', { key: 'commands', className: 'ccw-cmd' }, [
              h('button', {
                key: 'open',
                type: 'button',
                className: 'ccw-btn',
                'data-open': commandsOpen ? 'true' : 'false',
                // A missing selection disables the entries below (there is no
                // session to send anything to); the button itself stays live so
                // the reader can still see what the menu offers.
                title: t('cmdTitle'),
                onClick: toggleCommands,
              }, t('cmdButton')),
              commandsOpen
                ? h('div', { key: 'menu', className: 'ccw-cmd-menu' }, [
                  h('div', { key: 'title', className: 'ccw-cmd-title' }, t('cmdTitle')),
                  // The armed warning goes FIRST, above the entries, so the
                  // second click lands on the entry it is about rather than
                  // needing a third control somewhere else.
                  pendingCommand === ''
                    ? null
                    : h('div', { key: 'warn', className: 'ccw-cmd-warn' }, t('cmdClearWarn')),
                  ...COMMANDS.map((entry) => h('button', {
                    key: entry.slash,
                    type: 'button',
                    // One literal class name, and the danger flag as a data
                    // attribute: the CSS guard reads class names out of the
                    // source, and an interpolated one would be invisible to it.
                    className: 'ccw-cmd-item',
                    'data-danger': entry.confirms === true ? 'true' : 'false',
                    disabled: busy || selected === null,
                    onClick: () => onCommand(entry),
                  }, [
                    h('span', { key: 'n', className: 'ccw-cmd-name' }, `/${entry.slash}`),
                    h('span', { key: 'd', className: 'ccw-cmd-desc' },
                      entry.confirms === true && pendingCommand === entry.slash ? t('cmdFill') : t(entry.key)),
                  ])),
                  // The list is deliberately short; say what the box still
                  // understands, so nobody concludes the panel dropped the rest.
                  h('div', { key: 'more', className: 'ccw-cmd-more' }, t('cmdMore')),
                ])
                : null,
            ]),
            h('button', {
              key: 'send',
              type: 'button',
              className: 'ccw-btn ccw-btn-primary',
              // An image alone is a legal turn, so the button enables on either.
              // A placeholder still decoding does not count: sending it would put
              // an empty payload on the wire.
              disabled: busy || (draft.trim() === '' && !attachments.some((entry) => entry.data !== '')),
              onClick: onSend,
            }, t('send')),
          ]),
        ]),
      ])

    return h('div', { className: 'ccw-root' }, [
      h('style', { key: 'css' }, CSS),
      h('div', { key: 'head', className: 'ccw-head' }, [
        h('div', { key: 'text', className: 'ccw-head-text' }, [
          h('p', { key: 'title', className: 'ccw-title' }, t('title')),
          h('p', { key: 'sub', className: 'ccw-subtitle' }, t('subtitle')),
        ]),
        h('button', { key: 'new', type: 'button', className: 'ccw-btn ccw-btn-primary', disabled: busy, onClick: onNew }, t('newItem')),
      ]),
      // The Head failure banner is deliberately outside the detail pane: before a
      // work item is selected the detail pane shows an empty state, and an error
      // rendered in there would be invisible — exactly the case that matters most,
      // a Host that cannot be reached at all.
      error === '' ? null : h('div', { key: 'error', className: 'ccw-error ccw-error-head' }, error),
      h('div', { key: 'body', className: 'ccw-body' }, [
        h('div', { key: 'list', className: 'ccw-list' }, [
          // Only worth a control once there are enough rows to scan.
          items.length > 1
            ? h('input', {
              key: 'filter',
              type: 'search',
              className: 'ccw-input ccw-filter',
              value: filter,
              placeholder: t('filter'),
              onChange: (event) => setFilter(event.target.value),
            })
            : null,
          h('div', { key: 'rows', className: 'ccw-rows' }, list),
        ]),
        h('div', { key: 'detail', className: 'ccw-detail' }, detail),
      ]),
    ])
    } catch (failure) {
      // Anything that escaped the state machine above still has to be visible.
      return h('div', { className: 'ccw-root' }, [
        h('style', { key: 'css' }, CSS),
        h('p', { key: 'title', className: 'ccw-title' }, 'Claude Code work items'),
        h('div', { key: 'error', className: 'ccw-error' }, String(failure?.message ?? failure)),
      ])
    }
  }
}

/** The 18px sidebar glyph: two stacked session cards with a state dot. */
function ClaudeSessionsIcon(props) {
  const size = Number(props?.size ?? 18)
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { display: 'block' },
  }, [
    h('rect', { key: 'back', x: 4, y: 3, width: 15, height: 9, rx: 2.4, opacity: 0.45 }),
    h('rect', { key: 'front', x: 5, y: 11.5, width: 15, height: 9, rx: 2.4 }),
    h('path', { key: 'line', d: 'M8.2 16h4.6' }),
    h('circle', { key: 'dot', cx: 16.3, cy: 16, r: 1.25, fill: 'currentColor', stroke: 'none' }),
  ])
}

// -------------------------------------------------------------------- plugin

/**
 * Mount this package's Host Remote namespace, then contribute the panel.
 * @param ctx - the Client plugin context.
 */
async function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, DICT), 'claude-sessions: dictionaries')

  // The Client reaches the Host service only through a mounted contribution: the
  // gateway resolves every endpoint against the descriptors registered here.
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount, 'claude-sessions: Remote namespace')

  // `$mount` installs a Cordis Service named `remote.<namespace>`, and Cordis
  // throws on reading a service the plugin never injected ?`remote` alone is
  // not enough, so `ctx.remote.claudeSessions` throws. The full key cannot join
  // this module's static `inject` either: `apply` is what creates the service,
  // so the plugin would wait on itself. Run the UI half as a child plugin that
  // injects the installed key, which is what the shipped feature packages
  // (voice-input, cot-translation) do with their own Remote surfaces.
  await ctx.inject([REMOTE_KEY, 'slots', 'locale', 'uiWorkspace'], applyPanel)
}

/**
 * The UI half: sidebar entry and main panel.
 * @param ctx - the child context, injecting the mounted namespace key.
 */
function applyPanel(ctx) {
  // Read the namespace once, here, so a broken mount fails this plugin loudly
  // instead of throwing later inside React's render, where the outlet's error
  // boundary abdicates the occupant and the page simply goes blank. Property
  // access is legal because this child plugin injected `remote.claudeSessions`
  // — the same shape the shipped voice-input package uses for `remote.speech`.
  const namespace = ctx.remote[NS]
  if (namespace === undefined) throw new Error(`${REMOTE_KEY} is injected but absent`)

  const Page = createPage(ctx, () => namespace)

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => ctx.locale.bind(NS)('panel'),
    locale: NS,
  }, ClaudeSessionsIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, Page))
}

return { name: 'claude-sessions-client', inject, apply }
