import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PcExplorer, globToRegex, isSecretName, nameMatcher, redact } from './fs'

let tmp: string
let root: string
let other: string
let outside: string
let ex: PcExplorer

const write = (rel: string, text: string | Buffer): void => {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'va-explore-')))
  root = path.join(tmp, 'allowed')
  other = path.join(tmp, 'projects')
  outside = path.join(tmp, 'private')
  write('allowed/notes.txt', 'first line\nsecond line mentions lemons\nthird line')
  write('allowed/Lemon-AI/README.md', '# Lemon AI\nA voice thing.\nRuns on port 4100.')
  write('allowed/Lemon-AI/src/main.py', 'import os\nPORT = 4100\nprint("lemon")\n')
  write('allowed/Lemon-AI/.env', 'SECRET_TOKEN=abc123')
  write('allowed/Lemon-AI/.env.example', 'SECRET_TOKEN=')
  write('allowed/Lemon-AI/node_modules/pkg/index.js', 'const lemon = 4100')
  write('allowed/deep/a/b/lemon_ai_old/x.txt', 'x')
  write('allowed/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
  write('allowed/blob.txt', Buffer.from([1, 2, 0, 3, 4]))
  write('allowed/config.yml', 'api_key: sk-ant-REDACTME1234567890abcdef\nurl: http://bob:hunter2@10.0.0.1:8080\nname: fine')
  write('allowed/.ssh/config', 'Host x')
  write('projects/app/package.json', '{"name":"app"}')
  write('private/diary.txt', 'do not read me')
  write('allowed-not/real.txt', 'sibling whose name starts like the root')
  // a junction inside the root that points outside it (junctions need no admin rights on Windows)
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
  } catch {
    // no link support here: the test that needs it checks for the link first
  }
  ex = new PcExplorer(() => [root, other], { budgetMs: 5000 })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('the fence', () => {
  it('lets a path inside an approved folder through, and the folder itself', async () => {
    expect(await ex.resolve(path.join(root, 'notes.txt'))).toEqual({ ok: true, path: path.join(root, 'notes.txt') })
    expect(await ex.resolve(root)).toEqual({ ok: true, path: root })
    expect(await ex.resolve(`"${path.join(other, 'app')}"`)).toEqual({ ok: true, path: path.join(other, 'app') })
  })

  it('blocks a path outside, however it is written', async () => {
    const tries = [
      path.join(outside, 'diary.txt'),
      path.join(root, '..', 'private', 'diary.txt'),
      path.join(root, 'Lemon-AI', '..', '..', 'private', 'diary.txt'),
      `${root}${path.sep}..${path.sep}..`,
      path.join(tmp, 'allowed-not', 'real.txt'),
      '../private/diary.txt',
      'Lemon-AI/../../private/diary.txt',
      os.homedir()
    ]
    for (const t of tries) {
      const r = await ex.resolve(t)
      expect(r.ok, t).toBe(false)
    }
  })

  it('blocks network and device paths, null bytes and alternate data streams', async () => {
    for (const t of ['\\\\server\\share\\x', '\\\\?\\C:\\Windows', '//server/share', `${root}\\notes.txt\0.png`]) expect((await ex.resolve(t)).ok, t).toBe(false)
    if (process.platform === 'win32') expect((await ex.resolve(`${root}\\notes.txt:hidden`)).ok).toBe(false)
  })

  it('does not follow a link inside the root to a folder outside it', async () => {
    const link = path.join(root, 'escape')
    if (!fs.existsSync(link)) return
    expect((await ex.resolve(path.join(link, 'diary.txt'))).ok).toBe(false)
    expect(await ex.read(path.join(link, 'diary.txt'))).toEqual({ error: expect.stringContaining('outside') })
    const found = (await ex.find('diary')) as { matches: unknown[] }
    expect(found.matches).toEqual([])
    const hits = (await ex.grep('do not read me')) as { matches: unknown[] }
    expect(hits.matches).toEqual([])
  })

  it('resolves a relative path under the approved folder that has it', async () => {
    expect(await ex.resolve('Lemon-AI/README.md')).toEqual({ ok: true, path: path.join(root, 'Lemon-AI', 'README.md') })
    expect(await ex.resolve('app/package.json')).toEqual({ ok: true, path: path.join(other, 'app', 'package.json') })
  })

  it('never opens a credentials folder, and says so when nothing is approved', async () => {
    expect(await ex.resolve(path.join(root, '.ssh', 'config'))).toEqual({ ok: false, error: expect.stringContaining('credentials') })
    const none = new PcExplorer(() => [])
    expect(await none.resolve(root)).toEqual({ ok: false, error: expect.stringContaining('Settings') })
    expect(await none.find('x')).toEqual({ error: expect.stringContaining('Settings') })
  })

  it('ignores roots that are not absolute folders', () => {
    expect(new PcExplorer(() => ['', 'relative/dir', '\\\\server\\share', root, root.toUpperCase()]).roots()).toHaveLength(process.platform === 'win32' ? 1 : 2)
  })

  it('checks the real name of a file, so an alias cannot get at a secrets file', async () => {
    if (process.platform !== 'win32') return
    write('allowed/Lemon-AI/keys.json', '{"token":"abc"}')
    for (const alias of ['keys.json', 'keys.json.', 'KEYS.JSON ', 'keys.json...  ']) expect(await ex.read(path.join(root, 'Lemon-AI') + path.sep + alias), alias).toEqual({ error: expect.stringContaining('never read') })
    expect(await ex.read(`${path.join(root, 'Lemon-AI', '.env')}::$DATA`)).toEqual({ error: expect.any(String) })
    for (const dev of ['NUL', 'con', 'COM1', 'nul.txt']) expect(await ex.read(path.join(root, dev)), dev).toEqual({ error: expect.stringContaining('device') })
  })

  it('reads a bare drive letter as the drive root, not the current folder on it', async () => {
    if (process.platform !== 'win32') return
    const drive = root.slice(0, 2)
    const d = new PcExplorer(() => [`${drive}\\`])
    expect(await d.resolve(drive)).toEqual({ ok: true, path: `${drive.toUpperCase()}\\` })
    expect(d.roots()).toEqual([`${drive}\\`])
  })
})

