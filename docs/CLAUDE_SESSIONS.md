# Voice-managed Claude Code sessions

Talk to the voice agent and it runs several Claude Code sessions in the background through the
Claude Agent SDK: start them, give them tasks, stack follow-ups, stop them mid-task, ask what just
happened, and answer their questions and approvals by voice. **Off by default**: enable it in the
Claude Code view (rail) → Settings.

## What you can say

| you say | happens |
|---|---|
| "start a session called landing page and build a one-page site" | `claude_start` → new sandboxed workspace + first task |
| "also add a contact form" (while it works) | `claude_send` → queued behind the current task |
| "stop that, do X instead" | `claude_send` with mode `now` → interrupt + redirect |
| "hold on" / "cancel that" | `claude_interrupt` (session stays resumable) |
| "how's landing page going?" / "what did it just do?" | `claude_status` → speakable digest |
| the session asks a question → the agent reads it out with numbered options; "the second one" / "use Postgres" | `claude_answer` (option number or free text) |
| a shell command needs approval → "Is that okay?" → "yes" / "no" | `claude_answer` approve true/false |
| "shut down landing page" | `claude_stop` (workspace and history kept; the next send resumes it) |
| "start landing page over" | `claude_reset` → fresh conversation, same folder |
| "get rid of slop one and slop two" (+ "and delete their files") | `claude_remove` → several at once; folders kept unless asked |
| "start a session in the bing-bong-jiggly folder" / "…in D:\\Downloads\\my-app" | `claude_start` with `folder` (a workspace folder, or your project after a yes) |
| "what files did it make?" | `claude_files` → newest files with sizes |
| "what were my other Claude sessions about?" | `claude_recent` → your saved sessions from the terminal/IDE |
| "pick up the build-fix session" (after a clear yes) | `claude_attach` → continues a copy of it here |

When a session needs you, or finishes, the agent speaks up on its own (`Agent.announce`): it waits for
a quiet moment and never cuts you off. The system prompt always carries a live one-line-per-session
summary, so "answer it" works without you naming the session when only one is waiting.

## The Claude Code view

- **Sessions** (left): one card per session with a live Claude mark, status, last line, cost/turns/age and queue size.
- **Header**: rename inline, open the folder, live stats, Interrupt / Stop, and a menu with Open in VS Code,
  Copy path, **Fresh start** and **Remove** (both ask twice; Remove keeps the folder on disk).
- **Activity**: the session's timeline. Each tool call is drawn for what it is: shell commands as a terminal with
  their output, edits as a red/green diff, new files as code, to-do lists as checklists, plans as Markdown, blocked
  actions in red. A side panel shows the plan's progress, the files it changed and where its tool calls went.
- **Files**: a live tree of the workspace (created `A` / modified `M` by Claude), a code/Markdown/image viewer,
  and Open / VS Code / Show in Explorer.
- **Preview**: web pages it builds, served read-only from the workspace over `ccws://` in a sandboxed frame
  (scripts run; no access to the app, no popups, no top navigation). Desktop/tablet/phone widths; reloads by
  itself when a tool finishes.

## Managing sessions

- **Remove**: from the ⋯ menu (keep the folder, or delete it) or **Select** in the sidebar to prune several at
  once. Deleting is only ever allowed for a session's own sandbox folder directly under the workspace root: never
  a project folder, never the root, never a folder another session still uses.
- **Where it works**: the New form offers a new sandbox folder, an existing workspace folder, or **Browse…** for a
  project folder (then it works in your real files, fenced to that folder).

## Modes: how much a session does on its own

