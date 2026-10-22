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

## Your other sessions

**Your other sessions** (left rail of the view) lists the Claude Code sessions saved on this computer — from the
terminal, the IDE and other apps (`listSessions`, interactive ones only) — searchable and grouped by project. Any
of them opens read-only in the same rich timeline. **Continue here** attaches it:

- it works in that session's **real project folder** (badge *your project*), fenced to that folder: deletes, paths
  outside it and pushes stay blocked, and every shell command asks you, whatever the setting;
- its first run **forks** the conversation (`forkSession`), so the original transcript, and your terminal, are untouched.

## Safety: the workspace fence

Every session is pinned to its own folder under **Workspace folder** (default
`D:\Downloads\VoiceAgentWorkspaces`). A `PreToolUse` hook (`src/core/claude/fence.ts`) denies, before
any permission logic:

- file tools (Read/Write/Edit/Glob/Grep…) on any path outside the session's folder (absolute, `..`,
  UNC, junction/symlink escapes, sibling-prefix tricks);
- shell commands (the tool is **`PowerShell`** on Windows, `Bash` elsewhere; both are covered) that
  mention a path outside the folder, use `~`/`%VAR%`/`$env:`, or are destructive/system-level
  (`rm`, `del`, `rmdir`, `Remove-Item`, `format`, `git push`/`clean`, `reg`, pipes into a shell…);
- MCP connectors and any tool not on the allow-list (default deny).

The SDK's own sandbox is macOS/Linux only, so this hook is the real gate. On top, shell commands ask for
your approval by voice (`Settings → Ask before running shell commands`). `permissionMode` is always
`default`; `bypassPermissions` and bare `allowedTools` are never used (a bare entry skips `canUseTool`).

Sessions use your ambient `claude` login (same five-hour window as interactive Claude Code), with
`ANTHROPIC_API_KEY` stripped from their environment so a stale key can't break them. Fine for personal
use; use API-key auth before shipping this to other people.

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
