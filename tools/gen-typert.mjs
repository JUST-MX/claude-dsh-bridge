// Emit the three wire artifacts from tools/api-spec.mjs.
//
// The official path is `@deepseek-ai/dsh-typert-generator`, which reads a
// TypeScript FaceModel and writes artifacts importing `zod` and
// `@deepseek-ai/dsh-typert-protocol/remote-info`. Neither specifier resolves
// from this workspace (no node_modules anywhere on the plugin's path, and no
// npm registry is reachable), so this generator emits the *same shapes* — same
// descriptor fields, same strict codecs, same TYPERT / TYPERT_REMOTE manifests —
// with the codec builder inlined instead of imported. Every consumer reads only
// the shapes, so nothing downstream can tell the difference.
//
//   node tools/gen-typert.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API, PACKAGE, SERVICE } from './api-spec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'plugin', 'packages', 'claude-sessions')

// --------------------------------------------------------------- codec core
//
// `create()` must return `{ parse(value) }`: the Host gateway's strict path
// calls exactly that. `jsonSchema` is the projection other consumers read.
// Objects strip undeclared fields and enforce declared ones, matching the zod
// objects the official generator emits.
const CODEC_CORE = String.raw`
/** Reject anything a JSON wire cannot carry, and drop undefined fields. */
function assertJson(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(path + ' must be a finite number')
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => assertJson(item, path + '[' + index + ']'))
  if (typeof value !== 'object') throw new TypeError(path + ' must be a JSON value')
  const copy = {}
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue
    copy[key] = assertJson(value[key], path + '.' + key)
  }
  return copy
}

/** Validate one value against the JSON-Schema subset this spec uses. */
function conform(schema, value, path) {
  if (schema === undefined) return value
  const json = assertJson(value, path)
  if (schema.type === 'string' && typeof json !== 'string') throw new TypeError(path + ' must be a string')
  if (schema.type === 'number' && typeof json !== 'number') throw new TypeError(path + ' must be a number')
  if (schema.type === 'boolean' && typeof json !== 'boolean') throw new TypeError(path + ' must be a boolean')
  if (schema.type === 'array') {
    if (!Array.isArray(json)) throw new TypeError(path + ' must be an array')
    return json.map((item, index) => conform(schema.items, item, path + '[' + index + ']'))
  }
  if (schema.type === 'object') {
    if (json === null || Array.isArray(json) || typeof json !== 'object') throw new TypeError(path + ' must be an object')
    const declared = schema.properties ?? {}
    const out = {}
    for (const key of Object.keys(declared)) {
      if (json[key] === undefined) continue
      out[key] = conform(declared[key], json[key], path + '.' + key)
    }
    for (const key of schema.required ?? []) {
      if (out[key] === undefined) throw new TypeError(path + '.' + key + ' is required')
    }
    return out
  }
  return json
}

/** Build one strict codec from a JSON-Schema projection. */
function codec(typeSymbol, schema, description) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: (value) => conform(schema, value, typeSymbol) }),
    ...(description === undefined ? {} : { description }),
    ...(schema === undefined ? {} : { jsonSchema: schema }),
  }
}

/** Assemble the descriptor list the registry and the gateway both consume. */
function descriptors(pkg, namespace, methods) {
  const list = []
  for (const method of Object.keys(methods)) {
    const definition = methods[method]
    const id = pkg + '#' + namespace + '/' + method
    list.push({
      id,
      service: namespace,
      namespace,
      method,
      description: definition.description,
      invocation: { kind: 'direct' },
      parameters: definition.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.wire,
        source: 'json',
        ...(parameter.description === undefined ? {} : { description: parameter.description }),
        ...(parameter.acceptsUndefined === true ? { acceptsUndefined: true } : {}),
        codec: codec(id + ':' + parameter.wire, parameter.schema, parameter.description),
      })),
      result: codec(id + ':result', definition.result, definition.description),
    })
  }
  return list
}
`

