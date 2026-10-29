<div align="center">

<img src="docs/media/banner.jpg" alt="Voice Agent Harness: a harness for Claude Code" width="720" />

# Voice Agent Harness

### Run your Claude Code sessions by voice.

Talk to one agent. It starts and steers every coding session in parallel, asks you out loud before anything risky,<br/>and tells you when they're done. Built on the Claude Agent SDK, with a full voice loop of its own.

[![CI](https://github.com/nodeblackbox/voice-agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/nodeblackbox/voice-agent-harness/actions/workflows/ci.yml)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-4ADE80)

[**The tour**](#the-tour) · [**Features**](#everything-else-in-the-box) · [**Quick start**](#quick-start) · [**How it works**](#how-it-works) · [**Docs**](#documentation)

<br/>

<img src="docs/media/hero.gif" alt="Highlights: four sessions spun up by voice, a live timeline, a spoken status update, a question answered out loud, a plan approved, a live preview, the payoff" width="760" />

<sub>Thirty seconds of the real app: spin up four sessions, watch one work, ask how it's going, answer its question, approve a plan, preview the result.</sub>

</div>

<br/>

## Why

Running four Claude Code sessions sounds fast, until you are the one switching tabs. Which one finished? Which one has been waiting on you for ten minutes? That is the **context-switching tax**, and it eats the time the agents were supposed to save.

Voice Agent Harness is the fix I wanted: one agent you talk to. It spins the sessions up, queues your follow-ups, answers "how's the login fix going?" in a sentence, and only interrupts you when a session genuinely needs a decision. You hand off the work, do something else, and come back to review the results.

<table>
<tr>
<td width="50%" align="center"><img src="docs/media/problem.jpg" alt="Four terminals, one person switching between them" /><br/><sub><b>Before:</b> four terminals and you, switching tabs.</sub></td>
<td width="50%" align="center"><img src="docs/media/payoff-still.jpg" alt="By hand the sessions run one after another; with the harness they run side by side" /><br/><sub><b>After:</b> the sessions run side by side while you do something else.</sub></td>
</tr>
</table>

<br/>

## The tour

Every clip below is the real app, cut from the two-minute promo.

<table>
<tr>
<td width="55%"><img src="docs/media/deploy.gif" alt="Four Claude Code sessions starting from one spoken sentence" /></td>
<td>

### 1 · Spin up sessions by voice

*"Spin up four sessions: a pricing page, a users API, fix the login test, and update the README."*

Each one is a real Claude Code session in its own folder, and they all work at the same time. Say "all" to reach every session at once.

</td>
</tr>
<tr>
<td>

### 2 · Watch it work

Open any session and its timeline is live: shell commands render as a terminal, edits as diffs, to-do lists as checklists, plans as Markdown. A side panel tracks the plan's progress and every file changed.

</td>
<td width="55%"><img src="docs/media/activity.gif" alt="A session's live timeline with terminal output, a diff and a task list" /></td>
</tr>
<tr>
<td width="55%"><img src="docs/media/steer.gif" alt="A follow-up queued by voice while the session keeps working" /></td>
<td>

### 3 · Steer while it works

*"Oh, and add rate limiting to the API."* The follow-up is queued and runs when the current task finishes. Or stop the session and redirect it, by voice or with a click.

</td>
</tr>
<tr>
<td>

### 4 · Ask how it's going

*"Hey, how's the login fix going?"* gets one spoken sentence: *"Found the bug, an expired token check. All twelve tests pass now."* No scrolling through logs. The voice model sees a one-line brief per session and fetches details only when you ask.

</td>
<td width="55%"><img src="docs/media/status.gif" alt="A spoken status update about the login fix session" /></td>
</tr>
<tr>
<td width="55%"><img src="docs/media/question.gif" alt="A session asks which prices to show; the answer is given out loud" /></td>
<td>

### 5 · It asks, you decide

When a session needs a decision, it asks you out loud with numbered options. *"The third one."* A command that needs approval is a spoken yes or no.

</td>
</tr>
<tr>
<td>

### 6 · Approve plans, choose how much it asks

*"README has a plan ready. Want to approve it?" "Yep, go ahead."*

Each session runs in one of four modes: **Plan** (plans first, waits for your sign-off), **Ask** (every command checks with you), **Auto** (just works, fenced to its folder), **Bypass** (no prompts).

</td>
<td width="55%"><img src="docs/media/approve.gif" alt="A plan approved by voice" /><br/><img src="docs/media/modes.gif" alt="The four session modes: Plan, Ask, Auto, Bypass" /></td>
</tr>
<tr>
<td width="55%"><img src="docs/media/review.gif" alt="Reviewing changed files and a live preview of the built page" /></td>
<td>

### 7 · Review the result

Every file it changed, marked added or modified, with viewers for code, Markdown, images, video, audio and PDF. Web pages it builds get a live preview at desktop, tablet and phone widths.

</td>
</tr>
<tr>
<td>

### 8 · Continue any session

It lists the Claude Code sessions saved on your machine from the terminal and the IDE, and continues any of them here, on a copy. The original stays untouched.

</td>
<td width="55%"><img src="docs/media/resume.gif" alt="The list of Claude Code sessions started in the terminal and IDE" /></td>
</tr>
<tr>
<td width="55%"><img src="docs/media/fence.gif" alt="A command outside the session's folder waits for a yes or no" /></td>
<td>

### 9 · Fenced and safe

Each session is fenced to its own folder. Anything outside it, any delete, any push, asks you first. Machine-level commands are refused in every mode. Sessions run on your Claude login, never on an API key.

</td>
</tr>
<tr>
<td>

### 10 · Ask it afterwards

*"What did it just do?"* gives a spoken digest of the last turn; *"read me the plan"* goes deeper. Session timelines are saved, so the answers survive a restart, and every voice turn is written to a structured trace you can open in the Diagnostics view.

</td>
<td width="55%"><img src="docs/media/payoff.gif" alt="Stop babysitting terminals: hand off the work, come back to review" /></td>
</tr>
</table>

<br/>

## Everything else in the box

| | |
|---|---|
| 🎙️ **A real voice loop** | Parakeet speech recognition on your GPU, an end-of-turn model instead of a silence timer, replies that start speaking after the first sentence, barge-in that cancels everything in about 100 ms, and "go on" that resumes from the exact cut. |
| 🔊 **Any voice** | Edge TTS by default (free, keyless), Kokoro as the local fallback, or ElevenLabs, Fish Audio, Inworld and Qwen with their voices and models listed live in Settings. Expressive engines get `[laughs]`-style delivery cues from the model. |
| 🧠 **Any brain** | Anthropic, OpenAI, Groq, Google Gemini or xAI. Only providers you have a key for are offered, and a rate-limited or failing model falls through to the next one mid-turn. |
| 🗂️ **Memory and projects** | SQLite with full-text search, global and per-project, with a history and undo. Projects carry a folder, notes and a default prompt style. |
| 🧩 **Styles, skills, MCP** | Prompt styles drafted with AI, trigger-and-procedure skills, any MCP server (stdio or streamable HTTP) added from Settings. |
| 🔎 **Local web search** | SearXNG started on demand, with `web_search`, `read_page` and `research` tools. |
| 🎛️ **Tuning and diagnostics** | Every timing parameter documented in-app, an advisor that reads your session and suggests values, a per-turn latency timeline. |
| 🌗 **Light and dark** | Both themes, or follow the system. |

<table>
<tr>
<td width="50%" align="center"><img src="docs/media/screenshot-claude.png" alt="The Claude Code view in the dark theme" /><br/><sub>The Claude Code view: four sessions, one open on its timeline</sub></td>
<td width="50%" align="center"><img src="docs/media/screenshot-chat.png" alt="Asking about a session from the chat" /><br/><sub>The chat: "How's the login fix going?" answered from the session</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/media/screenshot-voice.png" alt="Voice output settings with Inworld selected" /><br/><sub>Voice output: engine, model and voice listed live, cues, proxy</sub></td>
<td width="50%" align="center"><img src="docs/media/screenshot-claude-light.png" alt="The Claude Code view in the light theme" /><br/><sub>The light theme</sub></td>
</tr>
</table>

<br/>

## Quick start

**Requirements:** Node.js 22.13+ and [pnpm](https://pnpm.io) 10, plus one LLM API key (Anthropic, OpenAI, Groq, Gemini or xAI). Python 3.11 and [uv](https://docs.astral.sh/uv/) for voice input; an NVIDIA GPU with a CUDA 12 driver makes it fast (CPU works). Claude Code sessions need a Claude login. Developed and tested on Windows 11; macOS and Linux are untested.

```powershell
git clone https://github.com/nodeblackbox/voice-agent-harness.git
cd voice-agent-harness
pnpm install

copy .env.example .env        # then add at least one API key (or paste it in Settings > Providers)
pnpm dev
```

That is enough for typed chat, the Claude Code view, memory, projects and the Edge voice. Keys are read only by the Electron main process, and stored encrypted when pasted in Settings; they never reach the renderer.

<details>
<summary><b>Enable voice input</b></summary>

```powershell
pnpm sidecar:install          # sidecar/.venv with uv: the ears and Kokoro, plus the Smart Turn model (9 MB)
```

Press **Voice** (or `Ctrl+Shift+Space` while the window is focused) and talk. The first start downloads Parakeet (about 600 MB) into the Hugging Face cache; Kokoro (330 MB) follows the first time Edge TTS is unreachable. No NVIDIA GPU: set **Settings → Voice input → Device** to `cpu`. Headphones recommended.

</details>

<details>
<summary><b>Enable Claude Code sessions</b></summary>

1. `npm i -g @anthropic-ai/claude-code`, then `claude` and `/login` once.
2. In the app, open the **Claude Code** view (the robot in the rail) and switch sessions on. The badge shows the login they will use.

Sessions get their own folders under `Documents\VoiceAgentWorkspaces` (changeable), or work in a project folder you pick.

</details>

<details>
<summary><b>Pick a voice</b></summary>

Add a key for ElevenLabs, Fish Audio, Inworld or Qwen (in `.env` or **Settings → Providers**), then choose it under **Settings → Voice output**: the model and voice lists come straight from the provider. Inworld's TTS-2 Flash was the quickest in testing, at about 200 ms to first audio. If Edge is slow for you, Microsoft is probably throttling your IP: put a proxy in `TTS_PROXY` and switch the Edge toggle on. `pnpm tts:latency` measures every route.

</details>

## Configuration

Everything lives in `.env` (copied from `.env.example`). Keys pasted in **Settings → Providers** win over `.env`.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GROQ_API_KEY` · `GOOGLE_GENERATIVE_AI_API_KEY` · `XAI_API_KEY` | At least one. `GROQ_KEYS` takes a list of Groq keys to rotate. |
| `ELEVENLABS_API_KEY` · `FISH_API_KEY` · `INWORLD_API_KEY` · `DASHSCOPE_API_KEY` | Hosted voices; each has `*_VOICE_ID` and `*_MODEL` defaults (`QWEN_*` for Qwen, plus `DASHSCOPE_HOST` for a workspace endpoint). |
| `TTS_PROXY` | `http://user:pass@host:port`, switched on per engine in Settings. |
| `VA_PYTHON` | Python for the ear sidecar when it is not `sidecar/.venv`. |
| `RECORD_TRAINING_DATA` · `RECORD_DIR` | Opt-in voice-clone dataset capture ([docs/TRAINING_RECORDING.md](docs/TRAINING_RECORDING.md)). |

Model, backup model, prompt style, voice, microphone, theme, session modes, workspace folder and every timing parameter are changed in-app under **Settings**. [docs/SETUP.md](docs/SETUP.md) is the step-by-step version, with every download and where it lands.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Electron + Vite with hot reload |
| `pnpm build` | Production build into `out/` |
| `pnpm check` | Typecheck and the TypeScript test suite |
| `pnpm test` · `pnpm test:coverage` · `pnpm test:py` | Vitest (core, main, renderer) · with coverage · pytest for the sidecars, no GPU needed |
| `pnpm sidecar:install` · `pnpm searxng:install` | The Python ears and Kokoro · local web search from source |
| `pnpm tts:latency -- --proxies proxies.txt` | Time to first audio for every voice you have a key for, direct and through each proxy |
| `pnpm lab:*` | Runnable experiments against the real Claude Agent SDK, with findings in `lab/` |

`VA_USER_DATA=<dir>` before `pnpm dev` runs against a separate data folder. `VA_SAY`, `VA_WAV`, `VA_VIEW` and `VA_SCREENSHOT` drive the app for tests and screenshots (see `.env.example`).

## How it works

```
mic ─► renderer (16 kHz) ─ws─► ear sidecar: Silero VAD ─ Smart Turn v3.2 ─ Parakeet ─► text
    ─► agent core: prompt + memory + tools ─► LLM stream ─► SentenceChunker ─► voice engine ─► audio
    ─► claude_* tools ─► Claude Agent SDK sessions (one per folder, fenced) ─► digests, questions, "done"
you talk over it ─► sidecar "barge-in" ─► audio stops, model and tools cancelled, the cut point is remembered
```

The brain stays in Electron, where it holds the keys, the memory and the Claude session manager. The ear sidecar is only ears, so it stays small and swappable. Every voice engine turns one sentence into audio behind the same interface, so streaming, barge-in, retries and the Kokoro fallback work for all of them. Each Claude Code session does its heavy work in its own context; the voice model sees a one-line brief per session and fetches details on demand, which is why it still answers in about a second after an hour of parallel sessions.

| Layer | Tech |
|---|---|
| Shell & UI | Electron 44, React 19, Tailwind, Zustand |
| Agent core | TypeScript with no Electron imports: Vercel AI SDK providers, prompt composition, turn runner, SQLite FTS5 memory |
| Claude Code | Claude Agent SDK, per-session fence, Plan / Ask / Auto / Bypass modes, persisted timelines |
| Voice | Python ear sidecar (Silero VAD, Smart Turn v3.2, Parakeet TDT 0.6B v2 on ONNX Runtime), Edge TTS, Kokoro-82M, ElevenLabs, Fish Audio, Inworld, Qwen-Audio TTS |
| Models | Anthropic, OpenAI, Groq, Google Gemini, xAI, streamed, with prompt caching on the stable half of the system prompt |
| Search & tools | SearXNG (local), MCP servers (stdio and streamable HTTP), first-party tools |

## Documentation

- [Architecture](docs/ARCHITECTURE.md): processes, the life of a turn, interruption, prompt composition, the error policy.
- [Claude Code sessions](docs/CLAUDE_SESSIONS.md): voice-managed sessions, modes, the fence, what the agent can tell you afterwards.
- [Setup](docs/SETUP.md): a fresh machine to a working install, every download and where it lands, troubleshooting.
- [Extending](docs/EXTENDING.md): add a provider, a voice, a tool, an MCP server, a style, a tuning parameter. [AGENTS.md](AGENTS.md) is the one-page map for coding agents.
- [Tuning](docs/TUNING.md) and [Debugging](docs/DEBUGGING.md): every parameter, every trace event, the Diagnostics view.
- [Training recording](docs/TRAINING_RECORDING.md): the opt-in voice-clone capture mode. [sidecar/PROTOCOL.md](sidecar/PROTOCOL.md) is the ears' wire protocol.

## Roadmap

- [ ] Packaged installer with the sidecars bundled (today you run from source).
- [ ] Playbooks for sessions: "when X finishes, …", auto-answer rules, stacked-prompt templates, image hand-off.
- [ ] The agent itself as an MCP server.
- [ ] Semantic memory behind the same `recall` interface (today: FTS5 BM25).
- [ ] Streaming audio from the hosted voices instead of per-sentence buffers.
- [ ] macOS and Linux (the sidecar launcher and the fence's shell parsing are Windows-first).

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please never commit `.env` or paste live keys into issues or logs.

## License

MIT © 2026 Anas Nasseur
