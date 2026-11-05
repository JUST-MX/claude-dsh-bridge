// Minimal ASAR reader for the DeepSeek Harness installation, kept in the
// workspace so later archaeology does not have to re-derive the header format.
//
// Usage:
//   node tools/asar-extract.mjs list  <path/in/asar>            list one directory
//   node tools/asar-extract.mjs cat   <path/in/asar> <outFile>   write one file out
//   node tools/asar-extract.mjs find  <regex>                   match file paths
//
// The header layout (verified against dsh 0.2.1-rc.3):
//   bytes 0-3   uint32 LE = 4
//   bytes 4-7   uint32 LE = header pickle size   ← data base = 8 + this
//   bytes 8-11  uint32 LE = header payload size
//   bytes 12-15 uint32 LE = JSON string length   ← JSON starts at byte 16
import { openSync, readSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Point DSH_ASAR at the archive if DSH is installed somewhere else.
const ASAR = process.env.DSH_ASAR
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

function open() {
  const fd = openSync(ASAR, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonSize)
  readSync(fd, jsonBuf, 0, jsonSize, 16)
  return { fd, header: JSON.parse(jsonBuf.toString('utf8')), base: 8 + headerSize }
}

function nodeAt(header, path) {
  let node = header
  for (const part of path.split('/').filter(Boolean)) {
    node = node.files?.[part]
    if (!node) return null
  }
  return node
}

function readFile(fd, base, node) {
  const buf = Buffer.alloc(node.size)
  readSync(fd, buf, 0, node.size, base + Number(node.offset || 0))
  return buf
}

const [command, ...rest] = process.argv.slice(2)
const { fd, header, base } = open()

if (command === 'list') {
  const node = nodeAt(header, rest[0] ?? '')
  if (!node?.files) {
    console.error(`not a directory: ${rest[0]}`)
    process.exit(1)
  }
  for (const [name, child] of Object.entries(node.files)) {
    console.log(child.files ? `${name}/` : `${name}  ${child.size}`)
  }
} else if (command === 'cat') {
  const node = nodeAt(header, rest[0])
  if (!node || node.files) {
    console.error(`not a file: ${rest[0]}`)
    process.exit(1)
  }
  const buf = readFile(fd, base, node)
  if (rest[1]) {
    mkdirSync(dirname(rest[1]), { recursive: true })
    writeFileSync(rest[1], buf)
    console.log(`${rest[0]} -> ${rest[1]} (${buf.length} bytes)`)
  } else {
    process.stdout.write(buf)
  }
} else if (command === 'grep') {
  const pattern = new RegExp(rest[0])
  const scope = rest[1] ?? ''
  const maxHits = Number(rest[2] ?? 60)
  let hits = 0
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (child.files) {
        walk(child, path)
        continue
      }
      if (hits >= maxHits) return
      if (scope && !path.includes(scope)) continue
      if (!/\.(js|mjs|cjs|json|yml|yaml)$/.test(path)) continue
      const lines = readFile(fd, base, child).toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length && hits < maxHits; index++) {
        if (!pattern.test(lines[index])) continue
        hits += 1
        console.log(`${path}:${index + 1}: ${lines[index].trim().slice(0, 220)}`)
      }
    }
  }
  walk(header, '')
} else if (command === 'find') {
  const pattern = new RegExp(rest[0], 'i')
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, path)
      else if (pattern.test(path)) console.log(`${path}  ${child.size}`)
    }
  }
  walk(header, '')
} else {
  console.error('usage: list <dir> | cat <file> [out] | find <regex>')
  process.exit(1)
}
