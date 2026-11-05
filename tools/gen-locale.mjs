// Regenerate package locale/*.json from the single DICT in src/client-body.js.
//
// The bundle carries its own dictionaries (it must: the module loader exposes no
// locale file reader), but DSH's plugin page reads `<package>/locale/<id>.json`
// for the human-facing title and description. Those two copies drifted — both
// files had been round-tripped through a GBK console at some point, so they were
// mojibake AND no longer valid JSON: every Chinese label was garbage and the
// plugin's own display name could not be parsed.
//
// So: one source (the DICT), one generator, and `check-remote.mjs` fails if the
// files ever disagree again.
//
//   node tools/gen-locale.mjs
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDict, META } from './dict.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'plugin', 'packages', 'claude-sessions')

const dict = readDict()

for (const id of ['en', 'zh']) {
  const entries = dict[id]
  if (entries === undefined) throw new Error(`src/client-body.js DICT has no "${id}" table`)
  const out = { meta: META[id], ...entries }
  // `JSON.stringify` with an explicit indent is byte-stable, so a regenerate
  // that changes nothing produces no diff.
  writeFileSync(join(pkgDir, 'locale', `${id}.json`), `${JSON.stringify(out, null, 2)}\n`)
  console.log(`locale/${id}.json — ${String(Object.keys(out).length)} keys`)
}

console.log(`generated locale files for ${String(Object.keys(dict.en).length)} panel keys`)
