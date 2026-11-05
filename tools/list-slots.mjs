// List the conversation-surface slot names from the saved full inspect output.
//
// The full `Slots.listSubTree` result is ~25 KB of JSON, which is too much to hold
// in a conversation; this reads the spilled copy and prints only what a
// conversation-UI question needs: the slot names, their kinds, and the values the
// owner already occupies. Scratch tool — delete when the question is answered.
//
// Run: node tools/list-slots.mjs <spill-file>
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (path === undefined) throw new Error('usage: node tools/list-slots.mjs <spilled-listSubTree.txt>')
const text = readFileSync(path, 'utf8')

// The spill is a pretty-printed inspect envelope; entries are objects with
// "name"/"kind"/"purpose" keys, so a structural scan beats a regex here.
const start = text.indexOf('{')
const parsed = JSON.parse(text.slice(start).replace(/\s*\[exit code[^\]]*\]\s*$/u, ''))
const trees = parsed?.data?.trees ?? []
const seen = new Set()
const walk = (node, depth) => {
  if (node?.type === 'slot' && !seen.has(node.name)) {
    seen.add(node.name)
    const occupied = node.allowedKeys === undefined ? '' : ` allowed=${JSON.stringify(node.allowedKeys.map((k) => k.value))}`
    console.log(`${'  '.repeat(depth)}${node.name} [${node.kind}] risk=${node.replaceRisk}${occupied}`)
  }
  if (node?.type === 'slot' && seen.has(node.name) && depth > 0) return
  for (const child of node?.children ?? []) walk(child, depth + 1)
}
for (const tree of trees) walk(tree, 0)

const factories = trees.filter((tree) => tree.type === 'factory').map((tree) => tree.name)
if (factories.length > 0) console.log(`\nfactory slots: ${factories.join(', ')}`)
