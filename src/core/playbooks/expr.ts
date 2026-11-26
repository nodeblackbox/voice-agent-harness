// The `when:` language of a playbook trigger: a small, safe expression over a context snapshot.
// It is parsed once, when the file is loaded, into a tree that is walked on every check; nothing is ever
// passed to eval. Missing data never errors: an unknown name is null, and any comparison or arithmetic
// with null is false (or null), so `chars > 1200` on an event without `chars` simply does not match.
//
//   expr   := or
//   or     := and ('or' and)*
//   and    := not ('and' not)*
//   not    := 'not' not | cmp
//   cmp    := sum (('=='|'!='|'<'|'<='|'>'|'>='|'in') sum)?
//   sum    := term (('+'|'-') term)*
//   term   := unary (('*'|'/') unary)*
//   unary  := '-' unary | atom
//   atom   := number | 'string' | "string" | true | false | null | [list] | name(.name)* | fn(args) | (expr)

export type Value = number | string | boolean | null | Value[]

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'list'; items: Node[] }
  | { k: 'name'; path: string[] }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'not'; a: Node }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }

export class ExprError extends Error {
  constructor(
    message: string,
    readonly column: number
  ) {
    super(message)
  }
}

export const EXPR_FUNCTIONS = ['len', 'min', 'max', 'abs', 'lower', 'has', 'any_of'] as const

interface Token {
  t: 'num' | 'str' | 'name' | 'op' | 'end'
  v: string
  at: number
}

const OPS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '(', ')', '[', ']', ',', '.']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: m[0], at: i })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++
        s += src[j]
        j++
      }
      if (j >= src.length) throw new ExprError('a quote is not closed', i + 1)
      out.push({ t: 'str', v: s, at: i })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ t: 'name', v: m[0], at: i })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new ExprError(`unexpected "${c}"`, i + 1)
    out.push({ t: 'op', v: op, at: i })
    i += op.length
  }
  out.push({ t: 'end', v: '', at: src.length })
  return out
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'null'])

function parse(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = (): Token => toks[p]!
  const take = (): Token => toks[p++]!
  const isOp = (v: string): boolean => peek().t === 'op' && peek().v === v
  const isWord = (v: string): boolean => peek().t === 'name' && peek().v === v
  const expect = (v: string): void => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"`, peek().at + 1)
    p++
  }

  const or = (): Node => {
    let a = and()
    while (isWord('or')) {
      p++
      a = { k: 'bin', op: 'or', a, b: and() }
    }
    return a
  }
  const and = (): Node => {
    let a = not()
    while (isWord('and')) {
      p++
      a = { k: 'bin', op: 'and', a, b: not() }
    }
    return a
  }
  const not = (): Node => {
    if (isWord('not')) {
      p++
      return { k: 'not', a: not() }
    }
    return cmp()
  }
  const cmp = (): Node => {
    const a = sum()
    const t = peek()
    if ((t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) || isWord('in')) {
      p++
      return { k: 'bin', op: t.v, a, b: sum() }
    }
    return a
  }
  const sum = (): Node => {
    let a = term()
    while (isOp('+') || isOp('-')) a = { k: 'bin', op: take().v, a, b: term() }
    return a
  }
  const term = (): Node => {
    let a = unary()
    while (isOp('*') || isOp('/')) a = { k: 'bin', op: take().v, a, b: unary() }
    return a
  }
  const unary = (): Node => {
    if (isOp('-')) {
      p++
      return { k: 'neg', a: unary() }
    }
    return atom()
  }
  const atom = (): Node => {
    const t = take()
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) }
    if (t.t === 'str') return { k: 'lit', v: t.v }
    if (t.t === 'op' && t.v === '(') {
      const e = or()
      expect(')')
      return e
    }
    if (t.t === 'op' && t.v === '[') {
      const items: Node[] = []
      if (!isOp(']')) {
        items.push(or())
        while (isOp(',')) {
          p++
          items.push(or())
        }
      }
      expect(']')
      return { k: 'list', items }
    }
    if (t.t === 'name') {
      if (t.v === 'true') return { k: 'lit', v: true }
      if (t.v === 'false') return { k: 'lit', v: false }
      if (t.v === 'null') return { k: 'lit', v: null }
      if (KEYWORDS.has(t.v)) throw new ExprError(`"${t.v}" cannot go here`, t.at + 1)
      if (isOp('(')) {
        if (!(EXPR_FUNCTIONS as readonly string[]).includes(t.v)) throw new ExprError(`unknown function "${t.v}" (allowed: ${EXPR_FUNCTIONS.join(', ')})`, t.at + 1)
        p++
        const args: Node[] = []
        if (!isOp(')')) {
          args.push(or())
          while (isOp(',')) {
            p++
            args.push(or())
          }
        }
        expect(')')
        return { k: 'call', fn: t.v, args }
      }
      const path = [t.v]
      while (isOp('.')) {
        p++
        const n = take()
        if (n.t !== 'name') throw new ExprError('expected a name after "."', n.at + 1)
        path.push(n.v)
      }
      return { k: 'name', path }
    }
    throw new ExprError(t.t === 'end' ? 'the expression ends too early' : `unexpected "${t.v}"`, t.at + 1)
  }

  const root = or()
  if (peek().t !== 'end') throw new ExprError(`unexpected "${peek().v}"`, peek().at + 1)
  return root
}