describe('list', () => {
  it('names folders and files with sizes, and hides credential folders', async () => {
    const r = (await ex.list(root)) as { folders: string[]; files: string[]; total_files: number }
    expect(r.folders).toContain('Lemon-AI')
    expect(r.folders).not.toContain('.ssh')
    expect(r.files.find((f) => f.startsWith('notes.txt'))).toMatch(/^notes\.txt \(0\.1 KB, \d{4}-\d\d-\d\d\)$/)
  })

  it('caps the entries and says how many are left out', async () => {
    const r = (await ex.list(root, 2)) as { folders: string[]; files: string[]; not_shown: number }
    expect(r.folders.length + r.files.length).toBe(2)
    expect(r.not_shown).toBeGreaterThan(0)
  })

  it('lists the approved folders when no path is given, and reports a missing one', async () => {
    expect(await ex.list('')).toMatchObject({ approved_folders: [root, other] })
    expect(await ex.list(path.join(root, 'nope'))).toEqual({ error: expect.stringContaining('Nothing exists') })
  })
})

describe('find', () => {
  it('finds a folder from spoken words, whatever the punctuation, nearest first', async () => {
    const r = (await ex.find('lemon AI', { type: 'folder' })) as { matches: Array<{ path: string; type: string }>; incomplete?: string }
    expect(r.matches).toEqual([{ path: path.join(root, 'Lemon-AI'), type: 'folder' }])
    // a whole drive is too big to walk: the search stops two levels below its first match and says so
    expect(r.incomplete).toContain('nearest matches')
    const deeper = (await ex.find('lemon AI', { type: 'folder', path: path.join(root, 'deep') })) as { matches: Array<{ path: string }>; incomplete?: string }
    expect(deeper.matches.map((m) => m.path)).toEqual([path.join(root, 'deep', 'a', 'b', 'lemon_ai_old')])
    expect(deeper.incomplete).toBeUndefined()
  })

  it('offers names with some of the words when none has them all', async () => {
    const r = (await ex.find('lemon tracker project', { type: 'folder' })) as { matches: Array<{ path: string }>; note?: string }
    expect(r.matches[0]!.path).toBe(path.join(root, 'Lemon-AI'))
    expect(r.note).toContain('some of them')
    expect(await ex.find('quantum banana', { path: root })).toMatchObject({ matches: [] })
  })

  it('takes globs, on the name or on the path', async () => {
    const md = (await ex.find('*.md')) as { matches: Array<{ path: string; kb: number }> }
    expect(md.matches.map((m) => path.basename(m.path))).toEqual(['README.md'])
    expect(md.matches[0]!.kb).toBeGreaterThan(0)
    const py = (await ex.find('**/src/*.py', { path: root })) as { matches: Array<{ path: string }> }
    expect(py.matches.map((m) => path.basename(m.path))).toEqual(['main.py'])
  })

  it('does not walk into node_modules, and searches every approved folder', async () => {
    expect(((await ex.find('index.js')) as { matches: unknown[] }).matches).toEqual([])
    expect(((await ex.find('package.json')) as { matches: Array<{ path: string }> }).matches[0]!.path).toBe(path.join(other, 'app', 'package.json'))
  })

  it('caps results and says more exist; refuses a start folder outside the fence', async () => {
    const r = (await ex.find('*', { limit: 3 })) as { matches: unknown[]; more_matches: number }
    expect(r.matches).toHaveLength(3)
    expect(r.more_matches).toBeGreaterThan(0)
    expect(await ex.find('diary', { path: outside })).toEqual({ error: expect.stringContaining('outside') })
  })

  it('stops at its folder limit and says the search is incomplete', async () => {
    const small = new PcExplorer(() => [root], { maxDirs: 2 })
    expect(await small.find('x.txt')).toMatchObject({ matches: [], incomplete: expect.stringContaining('narrower') })
  })
})

