// Guard the constraints that are invisible until runtime.
//
// 1. Method names. The Client gateway builds a Cordis Service per Remote
//    namespace and installs each descriptor's method onto it. It refuses any
//    name the service already carries — its own fields (`ctx`, `empty`,
//    `invokeRemote`, `methods`, `name`, `namespace`), its prototype methods
//    (`add`, `has`, `install`, `installDirect`, `installScoped`, `remove`,
//    `assertMethodAvailable`), or anything `in` resolves. A collision throws
//    inside `ctx.remote.$mount()`, and because `apply()` mounts before it
//    registers a single slot, the failure mode is "the panel silently never
//    appears" rather than a visible error.
//
// 2. Face agreement. Both generated faces plus the Host service and every
//    Client call site must describe one and the same surface.
//
//   node tools/check-remote.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { API, PACKAGE, SERVICE } from './api-spec.mjs'

/** Field and method names the namespace service already owns. */
const RESERVED = new Set([
  'ctx',
  'empty',
  'invokeRemote',
  'methods',
  'name',
  'namespace',
  'assertMethodAvailable',
  'add',
  'has',
  'install',
  'installDirect',
  'installScoped',
  'remove',
  'constructor',
])

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'plugin', 'packages', 'claude-sessions')
const failures = []
const declared = API.map((call) => call.method)

const load = async (name) => import(pathToFileURL(join(pkgDir, name)).href)
const { TYPERT } = await load('typert.js')
const { TYPERT_REMOTE } = await load('remote.js')

// 1. The spec itself must avoid the reserved set.
for (const method of declared) {
  if (RESERVED.has(method)) {
    failures.push(`api-spec.mjs: "${method}" collides with a method the Remote namespace service already has`)
  }
}
const duplicates = declared.filter((method, index) => declared.indexOf(method) !== index)
for (const method of duplicates) failures.push(`api-spec.mjs: "${method}" is declared twice`)

// 2. Both generated faces must carry exactly the declared surface.
const compare = (label, methods) => {
  for (const method of methods) {
    if (RESERVED.has(method)) failures.push(`${label}: emits reserved method "${method}"`)
    if (!declared.includes(method)) failures.push(`${label}: emits "${method}", which api-spec.mjs does not declare`)
  }
  for (const method of declared) {
    if (!methods.includes(method)) failures.push(`${label}: missing method "${method}"`)
  }
}

if (TYPERT.package !== PACKAGE) failures.push(`typert.js: package is ${JSON.stringify(TYPERT.package)}, expected ${JSON.stringify(PACKAGE)}`)
if (TYPERT.face !== 'host') failures.push('typert.js: face must be "host"')
compare('typert.js', TYPERT.invocations.map((invocation) => invocation.method))
for (const invocation of TYPERT.invocations) {
  if (invocation.service !== SERVICE) failures.push(`typert.js: ${invocation.id} names service ${JSON.stringify(invocation.service)}`)
  if (invocation.namespace !== SERVICE) failures.push(`typert.js: ${invocation.id} names namespace ${JSON.stringify(invocation.namespace)}`)
  if (invocation.invocation?.kind !== 'direct') failures.push(`typert.js: ${invocation.id} must use a direct receiver`)
  if (invocation.result?.mode !== 'strict') failures.push(`typert.js: ${invocation.id} result must be a strict codec`)
  for (const parameter of invocation.parameters) {
    if (parameter.codec?.mode !== 'strict') failures.push(`typert.js: ${invocation.id} parameter ${parameter.wire} must be a strict codec`)
    if (parameter.source !== 'json') failures.push(`typert.js: ${invocation.id} parameter ${parameter.wire} must read from JSON`)
    if (parameter.acceptsUndefined === true && parameter.codec?.mode !== 'strict') {
      failures.push(`typert.js: ${invocation.id} optional parameter ${parameter.wire} still needs a strict codec`)
    }
  }
}

if (TYPERT_REMOTE.package !== PACKAGE) failures.push('remote.js: package label mismatch')
compare('remote.js', TYPERT_REMOTE.descriptors.map((descriptor) => descriptor.method))

