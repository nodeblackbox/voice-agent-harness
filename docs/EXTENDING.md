# Extending Voice Agent

How to add the things people most often want to add. Each recipe lists the files in the order you touch
them and the test that proves it. Written for people and for coding agents alike: if you are an agent, read
[../AGENTS.md](../AGENTS.md) first for the ground rules.

## Ground rules

- `src/core` has **no Electron imports** and no file paths of its own; it is unit-tested with mocks. Anything
  that touches the OS (files, processes, windows) lives in `src/main/services`.
- Every IPC channel is a name in `src/shared/ipc.ts`, a handler in `src/main/ipc/register.ts`, and a typed
  method on `window.api` in `src/preload/index.ts`. The renderer never imports from main or core.
- Tests sit next to the code (`x.ts` → `x.test.ts`), vitest for TypeScript, pytest for Python. `pnpm check`
  runs typecheck and tests.
- **No personal defaults.** Paths come from Electron (`app.getPath`), the user's settings or environment
  variables; devices from the system default. Nothing in the tree should name a drive, a user or a product.

## Add an LLM provider

The providers are the [Vercel AI SDK](https://ai-sdk.dev) packages, so most of the work is wiring.

1. `pnpm add @ai-sdk/<provider>` on the same `@ai-sdk/provider` major as the others (check
   `node_modules/@ai-sdk/provider/package.json`; the typecheck fails loudly on a mismatch).
2. `src/shared/types.ts`: add the id to the `Provider` union.
3. `src/core/providers/models.ts`: `PROVIDER_LABELS`, then the models with `m(provider, modelId, label, { fast?, note? })`.
   Mark the cheap, quick one `fast`: it is what `resolveModel` picks when the user's choice has no key.
4. `src/core/providers/factory.ts`: a `case` in `create()` returning `createX({ apiKey })(info.model)`.
5. `src/main/services/settings.ts`: the environment variable names in `ENV_KEYS`.
6. `src/renderer/src/views/SettingsView.tsx`: a row in `PROVIDERS`.
7. `.env.example`: the variable with a comment.
8. Tests: `providers.test.ts` already creates a model for every entry in `MODELS`; add a `findModel` case and a
   `settings.test.ts` case that reads the variable.

If the provider needs special request options (reasoning effort, caching), look at how `runner.ts` builds
`providerOptions` per provider.

## Add a tool the voice model can call

1. Write it in `src/core/tools/<name>.ts` with the AI SDK `tool()` helper: a zod input schema with
   descriptions (the model reads them), and an `execute` that takes the turn's `AbortSignal` so barge-in
   cancels it. Return short, speakable results; long text goes in the transcript, not the voice.
2. Register it in `Agent.tools()` in `src/core/agent.ts`, gated on whatever it needs (a key, a service, a
   setting), so it is simply absent when unavailable.
3. `src/core/speech/fillers.ts`: a label for the spoken filler ("let me check the calendar").
4. `src/core/tools/describe.ts`: how its call and result read in the transcript pill.
5. Test it with the mock LLM pattern in `src/core/tools/*.test.ts`.

A tool that needs the OS goes through a service: see `searchTools` and `SearchDeps` for the shape.

## Add an MCP server

No code. Add it to `mcp/mcp.json` (or `%APPDATA%\Voice Agent\mcp.json`, which overrides the repo copy), or
from **Settings → MCP**. `${ROOT}` is the repo, `${PROJECT_PATH}` the active project's folder, `${NODE}`
the app's own Node runtime. Tools from enabled servers are offered to the model with the server name as a
prefix; each server has its own log in Settings.

## Add a voice (TTS engine)

1. Implement `TtsEngine` from `src/core/speech/tts.ts`: `synth(text, signal)` yields MP3 chunks.
2. Add the engine id to `VoiceSettings.engine` in `src/shared/types.ts` and the picker in
   `SettingsView.tsx` (`VoiceOutput`).
3. `Agent.engineFor()` in `src/core/agent.ts` chooses the engine; the Kokoro one shows how a local process
   is started on demand (`src/main/services/kokoro.ts`) and how `EdgeHealth` decides when to fall back.

## Add a prompt style or a skill

Both can be made in the app (Prompts and Skills views, with AI drafting). Built-ins live in
`src/core/prompts/styles.ts` and `skills.ts`; a style is a complete system prompt body plus a length and a
format axis, a skill is a trigger and a procedure the model reads before acting.

## Add a tuning parameter

1. `src/shared/tuning.ts`: the key in its group with `min`, `max`, `step`, a default and a one-line doc.
   The Settings UI, validation, migration and `docs/TUNING.md` all read this schema.
2. Use it from `settings.<group>.<key>` where the behaviour lives.
3. `docs/TUNING.md`: a paragraph on what it trades off.

## Add a Claude Code voice command

The `claude_*` tools in `src/core/tools/claude.ts` wrap `ClaudeSessionManager` (`src/core/claude/manager.ts`,
SDK-free, tested with a scripted fake SDK in `manager.test.ts`). Add the manager method first with its
test, then the tool, then a line in the `CLAUDE_RULES` block of `src/core/prompts/compose.ts` so the model
knows when to use it. Anything the fence should ask about or refuse goes in `src/core/claude/fence.ts`,
which has the most thorough tests in the repo.

## Add a view

A view is a component in `src/renderer/src/views`, an entry in `NAV` in `App.tsx`, and a `View` id in
`state/store.ts`. Use the primitives in `components/primitives.tsx` and the tokens in `theme.ts` (never a
literal colour: both themes must work; `alpha(T.x, pct)` for tints).
