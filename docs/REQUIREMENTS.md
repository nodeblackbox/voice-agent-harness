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
- **The 2026-11-20 numbers here were wrong** (direct ~150 ms, "throttled" 1-4 s). The test spoke the same
  phrase every time, and Microsoft answers a sentence it has already made from a cache in ~150 ms, so it
  timed the network. Every speed test now speaks new text.
- Measured 2026-11-24 from London on new text: **the voice decides the speed, not the route.** Edge sends
  no audio until the whole sentence is synthesized. `en-US-AvaMultilingualNeural` took 3-5 s for a short
  sentence (up to 10 s for a long one) direct and through proxies in France, Germany, Italy, the US and
  Japan alike; `en-US-AvaNeural`, the same speaker, took about 1 s direct; Jenny and Aria 0.3-0.8 s.
  Proxies are for an address Microsoft refuses (429/403), not for speed.

## Voice speed

- The owner must be able to see which voice is slow and fix it in one click. Settings > Voice output
  times any Edge voice on new text ("speed"), and marks the Multilingual ones as slower to start.
- When the chosen voice has taken over 2 s a sentence for four sentences, the app times the plain voice
  of the same name once the agent is quiet and, if it is clearly quicker, shows a banner above the chat
  with "Switch to Ava". It never switches voice by itself: the voice is the owner's choice.
- A reply's first sentence is sent to Edge three times at once and the first answer is spoken
  (`speech.ttsRaceFirst`): Edge's time for identical requests swings between 0.5 and 2.2 s, and three
  copies brought the average from 1.37 s to 0.93 s and the worst case from 2.2 s to 1.45 s.
- The header names the voice in full ("Ava Multilingual", not "Ava"), since the two differ this much.

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

## Looking at the PC

- The agent can understand what is on the owner's PC: list a folder, find files and folders by name, read a
  text file, search inside files (`pc_list`, `pc_find`, `pc_read`, `pc_grep`). Asked for "my lemon AI
  project", it looks for it instead of asking for the path.
- The four tools the agent calls itself only read. Everything else on the PC goes through the explorer
  (below).
- **Absolutely no deleting.** Nothing is ever deleted, moved, renamed, created, installed, downloaded or
  run, by any path through the app's PC tools. There is no tool for it, and no command for it exists in the
  restricted terminal.
- **Only inside approved folders** (Settings > PC access; a whole drive or single folders). Every path is
  resolved first (`..`, symlinks and junctions included) and refused when it ends up outside the list.
  Network and device paths are refused. Nothing is approved by the code: a fresh install starts with the
  app's own folder, the session workspace and the folders of the owner's projects, and the owner adds the
  rest.
- **Secrets stay out of the conversation.** Files that usually hold passwords or keys (`.env`, private
  keys, credential stores, proxy lists, `.ssh` and the like) are never opened, even inside an approved
  folder, and key-shaped text in any other file is masked. What is read goes to a hosted model and may be
  spoken aloud.
- **Short enough to say.** Results are capped (entries, matches, characters, folders walked, seconds). A
  name search of a whole drive returns the nearest matches and says it stopped there.
- **The explorer is its own module** (`src/core/explore`). The agent hands it a goal ("find the lemon AI
  project on the D drive") with `pc_explore`, and it works until the goal is done: when a search finds
  nothing or a path is wrong it tries other names, folders and searches inside files. "Not found" is not
  accepted before three different searches. Hard caps: 12 steps and 45 seconds, then it returns what it
  has. The answer is short enough to speak. Off, the agent chains the read tools itself.
- **Edits, narrowly.** The explorer can replace a piece of text inside an existing text file in an
  approved folder, and only for a goal the agent marked as a change the owner asked for. It cannot create,
  delete, rename or empty a file. The text to replace must occur exactly once (or every occurrence is asked
  for). A copy of the file as it was goes to `<userData>/pc-edit-backups` first. Secrets files, git's own
  files, binaries, hard-linked files and files over 1 MB are never edited.
- **A restricted terminal, by allowlist.** `ls`, `dir`, `cat`, `type`, `head`, `tail`, `grep`, `findstr`,
  `find`, `wc`, `pwd` and `git status|log|diff|branch`. It is not a shell: the line is parsed in the app, the
  file commands are answered by the app's own fenced code, and git is the only program started (by its full
  path, with an argument list, a timeout and a minimal environment). Anything not on the list is refused,
  as are `;`, `&&`, `||`, `>`, `<`, `$`, backticks, `%VAR%`, and a pipe into anything but a text filter.
- **When in doubt, refuse and say so.** An unclear goal, an ambiguous edit or an unknown command option is
  refused with the reason; the explorer returns what was refused and the agent tells the owner.
- **Everything is logged.** Every action taken or refused is one line in
  `<userData>/logs/pc-actions.jsonl` (who, goal, tool, target, outcome, time), and the explorer's steps show
  in the Console.
- Each permission has a switch in Settings > PC access (the explorer, edits, the terminal).
- The agent knows its own source folder as the active project when no other is picked (running from
  source), so "change yourself" starts a Claude Code session there, after a clear yes.

## Tokens and cost

- The owner wants to see what a conversation uses and whether it is efficient: tokens in and out and the
  list-price cost of every reply (next to the reply, and in the console), how much of the prompt came from
  the cache, what each tool's result added to the prompt, and what each Claude Code session has used.
- The console adds these up for the run and splits them by model, tool and session.
- A model with no known price shows "no price", never a made-up number. Prices are in
  `src/shared/pricing.ts`; update them there when a provider changes them.
- The agent knows what it runs on (chat model, voice, speech recognition) and answers from that when asked.

## Playbooks and triggers

- The owner wants to shape how the assistant responds in particular situations without editing prompts:
  a **trigger** recognises the situation, a **playbook** says what to do about it. The plan and its phases
  are in [TRIGGERS.md](TRIGGERS.md); ideas come from the owner's earlier co-host project (one Markdown file
  per playbook, gates, authoring by voice) and Jev playground, with nothing game-specific and **no random
  chance**: a playbook fires or it doesn't, and the Console says why, including when one matched but was held
  back.
- Playbooks are plain files in `<userData>/playbooks`, so they can be read, edited, diffed and (later) put in
  git and written by voice. A broken file is skipped and its errors shown, never half-loaded.
- The **Playbooks** view on the left rail lists them with what each reacts to and how often it fired, switches
  them on and off, and edits the file itself with live checks (a file that would not load is not saved). It
  can replay recent messages to show which would have set a draft off. A message that fired playbooks shows a
  chip for each under it; clicking one opens that playbook.
- Playbooks must never slow a reply down or cost one: phase 1 is code-only checks that take microseconds, and a
  failure inside them is logged and the reply goes ahead.

## Claude Code sessions

- More than a handful at once: the limit is on sessions that are open (idle, working, waiting), not on
  the length of the list, and it is a setting (Claude Code view, 1-24, default 8).

## Working style

- Plans are executed without check-ins once agreed; commit and push at each phase boundary.
- UI changes are checked visually before they are called done; tests cover the logic.
- No personal defaults baked into code (names, voices, keys): those come from Settings or `.env`.