Each session has a mode, switched live from the pill in its header, by voice ("put it on bypass", "plan it
first") or for new sessions in the New form; Settings holds the default (Auto; older settings with "ask before
shell commands" were moved to Auto).

| mode | what asks you |
|---|---|
| **Plan** | Nothing runs. The CLI's own plan mode: it reads and writes a plan; `ExitPlanMode` arrives as a plan card (and a spoken headline). Approve it into Ask/Auto/Bypass, or send it back with changes and it re-plans. |
| **Ask** | Every shell command, plus everything the fence asks about. |
| **Auto** | Only what the fence asks about: paths outside its folder, deletes, `git push`/`clean`/`reset --hard`, piping downloads into a shell, `reg`… |
| **Bypass** | Nothing, except a delete that reaches outside its folder. |

Machine-level commands (`format X:`, `diskpart`, `Clear-Disk`, `shutdown`, deleting a drive root or the home
folder) are refused in every mode. Approvals offer "approve, and stop asking" (switches to Auto, or Bypass for a
fence question); switching mode also lets through whatever is waiting that the new mode would not ask about.

The voice model stays light: statuses and announcements carry a plan's headline and step count, approvals a
few-word reason; `claude_details` (plan / answer / activity) reads more only when you ask for specifics.

## Your other sessions

**Your other sessions** (left rail of the view) lists the Claude Code sessions saved on this computer — from the
terminal, the IDE and other apps (`listSessions`, interactive ones only) — searchable and grouped by project. Any
of them opens read-only in the same rich timeline. **Continue here** attaches it:

- it works in that session's **real project folder** (badge *your project*), fenced to that folder; its mode
  decides what asks (deletes, paths outside it and pushes ask unless it is in Bypass);
- its first run **forks** the conversation (`forkSession`), so the original transcript, and your terminal, are untouched.

## Safety: the workspace fence

Every session is pinned to its own folder under **Workspace folder** (default
`D:\Downloads\VoiceAgentWorkspaces`), plus two scratch roots it may use freely: the temp dir (its own
background-task output) and `~/.claude/plans` (plan mode writes its plan there). A `PreToolUse` hook
(`src/core/claude/fence.ts`) runs before any permission logic and answers allow, **ask** or deny. An "ask"
reaches `canUseTool` with the reason (lab 07) and becomes a spoken yes/no; it covers:

- file tools (Read/Write/Edit/Glob/Grep…) on a path outside the folder (absolute, `..`, UNC,
  junction/symlink escapes, sibling-prefix tricks);
- shell commands (**`PowerShell`** on Windows, `Bash` elsewhere) that use a path outside the folder, run while
  the shell sits outside it, delete, push, or pipe a download into a shell. Paths are read like a shell would:
  quoted pieces joined (`"$D"/x`), variables set earlier in the command expanded, `$env:X`/`%X%`/`~` resolved,
  Git Bash `/d/...` mapped to `D:\...`, and `..` resolved against the shell's real current folder (the hook's
  `cwd` follows `cd`). Setting `$env:X = ...`, `--format=`, `cmd /c` and URLs are not paths.

MCP connectors and unknown tools are denied unless the session is in Bypass; scheduling tools
(`CronCreate`, `ScheduleWakeup`, `RemoteTrigger`) never run. The SDK's own sandbox is macOS/Linux only, so this
hook is the real gate. `permissionMode` is `plan` or `default`; `bypassPermissions` and bare `allowedTools` are
never used (Bypass is our own policy, so AskUserQuestion still reaches you).

### Billing: your subscription, never the API key

Sessions run on your own `claude` login (your plan's limits, the same five-hour window as interactive Claude
Code), not pay-per-token API credit. This machine has `ANTHROPIC_API_KEY` set for the voice agent's own LLM,
and the CLI prefers an env key over the login, so three things keep sessions on the subscription:

- `sessionEnv()` (`src/core/claude/sdk.ts`) strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*` provider switches from every session's environment.
- Every turn's `init` message reports `apiKeySource`. Anything other than `none` (e.g. an `apiKeyHelper`)
  stops the run before it does anything and marks the session errored ("about to bill an API key").
- The sidebar badge asks the CLI who it runs as (`accountInfo()`, no prompt, so no usage): green "Claude Max
  subscription · email", or amber if a key would be billed or the login can't be checked.

Verified live with `pnpm lab:auth` on 2026-10-24: scrubbed → `Claude Max`, your email, no key; with `--raw`
(no scrub) → `apiKeySource: ANTHROPIC_API_KEY`. The `$` figures in the view are usage priced at API rates,
covered by the plan, not charges. Use API-key auth before shipping this to other people.

## Layout

| piece | file |
|---|---|
| manager (queue, interrupt, stop/resume, pending prompts), SDK-free, injectable SDK | `src/core/claude/manager.ts` |
| real SDK adapter | `src/core/claude/sdk.ts` |
| fence policy | `src/core/claude/fence.ts` |
| digest / spoken announcements | `src/core/claude/digest.ts`, `announce.ts` |
| voice tools + prompt block | `src/core/tools/claude.ts`, `src/core/prompts/compose.ts` |
| service (persistence, quit), IPC | `src/main/services/claude.ts`, `src/main/ipc/register.ts` |
| shared types | `src/shared/claude.ts` |
| workspace listing/reading (fenced) | `src/core/claude/files.ts` |
| `ccws://` preview protocol, open in Explorer/VS Code | `src/main/services/claude.ts` (`serve`, `open`) |
| UI | `src/renderer/src/views/ClaudeView.tsx`, `views/claude/*` (Activity, Files, Preview, Inspector, feed logic), `state/claude.ts` |

Sessions persist in `userData/claude-sessions.json`. After a restart nothing is running; the next send
to a session resumes it by SDK session id, and a dropped connection (status `error`) recovers the same way.

## Testing

- `pnpm test` runs everything against a scripted fake SDK (no login, no cost).
- `lab/claude-sdk/` holds runnable experiments against the **real** SDK (`pnpm lab:interrupt`,
  `lab:ask-user`, `lab:permissions`, `lab:fence`, `lab:manager`); results live in
  `lab/claude-sdk/FINDINGS.md`. They only touch `D:\Downloads\VoiceAgentWorkspaces\lab`.
