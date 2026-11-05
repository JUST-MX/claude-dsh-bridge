// Does the CLI tell an SDK host that the API is unreachable and it is retrying?
//
// The panel showed "运行中" with no rows for minutes while Claude Code was in fact
// retrying in the background — the user could only see that in their own terminal,
// not in this panel. This looks for the hook where the CLI decides to keep waiting,
// and asks one question of the code around it: is anything written to the output
// stream, or does the wait happen entirely inside the transport?
//
// Run: node tools/find-retry.mjs
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const CLI = `${process.env.USERPROFILE}\\.local\\bin\\claude.exe`
const CHUNK = 8 * 1024 * 1024
const OVERLAP = 4096
const size = statSync(CLI).size
const handle = openSync(CLI, 'r')
const buffer = Buffer.alloc(CHUNK + OVERLAP)

// Every name that could be the place a retry becomes visible to a host. The order
// matters: the first two are the ones that would carry a protocol record.
const NEEDLES = [
  'persistent_retry',
  'Retrying in',
  'retryAttempt',
  'maxRetries',
  'isNetworkDown',
  'stillDown',
]
const found = new Map(NEEDLES.map((needle) => [needle, []]))

let offset = 0
while (offset < size) {
  const read = readSync(handle, buffer, 0, buffer.length, offset)
  if (read <= 0) break
  for (const needle of NEEDLES) {
    const target = Buffer.from(needle, 'latin1')
    let from = 0
    for (;;) {
      const at = buffer.indexOf(target, from)
      if (at < 0 || at >= read) break
      const list = found.get(needle)
      if (list.length < 3) {
        list.push(buffer
          .subarray(Math.max(0, at - 600), Math.min(read, at + 600))
          .toString('latin1')
          .replace(/[^\x20-\x7e]/g, '·'))
      }
      from = at + 1
    }
  }
  const step = read - OVERLAP
  if (step <= 0) break
  offset += step
}
closeSync(handle)

for (const needle of NEEDLES) {
  console.log(`######## ${needle} ########`)
  const list = found.get(needle)
  if (list.length === 0) console.log('(absent)')
  for (const window of list) {
    console.log(`  …${window}…`)
    console.log('')
  }
}
