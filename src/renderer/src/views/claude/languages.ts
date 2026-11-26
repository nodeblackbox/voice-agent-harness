/**
 * Which syntax a file gets in the editor, by name. Each grammar is loaded only when a file of that kind
 * is opened, so the editor adds nothing to start-up.
 */
import type { Extension } from '@codemirror/state'

interface Lang {
  label: string
  load: () => Promise<Extension>
}

const legacy = async (mode: Promise<Record<string, unknown>>, name: string): Promise<Extension> => {
  const [{ StreamLanguage }, m] = await Promise.all([import('@codemirror/language'), mode])
  return StreamLanguage.define(m[name] as Parameters<typeof StreamLanguage.define>[0])
}

const js = (label: string, opts: { typescript?: boolean; jsx?: boolean }): Lang => ({ label, load: async () => (await import('@codemirror/lang-javascript')).javascript(opts) })
const TS = js('TypeScript', { typescript: true })
const JS = js('JavaScript', {})
const PY: Lang = { label: 'Python', load: async () => (await import('@codemirror/lang-python')).python() }
const JSON_: Lang = { label: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() }
const MD: Lang = { label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() }
const HTML: Lang = { label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() }
const CSS: Lang = { label: 'CSS', load: async () => (await import('@codemirror/lang-css')).css() }
const YAML: Lang = { label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() }
const XML: Lang = { label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() }
const CPP: Lang = { label: 'C / C++', load: async () => (await import('@codemirror/lang-cpp')).cpp() }
const SHELL: Lang = { label: 'Shell', load: () => legacy(import('@codemirror/legacy-modes/mode/shell'), 'shell') }
const PROPS: Lang = { label: 'Config', load: () => legacy(import('@codemirror/legacy-modes/mode/properties'), 'properties') }

const MERMAID_WORDS = /^(?:flowchart|graph|subgraph|end|sequenceDiagram|participant|actor|as|loop|alt|else|opt|par|and|critical|break|rect|note|over|left of|right of|activate|deactivate|autonumber|stateDiagram-v2|stateDiagram|state|classDiagram|class|erDiagram|mindmap|timeline|gantt|title|section|journey|pie|showData|quadrantChart|gitGraph|commit|branch|checkout|merge|classDef|style|linkStyle|click|direction|dateFormat|axisFormat|TD|TB|LR|RL|BT)(?![\w-])/

/** Mermaid has no grammar package; this colours its keywords, arrows, labels and comments. */
const MERMAID: Lang = {
  label: 'Mermaid',
  load: async () => {
    const { StreamLanguage } = await import('@codemirror/language')
    return StreamLanguage.define<Record<string, never>>({
      startState: () => ({}),
      token(stream) {
        if (stream.eatSpace()) return null
        if (stream.match('%%')) {
          stream.skipToEnd()
          return 'comment'
        }
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
        if (stream.match(/^\|[^|\n]*\|/)) return 'string'
        if (stream.match(/^[<ox]?(?:--+|==+|-\.+-?|\.\.+|~~+)(?:[>xo)]+|\|)?/) || stream.match(/^(?:\|\||\|o|o\||\}o|o\{|\}\||\|\{)/)) return 'operator'
        // a node's label, brackets included: words inside it are text, not keywords
        if (stream.match(/^[[({]+[^\])}\n]*[\])}]+/)) return 'string'
        if (stream.match(MERMAID_WORDS)) return 'keyword'
        if (stream.match(/^:::?\s*\w*/)) return 'atom'
        if (stream.match(/^[[\](){}<>]/)) return 'bracket'
        if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
        if (stream.match(/^[\wÀ-￿][\wÀ-￿-]*/)) return 'variableName'
        stream.next()
        return null
      }
    })
  }
}

const BY_EXT: Record<string, Lang> = {
  mmd: MERMAID, mermaid: MERMAID,
  ts: TS, mts: TS, cts: TS,
  tsx: js('TypeScript React', { typescript: true, jsx: true }),
  js: JS, mjs: JS, cjs: JS,
  jsx: js('JavaScript React', { jsx: true }),
  py: PY, pyw: PY, pyi: PY,
  json: JSON_, jsonc: JSON_, jsonl: JSON_, webmanifest: JSON_, ipynb: JSON_,
  md: MD, markdown: MD, mdx: MD,
  html: HTML, htm: HTML, vue: HTML, svelte: HTML,
  css: CSS, scss: { ...CSS, label: 'SCSS' }, less: { ...CSS, label: 'Less' },
  yml: YAML, yaml: YAML,
  xml: XML, svg: { ...XML, label: 'SVG' }, xsl: XML, plist: XML,
  sql: { label: 'SQL', load: async () => (await import('@codemirror/lang-sql')).sql() },
  rs: { label: 'Rust', load: async () => (await import('@codemirror/lang-rust')).rust() },
  c: CPP, h: CPP, cpp: CPP, hpp: CPP, cc: CPP,
  java: { label: 'Java', load: async () => (await import('@codemirror/lang-java')).java() },
  go: { label: 'Go', load: async () => (await import('@codemirror/lang-go')).go() },
  sh: SHELL, bash: SHELL, zsh: SHELL,
  ps1: { label: 'PowerShell', load: () => legacy(import('@codemirror/legacy-modes/mode/powershell'), 'powerShell') },
  toml: { label: 'TOML', load: () => legacy(import('@codemirror/legacy-modes/mode/toml'), 'toml') },
  ini: PROPS, cfg: PROPS, conf: PROPS, properties: PROPS, env: PROPS,
  rb: { label: 'Ruby', load: () => legacy(import('@codemirror/legacy-modes/mode/ruby'), 'ruby') },
  lua: { label: 'Lua', load: () => legacy(import('@codemirror/legacy-modes/mode/lua'), 'lua') },
  diff: { label: 'Diff', load: () => legacy(import('@codemirror/legacy-modes/mode/diff'), 'diff') },
  patch: { label: 'Diff', load: () => legacy(import('@codemirror/legacy-modes/mode/diff'), 'diff') }
}

const DOCKER: Lang = { label: 'Dockerfile', load: () => legacy(import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile') }

/** The syntax for a path, or null for plain text ("notes.txt", an unknown extension). */
export function languageFor(path: string): Lang | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return DOCKER
  if (name === '.env' || name.startsWith('.env.') || name === '.gitignore' || name === '.npmrc' || name === '.editorconfig') return PROPS
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? (BY_EXT[name.slice(dot + 1)] ?? null) : null
}

export const languageLabel = (path: string): string => languageFor(path)?.label ?? 'Plain text'
