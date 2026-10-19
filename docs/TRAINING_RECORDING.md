# Training recording mode

An opt-in mode for building a voice-clone dataset (Fish Audio) from your own speech while you talk
to the agent. With it off (the default) nothing changes: the renderer asks once whether it is on and
gets `false`.

## Turning it on

In `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECORD_TRAINING_DATA` | off | `1` turns the mode on |
| `RECORD_DIR` | `D:\Downloads\fish-audio-cloning-pipe-line\raw` | where session folders go |
| `RECORD_ROOMTONE` | off | `1` records 10 s of room tone when the mic first opens (stay quiet) |
| `RECORD_SYSTEM_PROMPT_FILE` | `<RECORD_DIR>\..\recording-coach.md` | the coach prompt; used as the style while the mode is on |

Restart the app after changing `.env`. A toast confirms the mode is on.

## What gets saved

When voice mode starts, the renderer opens a second stream from the same mic with echo
cancellation, noise suppression and auto gain **off**, at the mic's native rate (48 kHz on the
Yeti), and streams it to main (`src/renderer/src/audio/training-tap.ts`). The ears keep their own
processed 16 kHz stream, untouched. Main keeps the last 3 minutes in a ring buffer
(`src/main/training/recorder.ts`) and, for every `speech_end` from the ears, cuts the span from
speech start - 300 ms to speech end + 500 ms.

```
raw/2026-10-19_s01/
  session.json     mic name, sample rate, processing flags (all false), app version, take count
  roomtone.wav     with RECORD_ROOMTONE=1
  t0001.wav        mono 24-bit PCM, your mic only
  t0001.json       take_id, session_id, started_at/ended_at, agent_prompt, category, delivery,
                   target_text, asr_text, barge_in, retake_of, continues, sample_rate, duration_s,
                   peak_dbfs
```

- The agent's audio is never recorded; its text is saved as `agent_prompt`. Wear headphones so
  it does not reach the mic either.
- `category` / `delivery` / `target_text` come from the coach's spoken labels ("Free talk.",
  "Guided line. Say this: "...".", "Emotion, surprised."); `[guided]`-style brackets also parse.
- `retake_of` links a take that followed the coach's "Go again." to the original attempt;
  `continues` links a take to the previous one when the agent did not reply in between.
- `asr_text` is Parakeet's final; `null` if it never arrived (ears restarted).
- Nothing is ever overwritten: each app run gets a new `sNN` folder and files are written with
  exclusive-create. Mute writes silence. Writes are async and queued off the turn loop.
- If a spoken take peaks below -30 dBFS you get one toast per session: turn up the mic's own gain.

## Removing it

Delete `src/main/training/`, `src/renderer/src/audio/training-tap.ts`,
`src/renderer/public/training-tap-processor.js` and this file, then remove the lines that reference
`training` / `trainingTap` in `src/main/index.ts`, `src/renderer/src/audio/voice.ts`,
`src/preload/index.ts`, `src/preload/api.d.ts`, `src/shared/ipc.ts` (four channels) and
`SettingsService.envVar`.