describe('read', () => {
  it('returns the text with line numbers of the part read', async () => {
    expect(await ex.read(path.join(root, 'notes.txt'))).toMatchObject({ lines: '1-3 of 3', text: 'first line\nsecond line mentions lemons\nthird line' })
    expect(await ex.read(path.join(root, 'notes.txt'), { fromLine: 2 })).toMatchObject({ lines: '2-3 of 3', text: 'second line mentions lemons\nthird line' })
  })

  it('caps the size and says where to carry on', async () => {
    write('allowed/long.txt', Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n'))
    const r = (await ex.read(path.join(root, 'long.txt'), { maxChars: 500 })) as { text: string; more: string; lines: string }
    expect(r.text.length).toBeLessThanOrEqual(500)
    const last = Number(/^1-(\d+) of 400$/.exec(r.lines)![1])
    expect(r.more).toBe(`Call again with from_line ${last + 1} for the next part.`)
  })

  it('refuses secrets files, binaries and folders', async () => {
    expect(await ex.read(path.join(root, 'Lemon-AI', '.env'))).toEqual({ error: expect.stringContaining('never read') })
    expect(await ex.read(path.join(root, 'pic.png'))).toMatchObject({ error: expect.stringContaining('Not a text file') })
    expect(await ex.read(path.join(root, 'blob.txt'))).toMatchObject({ error: expect.stringContaining('Not a text file') })
    expect(await ex.read(root)).toMatchObject({ error: expect.any(String) })
    expect(await ex.read(path.join(root, 'Lemon-AI', '.env.example'))).toMatchObject({ text: 'SECRET_TOKEN=' })
  })

  it('masks keys and logins inside an ordinary file', async () => {
    const r = (await ex.read(path.join(root, 'config.yml'))) as { text: string }
    expect(r.text).not.toContain('REDACTME')
    expect(r.text).not.toContain('hunter2')
    expect(r.text).toContain('name: fine')
  })
})

describe('grep', () => {
  it('finds lines across files with file and line number, ignoring case', async () => {
    const r = (await ex.grep('LEMON', { path: root })) as { matches: Array<{ file: string; line: number; text: string }>; files_with_matches: number }
    expect(r.matches).toContainEqual({ file: path.join(root, 'notes.txt'), line: 2, text: 'second line mentions lemons' })
    expect(r.matches.some((m) => m.file.endsWith('main.py'))).toBe(true)
    expect(r.matches.some((m) => m.file.includes('node_modules'))).toBe(false)
    expect(r.files_with_matches).toBeGreaterThanOrEqual(3)
  })

  it('never searches secrets files or binaries, and masks keys in matching lines', async () => {
    expect(((await ex.grep('SECRET_TOKEN=abc')) as { matches: unknown[] }).matches).toEqual([])
    const r = (await ex.grep('api_key')) as { matches: Array<{ text: string }> }
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]!.text).not.toContain('REDACTME')
  })

  it('filters by file name, takes a regex, and searches a single file', async () => {
    const py = (await ex.grep('4100', { files: '*.py' })) as { matches: Array<{ file: string }> }
    expect(py.matches.map((m) => path.basename(m.file))).toEqual(['main.py'])
    const re = (await ex.grep('^PORT\\s*=\\s*\\d+', { regex: true })) as { matches: Array<{ line: number }> }
    expect(re.matches).toEqual([expect.objectContaining({ line: 2 })])
    const one = (await ex.grep('port', { path: path.join(root, 'Lemon-AI', 'README.md') })) as { matches: unknown[]; files_searched: number }
    expect(one.matches).toHaveLength(1)
    expect(one.files_searched).toBe(1)
    expect(await ex.grep('(', { regex: true })).toEqual({ error: expect.stringContaining('Bad pattern') })
  })

  it('stops at the limit and says so', async () => {
    const r = (await ex.grep('line', { limit: 2 })) as { matches: unknown[]; note: string }
    expect(r.matches).toHaveLength(2)
    expect(r.note).toContain('Stopped at 2')
  })
})

