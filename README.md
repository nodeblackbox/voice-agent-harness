<div align="center">

# Voice Agent Harness

**Run your Claude Code sessions by voice.**

A desktop harness for Claude Code: you talk to one agent, it starts and steers every coding session in parallel, asks you out loud before anything risky, and tells you when they're done. Built on the Claude Agent SDK, with a full voice loop of its own.

[![CI](https://github.com/nodeblackbox/voice-agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/nodeblackbox/voice-agent-harness/actions/workflows/ci.yml)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-4ADE80)

<img src="docs/demo.gif" alt="Voice Agent Harness in action: four Claude Code sessions started by voice, one opened on its live timeline, a plan approved out loud" width="800" />

*A 17-second cut of the real app: four sessions spun up by voice, one opened on its live timeline, a plan approved out loud.*

</div>

## Why

Running four Claude Code sessions sounds fast, until you are the one switching tabs. Which one finished? Which one has been waiting on you for ten minutes? That is the context-switching tax, and it eats the time the agents were supposed to save.

Voice Agent Harness is the fix I wanted: one agent you talk to. It spins the sessions up, queues your follow-ups, answers "how's the login fix going?" in a sentence, and only interrupts you when a session genuinely needs a decision. You hand the work off, do something else, and come back to review.

**Watch the 2-minute walkthrough:** add the video link here (LinkedIn / YouTube).

## Features

| | |
|---|---|
| 🗣️ **Spin up sessions by voice** | "Start four sessions: a pricing page, a users API, fix the login test, update the README." Each is a real Claude Code session in its own folder, all working at once. |
| 👀 **Watch it work** | Every session has a live timeline: shell commands as a terminal, edits as diffs, new files as code, to-do lists as checklists, plans as Markdown. |
| 🎯 **Steer while it works** | Queue follow-ups ("oh, and add rate limiting"), or stop it and redirect. "All" reaches every session. |
| ❓ **It asks, you decide** | When a session needs a decision it asks out loud with numbered options. "The third one." A command that needs approval is a spoken yes or no. |
| 🎚️ **Choose how much it asks** | Per session: **Plan** (plans first, waits for sign-off), **Ask** (every command checks), **Auto** (just works, fenced to its folder), **Bypass** (no prompts). |
| 📋 **Ask it afterwards** | "What did it just do?" gives a spoken digest of the last turn; "read me the plan" goes deeper. Timelines survive a restart. |
| 🔍 **Review the result** | Every changed file, marked added or modified; code, Markdown, image, video, audio and PDF viewers; a live preview of web pages it builds at desktop, tablet and phone widths. |
| ♻️ **Continue any session** | Lists the Claude Code sessions saved on your machine from the terminal and IDE, and continues any of them on a copy. |
| 🔒 **Fenced and safe** | Each session is fenced to its folder. Anything outside it, any delete or push, asks first. Machine-level commands are refused in every mode. Sessions run on your Claude login, never on an API key. |
| 🎙️ **A real voice loop** | Parakeet ears on your GPU, an end-of-turn model instead of a silence timer, replies that start speaking after the first sentence, barge-in that cancels everything in about 100 ms, "go on" that resumes from the cut. |
| 🔊 **Any voice** | Edge TTS by default (free, keyless), Kokoro as the local fallback, or ElevenLabs, Fish Audio, Inworld and Qwen with their voices and models listed in Settings. Expressive engines get `[laughs]`-style cues from the model. |
| 🧠 **Any brain** | Anthropic, OpenAI, Groq, Google Gemini or xAI; only providers you have a key for are offered, and a rate-limited or failing model falls through to the next one mid-turn. |
| 🧰 **The rest of an assistant** | Memory with history and undo, projects, prompt styles, skills, MCP servers, local web search (SearXNG), a tuning page with an advisor, light and dark themes. |

<div align="center">
<table>
<tr>
<td align="center"><img src="docs/screenshot-claude.png" alt="The Claude Code view: four sessions, one open on its activity timeline" width="420" /><br/><sub>Four sessions; one open on its timeline (commands, edits, tests, result)</sub></td>
<td align="center"><img src="docs/screenshot-chat.png" alt="Asking how the login fix is going; the agent checks the session and answers" width="420" /><br/><sub>"How's the login fix going?" is answered in one sentence</sub></td>
</tr>
</table>
</div>

## Quick start

**Requirements:** Node.js 22.13+ and [pnpm](https://pnpm.io) 10, plus one LLM API key (Anthropic, OpenAI, Groq, Gemini or xAI). Python 3.11 and [uv](https://docs.astral.sh/uv/) are needed for voice input; an NVIDIA GPU with a CUDA 12 driver makes it fast (CPU works). Claude Code sessions need a Claude login. Developed and tested on Windows 11; macOS and Linux are untested.

```powershell
git clone https://github.com/nodeblackbox/voice-agent-harness.git
cd voice-agent-harness
pnpm install

copy .env.example .env        # then add at least one API key (or paste it in Settings > Providers)
pnpm dev
```

That is enough for typed chat, the Claude Code view, memory, projects and the Edge voice. Keys are read only by the Electron main process (and stored encrypted when pasted in Settings); they never reach the renderer.

### Enable voice input (optional)

```powershell
pnpm sidecar:install          # creates sidecar/.venv with uv, installs the ears and Kokoro, downloads Smart Turn (9 MB)
```

Press **Voice** (or `Ctrl+Shift+Space` while the window is focused) and talk. The first start downloads Parakeet (about 600 MB) into the Hugging Face cache; Kokoro (330 MB) follows the first time Edge TTS is unreachable. No NVIDIA GPU: set **Settings → Voice input → Device** to `cpu`. Headphones are recommended.

### Enable Claude Code sessions (optional)

1. `npm i -g @anthropic-ai/claude-code`, then `claude` and `/login` once.
2. In the app, open the **Claude Code** view (the robot in the rail) and switch sessions on. The badge shows the login they will use.

Sessions get their own folders under **Documents\VoiceAgentWorkspaces** (changeable), or work in a project folder you pick.

## Configuration

Everything lives in `.env` (copied from `.env.example`); keys can also be pasted in **Settings → Providers**, where they win over `.env`.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `XAI_API_KEY` | At least one. `GROQ_KEYS` holds a list of Groq keys to rotate. |
| `ELEVENLABS_API_KEY`, `FISH_API_KEY`, `INWORLD_API_KEY`, `DASHSCOPE_API_KEY` | Hosted voices; each has `*_VOICE_ID` and `*_MODEL` defaults (`QWEN_*`, plus `DASHSCOPE_HOST` for a workspace endpoint). |
| `TTS_PROXY` | `http://user:pass@host:port`, switched on per engine in Settings. Microsoft throttles the free Edge voice per IP. |
| `VA_PYTHON` | Python for the ear sidecar when it is not `sidecar/.venv`. |
| `RECORD_TRAINING_DATA`, `RECORD_DIR` | Opt-in voice-clone dataset capture ([docs/TRAINING_RECORDING.md](docs/TRAINING_RECORDING.md)). |

Model, backup model, prompt style, voice, microphone, theme, session modes, workspace folder and every timing parameter are changed in-app under **Settings**. [docs/SETUP.md](docs/SETUP.md) is the step-by-step version with every download and where it lands.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Electron + Vite with hot reload |
| `pnpm build` | Production build into `out/` |
| `pnpm check` | Typecheck and the TypeScript test suite |
| `pnpm test` · `pnpm test:coverage` · `pnpm test:py` | Vitest (core, main, renderer) · with coverage · pytest for the sidecars, no GPU needed |
| `pnpm sidecar:install` · `pnpm searxng:install` | The Python ears and Kokoro · local web search from source |
| `pnpm tts:latency -- --proxies proxies.txt` | Time-to-first-audio for every voice you have a key for, direct and through each proxy |
| `pnpm lab:*` | Runnable experiments against the real Claude Agent SDK, with findings in `lab/` |

Set `VA_USER_DATA=<dir>` before `pnpm dev` to run against a separate data folder; `VA_SAY`, `VA_WAV`, `VA_VIEW` and `VA_SCREENSHOT` drive the app for tests and screenshots (see `.env.example`).

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
| Claude Code | Claude Agent SDK, per-session fence, Plan / Ask / Auto / Bypass modes, timeline persistence |
| Voice | Python ear sidecar (Silero VAD, Smart Turn v3.2, Parakeet TDT 0.6B v2 on ONNX Runtime), Edge TTS, Kokoro-82M, ElevenLabs, Fish Audio, Inworld, Qwen-Audio TTS |
| Models | Anthropic, OpenAI, Groq, Google Gemini, xAI, streamed; prompt caching on the stable half of the system prompt |
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
