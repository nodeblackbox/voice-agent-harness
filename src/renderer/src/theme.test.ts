import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { T, alpha } from './theme'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'index.css'), 'utf8')
const vars = (selector: string): Set<string> => {
  const i = css.indexOf(`${selector} {`)
  expect(i, `${selector} block in index.css`).toBeGreaterThan(-1)
  const body = css.slice(i, css.indexOf('}', i))
  return new Set([...body.matchAll(/--va-[a-z0-9-]+/g)].map((x) => x[0]))
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [join(dir, n)] : []))

describe('theme tokens', () => {
  const tokens = Object.entries(T).filter(([k]) => k !== 'mono')

  it('are CSS variables, every one defined for both the dark and the light theme', () => {
    const dark = vars(':root')
    const light = vars('[data-theme="light"]')
    for (const [k, v] of tokens) {
      const m = /^var\((--va-[a-z0-9-]+)\)$/.exec(v)
      expect(m, `${k} is a var()`).toBeTruthy()
      expect(dark.has(m![1]!), `${m![1]} in :root`).toBe(true)
      expect(light.has(m![1]!), `${m![1]} in light`).toBe(true)
    }
    expect(dark.size).toBe(light.size)
  })

  it('tints with color-mix so a var() token can be made transparent', () => {
    expect(alpha(T.cyan, 10)).toBe('color-mix(in srgb, var(--va-cyan) 10%, transparent)')
  })

  it('never has hex alpha digits appended to a token anywhere in the renderer (invalid on a var())', () => {
    const offenders = walk(here).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => (/\$\{[^{}]+\}[0-9A-Fa-f]{2}[`'"]/.test(l) ? `${f}:${i + 1}` : null)).filter(Boolean))
    expect(offenders).toEqual([])
  })
})
