// How many files a folder has changed and not committed, for runbooks that react to a finished Claude Code session
// ("it changed 3 files: commit and push them?"). Read-only (`git status`); null when the folder is not a git
// repository, git is missing, or it takes too long.

import { execFile } from 'node:child_process'

export function changedFiles(folder: string | undefined, run: typeof execFile = execFile): Promise<number | null> {
  if (!folder) return Promise.resolve(null)
  return new Promise((resolve) => {
    run('git', ['-C', folder, 'status', '--porcelain'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(String(stdout).split(/\r?\n/).filter((l) => l.trim()).length)
    })
  })
}