const isNum = (v: Value): v is number => typeof v === 'number' && Number.isFinite(v)

function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** Only own, plain data: a path can never reach a prototype or a function. */
function lookup(ctx: unknown, path: string[]): Value {
  let cur: unknown = ctx
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return toValue(cur)
}

function toValue(v: unknown): Value {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(toValue)
  return null
}

function equal(a: Value, b: Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function call(fn: string, args: Value[]): Value {
  const [a, b] = args
  switch (fn) {
    case 'len':
      return typeof a === 'string' || Array.isArray(a) ? a.length : null
    case 'min':
    case 'max': {
      const ns = args.flatMap((x) => (Array.isArray(x) ? x : [x])).filter(isNum)
      return ns.length ? (fn === 'min' ? Math.min(...ns) : Math.max(...ns)) : null
    }
    case 'abs':
      return isNum(a!) ? Math.abs(a) : null
    case 'lower':
      return typeof a === 'string' ? a.toLowerCase() : null
    case 'has':
      if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase().includes(b.toLowerCase())
      if (Array.isArray(a)) return a.some((x) => equal(x, b ?? null))
      return false
    case 'any_of': {
      if (typeof a !== 'string' || !Array.isArray(b)) return false
      const s = a.toLowerCase()
      return b.some((x) => typeof x === 'string' && x && s.includes(x.toLowerCase()))
    }
  }
  return null
}

function evaluate(n: Node, ctx: unknown): Value {
  switch (n.k) {
    case 'lit':
      return n.v
    case 'list':
      return n.items.map((x) => evaluate(x, ctx))
    case 'name':
      return lookup(ctx, n.path)
    case 'call':
      return call(
        n.fn,
        n.args.map((x) => evaluate(x, ctx))
      )
    case 'not':
      return !truthy(evaluate(n.a, ctx))
    case 'neg': {
      const v = evaluate(n.a, ctx)
      return isNum(v) ? -v : null
    }
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.a, ctx)) && truthy(evaluate(n.b, ctx))
      if (n.op === 'or') return truthy(evaluate(n.a, ctx)) || truthy(evaluate(n.b, ctx))
      const a = evaluate(n.a, ctx)
      const b = evaluate(n.b, ctx)
      switch (n.op) {
        case '==':
          return equal(a, b)
        case '!=':
          return !equal(a, b)
        case 'in':
          if (typeof b === 'string' && typeof a === 'string') return b.toLowerCase().includes(a.toLowerCase())
          if (Array.isArray(b)) return b.some((x) => equal(x, a))
          return false
        case '<':
        case '<=':
        case '>':
        case '>=': {
          if (!isNum(a) || !isNum(b)) return false
          return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b
        }
        case '+':
          if (typeof a === 'string' && typeof b === 'string') return a + b
          return isNum(a) && isNum(b) ? a + b : null
        case '-':
          return isNum(a) && isNum(b) ? a - b : null
        case '*':
          return isNum(a) && isNum(b) ? a * b : null
        case '/':
          return isNum(a) && isNum(b) && b !== 0 ? a / b : null
      }
      return null
    }
  }
}

export interface Compiled {
  source: string
  /** Every dotted name the expression reads, for warnings about fields an event never has. */
  names: string[]
  test(ctx: unknown): boolean
  value(ctx: unknown): Value
}

function names(n: Node, out: Set<string>): Set<string> {
  if (n.k === 'name') out.add(n.path.join('.'))
  else if (n.k === 'list') n.items.forEach((x) => names(x, out))
  else if (n.k === 'call') n.args.forEach((x) => names(x, out))
  else if (n.k === 'not' || n.k === 'neg') names(n.a, out)
  else if (n.k === 'bin') {
    names(n.a, out)
    names(n.b, out)
  }
  return out
}

/** Parse once; throws ExprError with a 1-based column when the text is not a valid expression. */
export function compile(source: string): Compiled {
  const tree = parse(source)
  return {
    source,
    names: [...names(tree, new Set())],
    test: (ctx) => truthy(evaluate(tree, ctx)),
    value: (ctx) => evaluate(tree, ctx)
  }
}
