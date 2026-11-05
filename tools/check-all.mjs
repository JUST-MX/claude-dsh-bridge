// One command that runs every guard.
//
// Each guard lives in its own file because each one needs a different fake
// world (a browser, a Host context, a bundle on disk). Running them all is the
// only thing they share, so this file just sequences them and reports a single
// verdict.
//
// Run: node tools/check-all.mjs

import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url)

/** Each guard, in the order a human would want to read the failures. */
const GUARDS = [
  { name: 'syntax: host', command: process.execPath, args: ['--check', 'plugin/packages/claude-sessions/index.js'] },
  { name: 'syntax: client', command: process.execPath, args: ['--check', 'plugin/packages/claude-sessions/client.js'] },
  // Before the CSS check, and separately: a backtick inside a CSS comment ends the
  // template literal early, and the resulting syntax error names an unrelated line.
  // It has happened four times, always in a comment quoting a custom-property name.
  { name: 'css template', command: process.execPath, args: ['tools/find-backtick.mjs'] },
  { name: 'css integrity', command: process.execPath, args: ['tools/check-css.mjs'] },
  { name: 'text integrity', command: process.execPath, args: ['tools/scan-text.mjs'] },
  { name: 'text integrity selftest', command: process.execPath, args: ['tools/scan-text.mjs', '--self-test'] },
  { name: 'theme tokens', command: process.execPath, args: ['tools/check-theme.mjs'] },
  { name: 'locale coverage', command: process.execPath, args: ['tools/check-locale.mjs'] },
  { name: 'wire contract', command: process.execPath, args: ['tools/check-remote.mjs'] },
  { name: 'render', command: process.execPath, args: ['tools/render-client.mjs'] },
  { name: 'click-through', command: process.execPath, args: ['tools/click-through.mjs'] },
  // After click-through: the Markdown parser is exercised through the same mount,
  // and its failures read best right after the control-level ones.
  { name: 'markdown', command: process.execPath, args: ['tools/markdown-test.mjs'] },
  // Last, because it is the slowest (a headless browser per scenario) and it
  // catches the class of bug the Node harnesses cannot see at all: a rule that
  // never wins the cascade, and a composer that never receives a paste.
  { name: 'live UI', command: process.execPath, args: ['tools/live-ui-test.mjs'] },
  { name: 'host behaviour', command: process.execPath, args: ['tools/host-test.mjs'] },
]

const results = []
for (const guard of GUARDS) {
  const started = Date.now()
  // `stdio: 'inherit'` rather than a captured pipe: the Windows sandbox forbids
  // opening the named pipes that a piped spawn needs (EPERM), so a capturing
  // runner reports every guard as failed without ever starting one. Inheriting
  // the console also means each guard's own PASS/FAIL lines reach the terminal,
  // which is what makes a failure readable.
  const run = spawnSync(guard.command, guard.args, { cwd: root, stdio: 'inherit' })
  const ok = run.status === 0
  results.push({ name: guard.name, ok, ms: Date.now() - started })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${guard.name.padEnd(16)} ${String(Date.now() - started).padStart(5)}ms`)
}

const failed = results.filter((result) => !result.ok)
console.log('')
if (failed.length === 0) {
  console.log(`ALL OK — ${String(results.length)} guards, ${String(results.reduce((total, r) => total + r.ms, 0))}ms`)
} else {
  console.log(`${String(failed.length)}/${String(results.length)} guard(s) failed: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
