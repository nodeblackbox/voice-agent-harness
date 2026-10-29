# Setup, step by step

A fresh Windows 11 machine to a working Voice Agent Harness, with every download named and where it lands. The
short version is in the [README](../README.md#getting-started).

## 1. Tools

| Tool | Why | Check |
|---|---|---|
| Node 22.13 or newer | the app, and `node:sqlite` for memory | `node -v` |
| pnpm 10 | package manager (`corepack enable` or `npm i -g pnpm`) | `pnpm -v` |
| Python 3.11 | the ears (Parakeet, Silero, Smart Turn) and the Kokoro voice | `python --version` |
| [uv](https://docs.astral.sh/uv/) | creates the Python environments quickly | `uv --version` |
| NVIDIA driver with CUDA 12 support | Parakeet on the GPU (optional, see CPU mode) | `nvidia-smi` |
| Claude Code CLI (optional) | logging in once for voice-managed sessions | `claude --version` |

## 2. Clone and install

```powershell
git clone https://github.com/nodeblackbox/voice-agent-harness.git
cd voice-agent-harness
pnpm install
```

`pnpm install` also fetches the Claude Agent SDK, which bundles the Claude Code binary it needs; nothing
else to install for sessions.

## 3. Keys

Copy `.env.example` to `.env` and fill in the providers you have. Every provider is optional; the app only
offers models whose provider has a key, and falls back to one that does if your chosen model's provider has
none. Keys can also be pasted in **Settings → Providers** (stored encrypted in the app data folder); those
win over `.env`.

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude Haiku 4.5 is the default model) |
| `OPENAI_API_KEY` | OpenAI |
| `GROQ_API_KEY`, or `GROQ_KEYS` as a list to rotate | Groq |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini |
| `XAI_API_KEY` | xAI Grok |

Edge TTS (the default voice) needs no key. For a hosted voice add its key too and pick it under **Settings →
Voice output**; the engine picker only offers providers that have a key.

| Variable | Voice provider | Also |
|---|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs (free tier works) | `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` |
| `FISH_API_KEY` | Fish Audio (`s2.1-pro-free` needs no credit) | `FISH_VOICE_ID`, `FISH_MODEL` |
| `INWORLD_API_KEY` | Inworld (the Base64 credential, as given) | `INWORLD_VOICE_ID`, `INWORLD_MODEL` |
| `DASHSCOPE_API_KEY` | Qwen on Alibaba Model Studio | `DASHSCOPE_HOST` (your workspace host), `QWEN_VOICE_ID`, `QWEN_MODEL` |

`TTS_PROXY` (`http://user:pass@host:port`) is the proxy the Voice output section can switch on for Edge and for
the hosted voices; Microsoft throttles the free Edge voice per IP address, and `pnpm tts:latency -- --proxies
proxies.txt` shows which route is fastest for you.

## 4. The ears

```powershell
pnpm sidecar:install
```

This runs `sidecar/install.ps1`: it creates `sidecar/.venv` with uv, installs `sidecar/requirements.txt`
(onnxruntime-gpu, the CUDA 12.4 runtime wheels, silero-vad, kokoro, misaki and the spaCy English model;
torch comes along as silero's dependency but is never imported, so expect a few GB on disk), and downloads
the Smart Turn model.

| Model | Size | Where it lands | When |
|---|---|---|---|
| Smart Turn v3.2 (end-of-turn) | 9 MB | `models/smart-turn-v3.2-cpu.onnx` | during `sidecar:install` |
| Silero VAD v5 | 2 MB | inside the `silero-vad` package | during `sidecar:install` |
| Parakeet TDT 0.6B v2 (speech to text) | about 600 MB | the Hugging Face cache (`%USERPROFILE%\.cache\huggingface`, or `HF_HOME`) | the first time the ears start |
| Kokoro-82M (fallback voice) | about 330 MB | the Hugging Face cache | the first time Edge TTS is unreachable |

The first voice start therefore takes a while: watch the **Ears** status in the header, or `app.log`.

**No NVIDIA GPU?** Set **Settings → Voice input → Device** to `cpu`. The default `hybrid` keeps the
encoder on CUDA and the decoder on the CPU; without CUDA the ears exit with code 3 and the app tells you to
switch.

**An existing environment?** Any venv with the same pins works. Point `stt.pythonPath` in
`%APPDATA%\Voice Agent\settings.json` at its `python.exe`, or set `VA_PYTHON`; the lookup order is the
setting, `VA_PYTHON`, `sidecar\.venv\Scripts\python.exe`, then `python` on PATH.

## 5. Web search (optional)

```powershell
pnpm searxng:install
```

Downloads SearXNG from source into `search/searxng-src`, creates `search/.venv-searxng`, and writes
`search/settings.local.yml` with a generated secret. Then **Settings → Web search → Start now** once;
afterwards the agent starts it on demand. Without it the search tools are simply not offered to the model.

## 6. Claude Code sessions (optional)

Sessions run through the Claude Agent SDK on **your Claude login**, never on an API key: the app strips
`ANTHROPIC_API_KEY` from every session's environment and refuses to run one that would bill a key.

1. Install the CLI and log in once: `npm i -g @anthropic-ai/claude-code`, then `claude` and `/login`.
2. In the app, open the **Claude Code** view (the robot in the rail) and switch sessions on. The badge
   in the sidebar shows the login they will use.
3. Sessions get their own folders under the **Workspace folder** (default: `Documents\VoiceAgentWorkspaces`),
   or work in a project folder you pick.

## 7. Run

```powershell
pnpm dev
```

Press **Voice** and talk, or type. The first launch creates the app data folder:

| Path (`%APPDATA%\Voice Agent\`) | Holds |
|---|---|
| `settings.json`, `keys.json`, `styles.json`, `skills.json` | settings, encrypted keys, custom styles and skills |
| `memory.sqlite` | memory entries, projects, chat sessions |
| `claude-sessions.json`, `claude-events.json` | the Claude session list and each session's timeline |
| `logs/app.log`, `logs/errors.log`, `logs/sessions/*.jsonl` | logs and per-turn traces |
| `training/raw` | voice-clone takes, only in recording mode |

Delete the folder to start over. To try the fresh-user experience without touching your own data, run with
`VA_USER_DATA=<some empty folder>`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No API key yet" banner in the chat | no provider has a key: add one in Settings → Providers or `.env` |
| "No key for X: using Y" toast | your chosen model's provider has no key; the agent used another. Add the key or pick a model from the picker (locked ones say why) |
| Ears exit code 3, "CUDA is not available" | no usable CUDA; set the STT device to `cpu` |
| Ears exit code 1, "model load failed" | the first Parakeet download was interrupted, or Smart Turn is missing: rerun `pnpm sidecar:install`, check `HF_HOME` has space |
| "ears crashed 3 times" | see `logs/app.log`; most often a Python path pointing at an old venv |
| Voice switched to Kokoro, toast about Edge | Edge TTS rate-limited you; the app probes it in the background and announces when it is back. Kokoro needs the sidecar venv. Slow first audio from Edge (2 s and more) usually means your IP is throttled: set `TTS_PROXY` and switch the Edge toggle on |
| "ElevenLabs 404: voice_not_found" or "402" toast | the voice id is not on that account, or the account is out of credit; the turn finishes on Kokoro. Pick a listed voice or the free model |
| The engine picker shows "no key" on a voice | add the provider's key in Settings → Providers or `.env` |
| "Couldn't check your Claude login" | run `claude` in a terminal and `/login`, then press the refresh icon on the badge |
| `node:sqlite` error at startup | Node older than 22.13 |
| A `tests` package in site-packages breaks `pytest` | the suite is a regular package so it should not; if it does, run `pnpm test:py` from the repo root |
