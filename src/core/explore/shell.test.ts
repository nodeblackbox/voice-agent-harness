import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PcExplorer } from './fs'
import { RestrictedShell, findGit, parseCommand, type Spawn } from './shell'

let tmp: string
let root: string
let outside: string
let ex: PcExplorer
let sh: RestrictedShell
const spawned: Array<{ file: string; args: string[]; cwd: string; env: Record<string, string> }> = []
const fakeSpawn: Spawn = async (file, args, opts) => {
  spawned.push({ file, args, cwd: opts.cwd, env: opts.env })
  return { code: 0, stdout: 'abc123 first commit\n', stderr: '', timedOut: false }
}

const write = (rel: string, text: string): void => {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}
const run = (cmd: string, cwd = root) => sh.run(cmd, cwd)
const out = async (cmd: string, cwd = root): Promise<string> => {
  const r = await run(cmd, cwd)
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`)
  return r.output
}
const refusal = async (cmd: string, cwd = root): Promise<string> => {
  const r = await run(cmd, cwd)
  expect(r, cmd).toMatchObject({ ok: false, refused: expect.any(String) })
  return (r as { refused: string }).refused
}
const survivors = (): string[] => fs.readdirSync(root).sort()

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'va-shell-')))
  root = path.join(tmp, 'allowed')
  outside = path.join(tmp, 'private')
  write('allowed/notes.txt', 'alpha\nbeta lemon\ngamma\ndelta lemon\n')
  write('allowed/app/README.md', '# App\nRuns on port 4100.\n')
  write('allowed/app/src/main.py', 'PORT = 4100\nprint("lemon")\n')
  write('allowed/app/.env', 'TOKEN=abc')
  write('allowed/app/.git/HEAD', 'ref: refs/heads/main\n')
  write('private/diary.txt', 'do not read me')
  ex = new PcExplorer(() => [root])
  sh = new RestrictedShell(ex, { spawn: fakeSpawn, git: () => 'C:\\Program Files\\Git\\cmd\\git.exe' })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('parseCommand', () => {
  it('splits words and keeps quoted text whole', () => {
    expect(parseCommand('grep -rn "two words" src')).toEqual({ ok: true, stages: [['grep', '-rn', 'two words', 'src']] })
    expect(parseCommand("find . -name '*.py' | head -n 3")).toEqual({ ok: true, stages: [['find', '.', '-name', '*.py'], ['head', '-n', '3']] })
    expect(parseCommand('grep "a|b;c>d" notes.txt')).toEqual({ ok: true, stages: [['grep', 'a|b;c>d', 'notes.txt']] })
  })

  it('refuses everything a real shell would act on', () => {
    const bad = [
      'ls; rm -rf .', 'ls && del notes.txt', 'ls || rmdir app', 'ls & del x', 'cat notes.txt > out.txt', 'cat notes.txt >> out.txt', 'cat < notes.txt', 'ls 2> err.txt',
      'echo $(rm notes.txt)', 'cat `rm notes.txt`', 'cat $HOME/x', 'type %USERPROFILE%\\x', 'cat "$(rm x)"', 'ls ~/x', 'ls ^ x', 'ls {a,b}', 'ls\nrm x', 'cat "unclosed', '', '   ', 'ls |', '| ls',
      'ls | head | tail | wc -l', `cat ${'x'.repeat(600)}`
    ]
    for (const b of bad) expect(parseCommand(b).ok, JSON.stringify(b)).toBe(false)
  })
})

describe('commands that are not on the list do not exist', () => {
  it('refuses every deleting, moving, installing, network and program-running command, and nothing is touched', async () => {
    const before = survivors()
    const cmds = [
      'rm notes.txt', 'rm -rf .', 'del notes.txt', 'DEL /f /q notes.txt', 'erase notes.txt', 'rmdir app', 'rd /s /q app', 'Remove-Item notes.txt', 'remove-item -Recurse -Force app', 'ri notes.txt',
      'format D:', 'move notes.txt x.txt', 'mv notes.txt app/README.md', 'Move-Item notes.txt x', 'ren notes.txt x', 'copy notes.txt x', 'cp notes.txt app/README.md', 'xcopy app b', 'robocopy app b /mir',
      'mkdir x', 'touch x', 'New-Item x', 'Set-Content notes.txt hi', 'Clear-Content notes.txt', 'truncate -s 0 notes.txt', 'attrib +h notes.txt',
      'curl http://example.com', 'wget http://example.com', 'Invoke-WebRequest http://example.com', 'ssh host', 'ping example.com',
      'npm install', 'pnpm add x', 'pip install x', 'winget install x', 'choco install x',
      'cmd /c del notes.txt', 'powershell -c rm notes.txt', 'pwsh -c x', 'bash -c "rm x"', 'python -c "import os"', 'node -e 1', 'start notepad', 'echo hi', 'shutdown /s',
      'git.exe status', 'rm.exe notes.txt', 'C:\\Windows\\System32\\cmd.exe /c dir', './rm notes.txt', '..\\tool notes.txt'
    ]
    for (const c of cmds.filter((c) => !c.startsWith('git.exe'))) expect(await refusal(c), c).toMatch(/^Refused: /)
    expect(await refusal('rm notes.txt')).toContain('deleting is never allowed')
    expect(await refusal('curl http://example.com')).toContain('network commands are not allowed')
    expect(await refusal('npm install')).toContain('package managers')
    expect(await refusal('echo hi')).toContain('not on the list of allowed commands')
    expect(survivors()).toEqual(before)
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toContain('alpha')
  })

  it('refuses the dangerous options of an allowed command', async () => {
    for (const c of ['find . -delete', 'find . -name "*.txt" -delete', 'find . -exec rm {} +', 'find . -name x -execdir del x', 'find . -fprint out.txt', 'find . -newer x']) expect(await refusal(c), c).toBeTruthy()
    expect(await refusal('find . -name "*.txt" -delete')).toContain('find can only look')
    for (const c of ['ls -R', 'dir /s', 'ls --color', 'cat -A notes.txt', 'grep --exclude-dir=x a .', 'head -c 5 notes.txt', 'wc notes.txt', 'ls *.txt']) expect(await refusal(c), c).toBeTruthy()
    expect(survivors()).toContain('notes.txt')
  })

  it('pipes only into the text filters', async () => {
    for (const c of ['ls | rm', 'cat notes.txt | del', 'ls | xargs rm', 'cat notes.txt | sh', 'ls | cat', 'ls | tee out.txt', 'cat notes.txt | find . -delete']) expect(await refusal(c), c).toContain('piped into')
    expect(await out('cat notes.txt | grep lemon | wc -l')).toBe('2')
    expect(await out('cat notes.txt | grep -v lemon | head -n 1')).toBe('alpha')
    expect(await out('cat notes.txt | sort -r | head -1')).toBe('gamma')
  })
})

describe('the allowed commands', () => {
  it('ls and dir list a folder; pwd says where', async () => {
    expect(await out('ls')).toMatch(/^app\/\nnotes\.txt \(0\.1 KB, \d{4}-\d\d-\d\d\)$/)
    expect(await out('dir /b app')).toContain('README.md')
    expect(await out('ls -la app/src')).toContain('main.py')
    expect(await out('pwd')).toBe(root)
  })

  it('cat, type, head, tail and wc read a text file', async () => {
    expect(await out('cat notes.txt')).toBe('alpha\nbeta lemon\ngamma\ndelta lemon')
    expect(await out('type app\\README.md')).toContain('port 4100')
    expect(await out('head -n 2 notes.txt')).toBe('alpha\nbeta lemon')
    expect(await out('head -1 notes.txt')).toBe('alpha')
    expect(await out('wc -l notes.txt')).toMatch(/^\d+ .*notes\.txt$/)
  })

  it('grep, findstr and find search', async () => {
    expect(await out('grep -rn lemon .')).toContain(`${path.join(root, 'notes.txt')}:2: beta lemon`)
    expect(await out('grep -ril LEMON . --include=*.py')).toBe(path.join(root, 'app', 'src', 'main.py'))
    expect(await out('findstr /s /i "port" app')).toContain('README.md:2')
    expect(await out('find . -name "*.py"')).toBe(path.join(root, 'app', 'src', 'main.py'))
    expect(await out('find app -type d -name src')).toBe(path.join(root, 'app', 'src') + path.sep)
  })

  it('stays inside the approved folder and away from secrets', async () => {
    expect(await refusal(`cat ${path.join(outside, 'diary.txt')}`)).toContain('outside the folders')
    expect(await refusal('cat ..\\private\\diary.txt')).toContain('outside the folders')
    expect(await refusal('ls ..')).toContain('outside the folders')
    expect(await refusal('grep diary ../private')).toContain('outside the folders')
    expect(await refusal('find .. -name "*.txt"')).toContain('outside the folders')
    expect(await refusal('ls', outside)).toContain('outside the folders')
    expect(await refusal('cat app/.env')).toContain('never read')
    expect(await out('grep -r TOKEN .')).toBe('(no output)')
  })

  it('needs a folder to run in when more than one is approved, and caps long output', async () => {
    const two = new RestrictedShell(new PcExplorer(() => [root, path.join(root, 'app')]))
    expect(await two.run('ls')).toMatchObject({ ok: false, refused: expect.stringContaining('which folder') })
    write('allowed/long.txt', Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'))
    const small = new RestrictedShell(ex, { maxOutputChars: 300 })
    const r = await small.run('cat long.txt', root)
    expect(r.ok && r.output.length).toBeLessThan(360)
    expect(r.ok && r.output).toContain('[output cut at 300 characters]')
  })
})

describe('git', () => {
  const repo = () => path.join(root, 'app')

  it('runs status, log, diff and branch as a program with arguments, hardened', async () => {
    spawned.length = 0
    expect(await out('git log --oneline -5', repo())).toBe('abc123 first commit')
    const call = spawned[0]!
    expect(call.file).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(call.cwd).toBe(repo())
    expect(call.args.slice(0, 2)).toEqual(['--no-pager', '--no-optional-locks'])
    expect(call.args).toContain('core.fsmonitor=false')
    expect(call.args.slice(call.args.indexOf('log'))).toEqual(['log', '--no-ext-diff', '--no-textconv', '--oneline', '-5'])
    expect(call.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(call.env.GIT_CEILING_DIRECTORIES).toBe(root)
    // the app's own environment (API keys) is not handed to git
    expect(Object.keys(call.env).every((k) => /^(GIT_|PAGER$)/.test(k) || /^(path|systemroot|windir|userprofile|home|homedrive|homepath|temp|tmp|lang|lc_all|appdata|localappdata|programfiles|programdata)$/i.test(k))).toBe(true)

    await out('git status -sb', repo())
    await out('git log', path.join(repo(), 'src'))
    expect(spawned.at(-1)!.args).toContain('--max-count=30')
    await out('git diff HEAD~1', repo())
    expect(spawned.at(-1)!.args.slice(-2)).toEqual(['--stat', 'HEAD~1'])
    await out('git log -n 3 -- src/main.py', repo())
    expect(spawned.at(-1)!.args.slice(-3)).toEqual(['-n3', '--', path.join(repo(), 'src', 'main.py')])
    await out('git branch -a', repo())
  })

  it('refuses every git command that writes, fetches or runs something', async () => {
    spawned.length = 0
    const cmds = [
      'git clean -fdx', 'git rm notes.txt', 'git reset --hard', 'git checkout .', 'git restore .', 'git stash', 'git commit -m x', 'git add .', 'git push', 'git pull', 'git fetch', 'git clone http://x',
      'git gc', 'git config core.pager x', 'git -c core.pager=x log', 'git --exec-path=x log', 'git -C .. status', 'git branch -D main', 'git branch new', 'git log -p', 'git log --output=x.txt',
      'git diff --no-index a b', 'git log --show-signature', 'git diff --ext-diff', 'git status --ignored=x', 'git log "--format=%x00"', 'git show HEAD:app/.env', 'git log -- .env', 'git log -- ../../private',
      'git log $(x)', 'git', 'git log "a b"', 'git diff -- "*.py"'
    ]
    for (const c of cmds) expect(await refusal(c, repo()), c).toBeTruthy()
    expect(spawned).toHaveLength(0)
  })

  it('needs a repository that lies inside the approved folder', async () => {
    expect(await refusal('git status', root)).toContain('not inside a git repository')
    write('allowed/linked/.git', 'gitdir: ../../private/repo.git')
    expect(await refusal('git status', path.join(root, 'linked'))).toContain('linked git checkout')
  })

  it('reports a timeout and a failure, and says when git is missing', async () => {
    const slow = new RestrictedShell(ex, { spawn: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }), git: () => 'git.exe', timeoutMs: 2000 })
    expect(await slow.run('git status', repo())).toEqual({ ok: false, error: 'git status was stopped after 2 seconds.' })
    const broken = new RestrictedShell(ex, { spawn: async () => ({ code: 128, stdout: '', stderr: 'fatal: bad object', timedOut: false }), git: () => 'git.exe' })
    expect(await broken.run('git log', repo())).toEqual({ ok: false, error: 'git log failed: fatal: bad object' })
    const none = new RestrictedShell(ex, { spawn: vi.fn(), git: () => null })
    expect(await none.run('git status', repo())).toEqual({ ok: false, error: 'git is not installed on this PC.' })
  })

  it('works against a real repository, and a program planted in the folder is not what runs', async () => {
    const git = findGit()
    if (!git) return
    expect(path.isAbsolute(git)).toBe(true)
    const real = path.join(root, 'realrepo')
    fs.mkdirSync(real)
    const g = (...args: string[]) => execFileSync(git, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: real, stdio: 'pipe' })
    g('init', '-q')
    fs.writeFileSync(path.join(real, 'a.txt'), 'one\n')
    g('add', 'a.txt')
    g('commit', '-q', '-m', 'first commit here')
    fs.writeFileSync(path.join(real, 'a.txt'), 'one\ntwo\n')
    fs.writeFileSync(path.join(real, 'git.cmd'), '@echo PLANTED\r\n')
    fs.writeFileSync(path.join(real, 'git.bat'), '@echo PLANTED\r\n')
    const live = new RestrictedShell(ex)
    const log = await live.run('git log --oneline', real)
    expect(log).toMatchObject({ ok: true, output: expect.stringContaining('first commit here') })
    const status = await live.run('git status --short', real)
    expect(status.ok && status.output).toContain('M a.txt')
    expect(status.ok && status.output).not.toContain('PLANTED')
    const diff = await live.run('git diff', real)
    expect(diff.ok && diff.output).toMatch(/a\.txt \| 1 \+/)
    // nothing was changed by looking
    expect(fs.readFileSync(path.join(real, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
  })
})
