// Read the panel's single dictionary (the `const DICT = { … }` literal in
// src/client-body.js) as plain data.
//
// Two consumers need it: `gen-locale.mjs` writes the package's locale/*.json
// files from it, and `check-remote.mjs` fails the build when those two copies
// disagree. It lives here rather than in gen-locale.mjs so importing it has no
// side effect — the generator writes files, the checker must not.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the browser-half source that owns the dictionary. */
export const BODY_PATH = join(here, '..', 'plugin', 'packages', 'claude-sessions', 'src', 'client-body.js')

/**
 * Evaluate the DICT literal out of the panel body.
 * @param text - the body source; defaults to reading the file.
 * @returns the parsed dictionaries, keyed by locale id.
 */
export function readDict(text = readFileSync(BODY_PATH, 'utf8')) {
  const start = text.indexOf('const DICT = {')
  if (start < 0) throw new Error('src/client-body.js no longer declares `const DICT = {`')
  // Walk braces so a nested object cannot end the literal early.
  let depth = 0
  let quote = ''
  let index = text.indexOf('{', start)
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const literal = text.slice(text.indexOf('{', start), index + 1)
  return new Function(`return ${literal}`)()
}

/** The metadata DSH shows on the plugin page; not part of the panel's runtime set. */
export const META = {
  en: {
    title: 'Claude Code Sessions',
    description: 'Manage the Claude Code work items opened inside DeepSeek Harness: resident sessions, their live state, their transcript, and their tool approvals.',
  },
  zh: {
    title: 'Claude Code 会话',
    description: '集中管理在 DeepSeek Harness 内打开的 Claude Code 工作项：常驻会话、实时状态、对话记录与工具批准。',
  },
}
