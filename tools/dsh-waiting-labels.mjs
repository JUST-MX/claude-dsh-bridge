// Print the DSH chat surface's own waiting/working vocabulary.
//
// The panel is about to show "reconnecting / waiting for the API" instead of
// looking frozen. Using the chat surface's existing words means the two views of
// the same session do not describe the same state differently.
//
// Run: node tools/dsh-waiting-labels.mjs
import { readFileSync } from 'node:fs'

const source = readFileSync('.research/chat-client.txt', 'utf8')

const wanted = /(waiting|thinking|elapsed|stalled|reconnect|retry|retrying|generating)/i
const seen = new Set()
for (const match of source.matchAll(/"(message\.[A-Za-z0-9.]+)":\s*"([^"]*)"/g)) {
  if (!wanted.test(match[1])) continue
  seen.add(`${match[1]} = ${match[2]}`)
}
for (const line of [...seen].sort()) console.log(line)
console.log(`\n${String(seen.size)} key(s)`)

// Anything in the global (non-message) namespace too.
const other = new Set()
for (const match of source.matchAll(/"(clock\.[A-Za-z0-9.]+|duration\.[A-Za-z0-9.]+)":\s*"([^"]*)"/g)) {
  other.add(`${match[1]} = ${match[2]}`)
}
console.log('')
for (const line of [...other].sort()) console.log(line)
