# What the owner wants

The standing requirements for this app, in the owner's terms, so changes keep to them. When a request
adds or changes one, update this file in the same commit. Implementation details live in the other docs;
this is the "why" and the bar each part has to meet.

## Voice conversation

- **It must answer, every time.** A reply that comes back empty, or a model that fails, is never silent:
  the next model in the chain is tried, and if all fail the user is told in words. A reasoning model that
  spends its budget thinking and writes nothing counts as a failure.
- **Fast first words.** Latency is the main complaint about any voice; first audio should come within
  about a second of the end of speech. Slow paths (cold model loads, throttled Edge, slow hosted voices)
  are measured in the trace and fixed, not tolerated.
- **Nothing the user says is lost.** No dropped words while a model reloads, no cut-off replies without
  a reason in the log.

## Switching voices (TTS engines)

- Picking an engine in Settings takes effect, visibly. The status shows what is actually speaking now,
  and when a fallback covers ("Edge speaks until Kokoro is ready").
- **Kokoro (local) is loaded on demand**: picking it starts loading straight away (30-60 s), with a
  loading indicator and a Load/Retry button; replies keep using Edge until it is ready and then switch by
  themselves, with a toast. It must never look selected while something else silently speaks.
- A failed engine says why (no key, deleted voice, rate limit) instead of degrading without a word. A
  saved hosted voice that isn't on the key's account (cloned voices belong to one account) is flagged in
  Settings before it is used.
- **Every sentence plays once.** A doubled player (heard as an echo) must not happen, hot reload included.
- Changing the Kokoro voice is audible from the next sentence, and every voice can be previewed.
- **Expressive sounds** (laughs, sighs, breaths, whispers) are wanted. Only the hosted voices that take
  cues can make them (Inworld, Fish Audio, ElevenLabs v3/v4, with Expressive cues on); on Edge and Kokoro
  the agent says it can't rather than writing "*sigh*" for the voice to read out.

## Speech recognition (Parakeet)

- Can stay loaded the whole time ("Keep speech recognition loaded" in Settings > Behaviour): loaded at
  launch, never unloaded for being idle. The cold load is ~20 s and used to drop the start of speech.

## Edge TTS routing and proxies

- Edge is free but Microsoft throttles it per IP address, on and off. The app picks the route itself:
  **direct while Edge is quick, the fastest of the owner's proxies when it is throttled**, switching back
  when direct recovers.
- The owner should never have to paste a proxy in by hand. The list comes from `PROXY_LIST_URL` in
  `.env` (a Webshare download link), plus anything in Settings > Proxy list.
- **Don't test all the proxies every time.** The full list is tested once a day or when it changes
  (one short phrase each, a few at once); otherwise only direct and the best few are re-checked, at
  launch and when Edge gets slow or fails.
- Proxies are for Edge. The hosted voices are fast direct; they only use a proxy when the owner turns
  that on.
- Measured 2026-11-20 from London (warm socket, time to first audio): direct ~150 ms when not throttled;
  through Paris and Frankfurt proxies about the same; Milan and US East a little slower; US West
  (Palo Alto) ~1.2 s; Tokyo ~1.7 s. Throttled direct was 1-4 s. `pnpm lab:proxies` re-measures by country.

## Secrets

- Proxy lists, the Webshare link, API keys and `extra_keys.env` never get committed. They live in
  `.env`, `proxies.txt` or the app's user-data folder, all ignored by git. Code never prints a key or
  proxy password in full; logs show `host:port` only.
- The Groq key pool's proxies (`GROQ_KEYS` in `.env`) must point at proxies on the current list.

## Seeing what happens

- The owner wants to watch live what the app is doing (what was heard, which model and voice answered,
  what was cut off and why). The **Console** does this: its own button on the left rail for the full
  window, and a Console tab in the chat's right-hand panel so it can be watched while talking. Rows are in
  plain words, coloured by part of the app (you, brain, voice, playback, Claude Code, system), with
  filters, search, pause, a problems-only switch, and the raw event on click.
- Every new traced event gets a readable row in `src/shared/console.ts` (`describe`).
- Each run's trace (`%APPDATA%/Voice Agent/logs/sessions/<id>.jsonl`) is the record; `docs/DEBUGGING.md`
  lists the events.

## Editing files in the app

- Files in a session's workspace can be edited where they are viewed: a real code editor (monospace,
  syntax colours by file type: TypeScript/TSX, JavaScript, Python, JSON, Markdown, HTML, CSS, YAML, TOML,
  shell and more), with a Save button and Ctrl+S.
- Unsaved edits are marked (in the header and in the file tree) and survive switching to another file.
- A save never silently overwrites a change made on disk meanwhile (Claude may be editing the same
  file): the owner is shown the choice between the new version and their own.
- Saving stays inside the workspace fence, like reading does, and only changes files that already exist.

## Diagrams

- The agent can draw: asked for a diagram (a flow, a sequence, a mind map, a timeline...), it shows a
  rendered Mermaid diagram in the chat straight away. It never answers with a block of code to paste
  somewhere else, and the code is never read aloud.
- Every diagram has three views: the picture, its code, and what changed since the version before, as a
  red and green diff. The picture opens full-window with zoom and pan.
- The agent changes a diagram with small find-and-replace edits, so the diff shows exactly what moved.
  A drawing that does not compile is never shown: the parser's error goes back to the agent, which fixes it.
- The owner can edit the code in place (Save or Ctrl+S). An edit is a new version, never a replacement;
  every version can be stepped through and brought back. The agent sees the owner's edits.
- Mermaid written straight into a reply or a Markdown file is drawn too.

## Tokens and cost

- The owner wants to see what a conversation uses and whether it is efficient: tokens in and out and the
  list-price cost of every reply (next to the reply, and in the console), how much of the prompt came from
  the cache, what each tool's result added to the prompt, and what each Claude Code session has used.
- The console adds these up for the run and splits them by model, tool and session.
- A model with no known price shows "no price", never a made-up number. Prices are in
  `src/shared/pricing.ts`; update them there when a provider changes them.
- The agent knows what it runs on (chat model, voice, speech recognition) and answers from that when asked.

## Claude Code sessions

- More than a handful at once: the limit is on sessions that are open (idle, working, waiting), not on
  the length of the list, and it is a setting (Claude Code view, 1-24, default 8).

## Working style

- Plans are executed without check-ins once agreed; commit and push at each phase boundary.
- UI changes are checked visually before they are called done; tests cover the logic.
- No personal defaults baked into code (names, voices, keys): those come from Settings or `.env`.