describe('helpers', () => {
  it('knows which names hold secrets', () => {
    for (const n of ['.env', '.env.local', 'extra_keys.env', 'id_rsa', 'server.pem', 'keys.json', 'credentials.json', '.npmrc', 'proxies.txt', 'proxies_ranked.txt']) expect(isSecretName(n), n).toBe(true)
    for (const n of ['.env.example', 'environment.ts', 'keyboard.json', 'README.md', 'proxy.ts']) expect(isSecretName(n), n).toBe(false)
  })

  it('masks key-shaped strings', () => {
    expect(redact('key gsk_abcdefghijklmnop1234 end')).toBe('key [key hidden] end')
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[private key hidden]')
    expect(redact('a task-list and a risk-assessment-of-things')).toBe('a task-list and a risk-assessment-of-things')
  })

  it('matches names by words and by glob', () => {
    const m = nameMatcher('lemon ai')
    expect(m('LemonAI', '')).toBe(0)
    expect(m('lemon-ai-app', '')).toBe(1)
    expect(m('my_lemon_ai', '')).toBe(2)
    expect(m('ai-for-lemons', '')).toBe(3)
    expect(m('melon', '')).toBe(-1)
    expect(nameMatcher('lemon tracker')('trackerLemonProject', '')).toBe(3)
    expect(nameMatcher('lemon assistant')('trackerLemonProject', '')).toBe(4)
    expect(nameMatcher('my project')('SomeProject', '')).toBe(-1)
    expect(globToRegex('*.TS').test('index.ts')).toBe(true)
    expect(globToRegex('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegex('*.ts').test('a/b.ts')).toBe(false)
  })
})