/** One method table entry, in the shape the descriptor builder expects. */
function methodTable(api) {
  const table = {}
  for (const call of api) {
    table[call.method] = {
      description: call.summary,
      parameters: call.params.map((parameter) => ({
        name: parameter.wire,
        wire: parameter.wire,
        description: parameter.summary,
        schema: parameter.schema,
        ...(parameter.optional === true ? { acceptsUndefined: true } : {}),
      })),
      result: call.result,
    }
  }
  return table
}

/** The reflection model typert-loader validates; no runtime consumer reads it. */
function reflectionModel(api) {
  return {
    services: [
      {
        description: 'Claude Code work items opened inside DeepSeek Harness: resident `claude -p` processes and their replayable transcripts.',
        summary: 'Claude Code work items opened inside DeepSeek Harness.',
        tags: ['remote', 'claude-code'],
        jsDoc: '/** Claude Code work items opened inside DeepSeek Harness. */',
        key: SERVICE,
        exportName: 'default',
        members: api.map((call) => ({
          kind: 'method',
          name: call.method,
          signature: '@Remote async ' + call.method + '(' +
            call.params.map((parameter) => parameter.wire).join(', ') + '): Promise<unknown>',
          summary: call.summary,
        })),
        types: [],
      },
    ],
    events: [],
    objects: [],
  }
}

const table = methodTable(API)
const model = reflectionModel(API)
const json = (value) => JSON.stringify(value, null, 2)

// ------------------------------------------------------------- Host artifact
const hostArtifact = `/* Generated by tools/gen-typert.mjs from tools/api-spec.mjs — do not edit.
 *
 * Host face of the claudeSessions Remote surface. typert-loader imports this
 * file because package.json exports it as "./typert", validates the manifest,
 * and registers it into ctx.typert — which is what lets a Client reach the Host
 * service through ctx.remote.claudeSessions.
 */
${CODEC_CORE}
const $remote = descriptors(${json(PACKAGE)}, ${json(SERVICE)}, ${json(table)})

export const TYPERT = {
  package: ${json(PACKAGE)},
  face: 'host',
  schemas: [],
  invocations: $remote,
  model: ${json(model)},
}

export default TYPERT
`

// ----------------------------------------------------------- Client artifact
const clientArtifact = `/* Generated by tools/gen-typert.mjs from tools/api-spec.mjs — do not edit.
 *
 * Client face of the claudeSessions Remote surface. The browser bundle carries
 * its own copy; this module exists so a consumer that can resolve the package
 * imports the same descriptors instead of re-declaring them.
 */
${CODEC_CORE}
export const TYPERT_REMOTE = {
  package: ${json(PACKAGE)},
  descriptors: descriptors(${json(PACKAGE)}, ${json(SERVICE)}, ${json(table)}),
}

export default TYPERT_REMOTE
`

// ---------------------------------------------------------- Browser artifact
// The bundle is one self-contained classic script: the codec core, this
// package's Client descriptors, and the panel body, all inside the factory the
// module loader registers. No bare specifier but "react" is required.
const body = readFileSync(join(pkgDir, 'src', 'client-body.js'), 'utf8')
const indent = (text) => text.split('\n').map((line) => (line ? `    ${line}` : line)).join('\n')
const bundle = `/* Generated by tools/gen-typert.mjs from tools/api-spec.mjs and src/client-body.js — do not edit. */
window.__ModuleLoader__.load({
  id: ${json(PACKAGE)},
  factory(require) {
    const React = require('react')
    const h = React.createElement
${indent(CODEC_CORE.trim())}

    const TYPERT_REMOTE = {
      package: ${json(PACKAGE)},
      descriptors: descriptors(${json(PACKAGE)}, ${json(SERVICE)}, ${json(table)}),
    }

${indent(body.trim())}
  },
})
`

writeFileSync(join(pkgDir, 'typert.js'), hostArtifact)
writeFileSync(join(pkgDir, 'remote.js'), clientArtifact)
writeFileSync(join(pkgDir, 'client.js'), bundle)
console.log(`generated typert.js, remote.js, client.js — ${API.length} methods for ${PACKAGE}`)
