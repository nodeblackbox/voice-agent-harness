# Working on Voice Agent Harness (for coding agents and new contributors)

Voice Agent Harness is an Electron + TypeScript desktop app with two small Python sidecars. It is a voice harness for
Claude Code sessions and a voice assistant. Read this, then [docs/EXTENDING.md](docs/EXTENDING.md) for recipes
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map.

## Commands

```
pnpm install            deps (Node 22.13+, pnpm 10)
pnpm dev                run the app
pnpm check              typecheck + vitest (what CI runs for TypeScript)
pnpm test -- <path>     one test file
pnpm test:py            pytest for the sidecar (no GPU needed)
pnpm sidecar:install    Python venv + models (only needed to use the ears)
```

## Layout

| Where | What | Rule |
|---|---|---|
| `src/core` | agent, providers, prompts, turn runner, speech, tools, memory, Claude session manager | no Electron, no file paths; everything injectable and unit-tested |
| `src/main` | Electron main: window, IPC registry (`ipc/register.ts`), services (sidecar, kokoro, searxng, mcp, claude, settings, log) | the only place that touches the OS |
| `src/renderer` | React UI, zustand store (`state/store.ts`), audio capture/playback, `views/claude` | talks to main only through `window.api` |
| `src/preload` | the typed `window.api` bridge | one method per IPC channel |
| `src/shared` | types, IPC channel names, tuning schema | imported by every layer |
| `sidecar/ear`, `sidecar/mouth` | Python: VAD + turn + ASR; Kokoro TTS | protocol in `sidecar/PROTOCOL.md` |
| `lab/` | experiments against the real Claude Agent SDK; findings log | not part of the build or tests |

## Conventions

- Tests next to the code; add one with every behaviour change. Renderer tests use jsdom and mock
  `window.api` (see `views/ClaudeView.test.tsx` for the pattern).
- Colours only through `T` in `src/renderer/src/theme.ts` (CSS variables; dark and light). Use
  `alpha(T.x, pct)` for tints. Terminal and media panels use the fixed `TERM` and `MEDIA` palettes.
- Settings: add the field to `src/shared/types.ts`, a default in `src/main/services/settings.ts`
  (`DEFAULT_SETTINGS`, deep-merged over stored files so old settings keep working), a control in
  `SettingsView.tsx`.
- Timing and thresholds are tuning parameters in `src/shared/tuning.ts`, never magic numbers.
- Every turn event is traced (`trace(...)`); `docs/DEBUGGING.md` lists the vocabulary. Add events for new
  behaviour so Diagnostics can show it.
- **No personal defaults**: no drive letters, user names, device brands or product paths in code or docs.
  Paths come from `app.getPath`, settings or environment variables.
- Claude Code sessions must keep billing the user's login: never pass `ANTHROPIC_API_KEY` into a session
  (`sessionEnv()` in `src/core/claude/sdk.ts`), and anything new a session can do goes through the fence
  (`src/core/claude/fence.ts`).
- Commit messages describe behaviour for the user, not the diff.

## Dev hooks

`VA_USER_DATA=<dir>` runs against a separate data folder: use it for anything that would touch the
developer's own settings or memory. `VA_SAY`, `VA_VIEW`, `VA_SCREENSHOT` drive the app for screenshots and
smoke tests; the full list is in `.env.example`.