// 3. Every Client call site must name a declared method AND supply exactly the
//    positional arguments its descriptor declares.
//
//    Optionality is a wire allowance, not a calling convention: the gateway
//    counts arguments (`prepareInvocation` compares `values.length` against
//    `descriptor.parameters.length`) and rejects a short call outright with
//    "expected 2 argument(s), got 1" — it never rejects at runtime for a reason
//    the panel can show. So `deny(id)` without the optional `message` is a bug,
//    not a shorthand, and this check is what catches it before a browser does.
const body = readFileSync(join(pkgDir, 'src', 'client-body.js'), 'utf8')
const called = [...body.matchAll(/remote\(\)\.([A-Za-z0-9_]+)\(/g)].map((match) => match[1])
for (const method of called) {
  if (!declared.includes(method)) failures.push(`src/client-body.js: calls remote().${method}(), which api-spec.mjs does not declare`)
}
for (const method of declared) {
  if (!called.includes(method)) failures.push(`src/client-body.js: never calls ${method}(), so the panel cannot reach it`)
}

/** Split one argument list on its top-level commas, respecting nesting and strings. */
function splitArguments(text) {
  const args = []
  let depth = 0
  let quote = ''
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      current += char
      if (char === '\\') { current += text[index + 1] ?? ''; index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; continue }
    if (char === '(' || char === '[' || char === '{') { depth += 1; current += char; continue }
    if (char === ')' || char === ']' || char === '}') { depth -= 1; current += char; continue }
    if (char === ',' && depth === 0) { args.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') args.push(current.trim())
  return args
}

for (const match of body.matchAll(/remote\(\)\.([A-Za-z0-9_]+)\(/g)) {
  const method = match[1]
  const spec = API.find((call) => call.method === method)
  if (spec === undefined) continue
  // Walk from the opening parenthesis to its match, quoting included.
  const start = match.index + match[0].length
  let depth = 1
  let quote = ''
  let end = start
  for (; end < body.length; end += 1) {
    const char = body[end]
    if (quote !== '') {
      if (char === '\\') { end += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '(') depth += 1
    else if (char === ')') { depth -= 1; if (depth === 0) break }
  }
  const args = splitArguments(body.slice(start, end))
  if (args.length !== spec.params.length) {
    const names = spec.params.map((parameter) => parameter.wire).join(', ')
    failures.push(
      `src/client-body.js: remote().${method}() passes ${String(args.length)} argument(s) but the descriptor takes ${String(spec.params.length)} (${names}) — pass undefined for an absent optional value`,
    )
  }
}

// 4. The Host service must expose exactly one binding-consistent namespace.
const host = readFileSync(join(pkgDir, 'index.js'), 'utf8')
if (!/serviceKey: SERVICE, namespace: SERVICE/.test(host)) {
  failures.push('index.js: the typertRemote binding must name the same key and namespace as SERVICE')
}
for (const method of declared) {
  const wired = method === 'forget'
    ? /forget: remove,/.test(host)
    : new RegExp(`^ {4}${method},$`, 'm').test(host)
  if (!wired) failures.push(`index.js: the service object does not expose "${method}"`)
}

// 5. The locale files must be the DICT, and must be valid JSON.
//
//    Two copies of the same strings exist by necessity: the bundle carries its
//    own dictionaries (the module loader exposes no file reader), while DSH's
//    plugin page reads `<package>/locale/<id>.json`. They had drifted — both
//    files were mojibake and no longer parsed, so every Chinese label was
//    garbage and the plugin title was unreadable. One source, one generator,
//    and this check.
const { readDict } = await import('./dict.mjs')
const dict = readDict()
for (const id of ['en', 'zh']) {
  const file = join(pkgDir, 'locale', `${id}.json`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`locale/${id}.json is not valid JSON (${error.message}) — run node tools/gen-locale.mjs`)
    continue
  }
  if (typeof parsed.meta?.title !== 'string' || parsed.meta.title === '') {
    failures.push(`locale/${id}.json: meta.title is missing — DSH shows it as the plugin name`)
  }
  const source = dict[id] ?? {}
  for (const key of Object.keys(source)) {
    if (parsed[key] !== source[key]) {
      failures.push(`locale/${id}.json: "${key}" is ${JSON.stringify(parsed[key])}, src/client-body.js DICT has ${JSON.stringify(source[key])} — run node tools/gen-locale.mjs`)
    }
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'meta') continue
    if (!(key in source)) failures.push(`locale/${id}.json: "${key}" is not in src/client-body.js DICT`)
  }
}

if (failures.length > 0) {
  console.error(`check-remote: ${String(failures.length)} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`check-remote: ${String(declared.length)} methods — no reserved-name collisions, both faces, the Host service, and every Client call site agree`)
