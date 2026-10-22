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

When a session needs you, or finishes, the agent speaks up on its own (`Agent.announce`): it waits for
a quiet moment and never cuts you off. The system prompt always carries a live one-line-per-session
summary, so "answer it" works without you naming the session when only one is waiting.

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
| UI | `src/renderer/src/views/ClaudeView.tsx`, `state/claude.ts` |

Sessions persist in `userData/claude-sessions.json`. After a restart nothing is running; the next send
to a session resumes it by SDK session id, and a dropped connection (status `error`) recovers the same way.

## Testing

- `pnpm test` runs everything against a scripted fake SDK (no login, no cost).
- `lab/claude-sdk/` holds runnable experiments against the **real** SDK (`pnpm lab:interrupt`,
  `lab:ask-user`, `lab:permissions`, `lab:fence`, `lab:manager`); results live in
  `lab/claude-sdk/FINDINGS.md`. They only touch `D:\Downloads\VoiceAgentWorkspaces\lab`.
