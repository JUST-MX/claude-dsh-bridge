// Does the CLI emit ANY protocol record while it is retrying a dead endpoint?
//
// Why this matters: the panel showed "运行中" with no rows for minutes while Claude
// Code was retrying in the background, and the user could only see the retries in
// their own terminal. Whether that is the panel's fault depends entirely on this
// question — if the SDK stream carries a retry record, the panel must render it; if
// it carries nothing, the panel can only show elapsed silence.
//
// An earlier attempt set ANTHROPIC_BASE_URL in the child's environment and got a
// normal answer, because `~/.claude/settings.json` has an `env` block and settings
// env wins over the process env. Faking a dead endpoint therefore needs a whole
// config directory, not one variable — CLAUDE_CONFIG_DIR does that without touching
// the real settings.
//
// Run: node tools/probe-retry.mjs
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '.research', 'retry')
const home = join(outDir, 'home')
mkdirSync(home, { recursive: true })

// A config whose endpoint refuses connections immediately: the retry loop then runs
// fast, so this measures the record shapes rather than the backoff schedule.
const real = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.claude', 'settings.json'), 'utf8'))
writeFileSync(join(home, 'settings.json'), JSON.stringify({
  env: {
    ...real.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_AUTH_TOKEN: 'sk-dead-endpoint-probe',
  },
  permissions: real.permissions ?? {},
}, null, 2), 'utf8')

const CLI = `${process.env.USERPROFILE}\\.local\\bin\\claude.exe`
const stdinPath = join(outDir, 'in.jsonl')
const stdoutPath = join(outDir, 'out.jsonl')
const stderrPath = join(outDir, 'err.txt')

writeFileSync(stdinPath, `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'say hi' },
})}\n`, 'utf8')

const inHandle = openSync(stdinPath, 'r')
const outHandle = openSync(stdoutPath, 'w')
const errHandle = openSync(stderrPath, 'w')

const child = spawn(CLI, [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'auto',
  '--permission-prompt-tool', 'stdio',
], {
  cwd: process.cwd(),
  stdio: [inHandle, outHandle, errHandle],
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    // The first-byte wait is what turns a dead endpoint into a multi-minute hang.
    CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '3000',
    // Keep the retry schedule inside the probe's lifetime.
    CLAUDE_CODE_MAX_RETRIES: '2',
  },
})

const started = Date.now()
const TIMEOUT_MS = 90_000
const timer = setTimeout(() => {
  console.log(`probe-retry: killing after ${String(TIMEOUT_MS)}ms`)
  child.kill()
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  closeSync(inHandle)
  closeSync(outHandle)
  closeSync(errHandle)
  console.log(`probe-retry: exit code=${String(code)} signal=${String(signal)} after ${String(Date.now() - started)}ms`)
  report()
})

child.on('error', (failure) => {
  clearTimeout(timer)
  console.log(`probe-retry: spawn failed — ${String(failure)}`)
})

/** Print every stdout record, grouped by type/subtype, plus stderr. */
function report() {
  const out = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : ''
  const err = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : ''
  const lines = out.split('\n').filter((line) => line.trim() !== '')
  console.log(`probe-retry: ${String(lines.length)} stdout line(s)`)
  const kinds = new Map()
  for (const line of lines) {
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const key = `${String(parsed.type)}${parsed.subtype === undefined ? '' : `/${String(parsed.subtype)}`}`
    kinds.set(key, (kinds.get(key) ?? 0) + 1)
  }
  for (const [key, count] of kinds) console.log(`  ${key} × ${String(count)}`)
  console.log('')
  console.log('--- raw stdout ---')
  for (const line of lines) console.log(line.slice(0, 600))
  console.log('')
  console.log(`--- stderr (${String(err.length)} chars, first 3000) ---`)
  console.log(err.slice(0, 3000))
}
