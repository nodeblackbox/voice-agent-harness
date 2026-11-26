# Triggers, playbooks and runbooks: plan

Status: all seven phases are built. Playbooks (1-2): files with code triggers, gates, priority, injection into the
reply, the Playbooks view and chat chips. Jev (3): `intent`, `intentP`, `triggers.ask`. Authoring by voice (4):
the playbook_* tools, the drafter, confirmed deletes, git history and undo. Runbooks (5): `kind: runbook` with
`steps`, run in the background, saved after every step. Events (6): `cc.finished`, `cc.needs_input`, `clock.tick`.
More events (2026-11-26): `cc.started`, `cc.error`, `cc.idle`, `cc.context`, `cc.compacted`, `app.start`, and
`schedule` with a `triggers.schedule` block (see Trigger types). The Playbooks page has a Triggers overview: every
event, what listens to it, what each did this run, and a log of fired and held-back decisions.
Evaluation (7): `src/core/playbooks/evaluate.ts` replays the user's recent messages through a trigger and has a
judge (Jev, one yes/no per message, or the model in one call) say where it should have fired; disagreements are
misses and false fires, the user's own marks (`<userData>/playbook-labels.json`, set in the Review panel, by the
small control on a chat chip, or by voice with playbook_mark) count over the judge, and `suggestTrigger` drafts a
tighter trigger from them (the Review panel puts it in the editor; playbook_fix saves it, undoable). Still open:
`mode: canned|hybrid`, splitting long messages into pieces (`fromSplit` is always false), and the root types
learned from logged messages.
The design discussion lives in the owner's doc "Voice Agent Harness: Trigger
and Playbook Layer". This page is the build plan. It draws on three places: what this repo already has, the
Lemon co-host project (one-file-per-playbook, gates, voice authoring), and the Jev logic playground (the Jev
client and the "Jev picks, code decides" turn model). Nothing game-specific is carried over, and there is
**no random chance**: a playbook either fires or it doesn't, and the log says why.

## The model in one paragraph

Everything is an **event** with a dotted type (`turn.user`, `cc.finished`, `clock.tick`). A **trigger** is a
condition over events: code first, then a phrase match, then a Jev question. A **playbook** is a one-shot
reaction: it shapes the next reply (inject an instruction, add tools, speak a fixed line). A **runbook** is a
multi-step procedure with a shared scratchpad that runs in the background and can branch on Jev answers. Every
decision is traced, so the Console shows it, the chat shows a chip, and the agent can be asked by voice why it
did something. The voice lane never waits: only a step that changes the reply may hold it, under a hard cap.

## What each source contributes

| Idea | From | Notes |
|---|---|---|
| One Markdown file per playbook: YAML header (triggers, gates, priority) + a plain-language body that is the instruction | Lemon | Easy to diff, hot-reloads, the AI writes the same format the UI edits. One shared set, not one copy per persona (Lemon's three copies drifted). |
| Strict schema, one `parse()` used by the UI, voice and tests, line-numbered errors | Lemon | Zod here, since the repo already uses it. |
| Safe `when:` expressions where missing data is simply false | Lemon | Reimplemented in TS as a tiny whitelisted expression parser. No `eval`. |
| Gates: cooldown, max per session, min gap, "user just spoke", priority with pre-emption, drop reasons logged | Lemon | Round-based budgets become per-session and per-minute. `chance` is not ported. |
| Coalescing and a short priority queue that yields to the user and drops stale requests | Lemon | Only for unprompted output (announcements). Pre-reply playbooks don't queue. |
| Hybrid output: a canned line if the model is late; canned lines pre-synthesised so they play instantly | Lemon | This is the "templated acknowledgement" from the design. |
| Voice authoring: cheap gate → one planner call picking one action → drafter writes the file → validate → one self-repair round | Lemon | Here the planner is a normal tool call (no JSON regex), and the drafter gets a design guide plus two example files. |
| Jev client: one `POST /v1/systemone` with many named questions sharing one read of the state | Jev playground | About 150 lines to port (`types.ts`, `client.ts`). Add an abort timeout, which the playground lacks. |
| One batched Jev request per user turn, then a pure function applies ordered cutoffs to pick a move | Jev playground (`assistant.ts`) | The root-intent node. |
| `noul` with both ends described in `criteria`; a separate noul instead of a "none" option; unsure bands; refer to state fields by name | Jev playground (`docs/03-question-design.md`) | Becomes the drafter's design guide for Jev questions. |
| Mermaid for flows | This repo | `src/core/diagrams` already stores and checks Mermaid. Runbooks render through it (Lemon has no Mermaid). |
| Unprompted speech queue that waits for a pause | This repo | `Agent.announce()`. Runbook results go through it. |
| Session finished, needs input | This repo | `cc.finished`, `cc.needs_input`, `cc.status` are already traced. |

Lemon never built runbooks (only planned them), so the runbook runner is new. Its caps and status set come
from this repo's explorer goal loop (`src/core/explore/agent.ts`).

## File format

One file per playbook or runbook under `<userData>/playbooks/<id>.md`. Files starting with `_` are not loaded
(`_guide.md` is the authoring guide). Built-in templates ship in the app and are copied in on first run, like
built-in skills.

```markdown
---
kind: playbook            # playbook | runbook
title: Break down long messages
goal: Answer the main point briefly and list what else was said, so nothing gets lost.
enabled: true
priority: normal          # low | normal | high | critical
triggers:
  events: [turn.user]
  said: []                # phrases; all words present, stopwords removed, at least 2 content words
  when: "len(text) > tuning.longMessageChars and not fromSplit"
  ask: null               # optional Jev question id (see "Jev questions")
gates:
  cooldownS: 0
  maxPerSession: null
  afterUserS: null
mode: inject              # inject | canned | hybrid
ack: null                 # canned line spoken at once (hybrid, canned)
tags: [speech]
---
The user just said a lot in one go. Answer the main point in two or three sentences, then say
"you also mentioned" and list the other topics in a few words each.
```

The header field is `triggers`, not `on`, to avoid YAML reading `on` as true (a problem Lemon had to work
around). A runbook adds `steps:` (below). Parsing uses the `yaml` package (YAML 1.2) plus a zod schema.

## Trigger types

Evaluated cheapest first; a playbook fires only if every part it uses matches.

1. **Event** (`events`): an exact type, or a prefix ending in a dot (`cc.`).
2. **Condition** (`when`): an expression over a context snapshot: `text`, `chars`, `words`, `via` (voice or
   typed), `projectId`, `fromSplit`, session token totals, the event's own fields, and `tuning.*` values.
   Allowed functions: `len min max abs lower has any_of`.
3. **Phrase** (`said`): Lemon's word-set match, but with a minimum of two content words so a short phrase
   can't fire by accident.
4. **Jev** (`ask`): the name of a Jev question in the turn's shared request (below). The playbook states the
   answer it needs (`kind == idea`, `risky >= 0.6`).
5. **Schedule** (`events: [schedule]` with `triggers.schedule`): `at: ["09:00", "17:30"]` (times of day),
   `every: 30` (minutes, counted from `from`, inside `from`/`until`), `days: [mon, …]` (none = every day). The
   agent's minute clock sends a `schedule` event and each runbook takes the minutes its own schedule names
   (`src/shared/schedule.ts`, shared with the form so both say the same thing). `clock.tick` stays for a
   condition on the time.

The events, all from `src/shared/playbookFile.ts` (`KNOWN_EVENTS`, `EVENT_FIELDS` list each one's fields):

| Event | When | Fields |
| --- | --- | --- |
| `turn.user` | you finish saying or typing something | text, chars, words, via, intent… |
| `cc.started` | a Claude Code session is created | session, sessionId, task |
| `cc.finished` | a session ends a job | session, sessionId, summary, folder, mode, changedFiles, changes |
| `cc.needs_input` | a session asks a question, a permission or a plan | session, sessionId, kind, summary |
| `cc.error` | a run errors or loses its connection | session, sessionId, error |
| `cc.idle` | a session has sat finished at 5, 10, 15, 20, 30, 45, 60 minutes, then every 30 | session, sessionId, idleMinutes, summary |
| `cc.context` | its context passes another tenth of the window on the way up | session, sessionId, percent, previous, tokens, maxTokens |
| `cc.compacted` | its conversation was compacted (auto near the limit, or manual) | session, sessionId, how, before, after |
| `schedule` | a minute its schedule names | time, hour, minute, weekday, sessionsWaiting, waitingNames, sessionsWorking |
| `app.start` | once, 4 s after the app opens | time, hour, weekday, sessions, sessionsWaiting |
| `clock.tick` | every minute | time, hour, minute, weekday, sessionsWaiting, waitingNames, oldestWaitMinutes, sessionsWorking |

Context: after each turn the session manager asks the CLI for its context count (`getContextUsage`, summary),
falling back to the last main-loop reply's usage against the model's `contextWindow`. Compacting sends
`/compact <focus>` into the session (claude_compact by voice, the Context button on the Claude Code page, or a
runbook `claude` step); its result is not reported as a finished job, and the CLI's `compact_boundary` message
logs "Compacted 182k → 31k tokens" and lowers the meter.

## Jev in the turn

- **One request per user turn**, built after the transcript arrives and sent in parallel with the reply's
  context assembly. It always holds the root question; playbook `ask` questions are added only when their
  event and `when` parts already matched, so an unused question is never paid for.
- **Root question** (`choice`): `task`, `question`, `chat`, `idea` (thinking out loud), `feedback` (about how
  the assistant behaved). Below the confidence cutoff the answer is `unsure`, which acts like `idea`: noting
  something by mistake is cheap, building it by mistake is not. Refine these types later from logged messages.
- **Thresholds** live in `tuning.ts`: yes ≥ 0.7, no ≤ 0.3, the middle is unsure. Ordered cutoffs as in the
  playground's `decideMove` (`risky` 0.6, `needsInfo` 0.75).
- **Time cap**: a hard abort (start at 400 ms, in `tuning.ts`). On timeout or error the turn goes ahead with
  no Jev answer and the trace records `jev.timeout`. The playground measured 155 ms median, 262 ms max.
- **Cost and tokens**: Jev usage goes into `turn.usage` with its own price in `src/shared/pricing.ts`, so the
  Console totals include it.
- **The key**: a new `typesafe` entry in the encrypted key store, entered in Settings. Nothing is read from
  another project's `.env`.
- **Local later**: the client takes a base URL, so jevos (same wire format) is a settings change.
- Don't put shell-like text (`curl -X POST`) in the state verbatim: the hosted firewall returns an HTML 403.
  Handle that as an error, not a crash.

## Runbooks

A runbook is an ordered list of steps that share a scratchpad. It always runs in the background.

```yaml
steps:
  - id: split
    do: model            # code | ask | model | tool | claude | say | wait
    prompt: "Split {{text}} into self-contained topics. Fill in 'that thing' from {{recent}}."
    save: topics
  - id: tasks
    do: model
    prompt: "List concrete tasks in {{topics}}. Ideas are not tasks."
    save: tasks
  - id: offer
    do: say              # goes through the announcement queue, waits for a pause
    text: "I picked out {{tasks.length}} tasks from that. Want me to add them to the list?"
  - id: confirm
    do: wait             # pause until an event, with an expiry
    for: turn.user
    expireS: 120
    ask: agrees          # Jev noul on the reply
    next: { yes: add, no: end, unsure: end }
  - id: add
    do: tool
    tool: remember
    args: { kind: task, text: "{{tasks}}" }
```

- **Step kinds**: `code` (a named built-in function, not arbitrary code), `ask` (Jev, branches with `next`),
  `model` (cheap model), `tool` (any agent tool), `claude` (queue a prompt to a Claude Code session, through
  the fence), `say` (announcement queue), `wait` (until an event or expiry).
- **Caps** in `tuning.ts`: max steps, max wall time, max tokens, max nesting depth 1 (a runbook may start one
  other runbook, which may not start another). Hitting a cap ends the run with status `out_of_budget`.
- **Statuses**: `done`, `need_user`, `blocked`, `out_of_budget`, `cancelled`, `expired`.
- **State** is saved after every step (`<userData>/runbooks/runs/<runId>.json`), so a `wait` survives a
  restart. Runs that have expired are cleaned up on start.
- **Ask before** only for steps that can't be undone: a `claude` step that pushes, a tool that deletes. The
  fence already decides this for sessions.
- **Diagram**: the runbook's steps render as Mermaid through `src/core/diagrams`, read-only, so the owner can
  see the flow and ask for changes.

## Authoring by voice

1. **Gate**: an `authoring` playbook triggered by the root answer `feedback`, or by a phrase list ("every
   time", "whenever", "stop doing", "playbook", "runbook"). Ordinary turns don't pay for it.
2. **Tools** (normal tool calling, no JSON regex): `playbook_find`, `playbook_create`, `playbook_edit`,
   `playbook_toggle`, `playbook_delete`, `playbook_test`, `runbook_create`, `runbook_run`.
3. **Drafting**: `playbook_create` calls a model with the schema, `_guide.md`, the list of event types and
   context fields, the Jev question guide, and two existing files as examples. It returns the whole file.
4. **Validate**: the same `parse()`. One automatic "fix these errors" round; if still invalid, nothing is saved
   and the agent says what was wrong.
5. **Confirm**: create, edit and toggle save straight away and are spoken back in a sentence. Delete asks
   first and moves the file to `.trash/`.
6. **History**: the playbooks folder is a git repo; every save by voice or UI is a commit with a one-line
   message, so "undo that" is a revert.
7. **Test**: `playbook_test` replays the last N user turns from the trace against the new file and says which
   would have fired. This is the start of evaluation.

## UI

- **Playbooks** on the left rail (one view, Playbooks and Runbooks as two tabs). List with trigger chips,
  on/off, priority, fired count and last fired. Selecting one shows a logic panel (enabled, priority, gates,
  condition rows) and a CodeMirror editor (the repo already has the YAML language). Every control rewrites
  the header text, so the file stays the single source. Buttons: test, duplicate, delete, draft with AI.
  Runbooks also show the Mermaid diagram and recent runs with their step log.
- **Triggers overview** (the Triggers button at the top of the sidebar): stat cards (on, fired, held back, next
  scheduled), every event grouped as You / Claude Code sessions / Time with the files that listen to it, what
  each did this run (`fired 2×`, `held back 1×: still cooling down…`), a New button that starts a runbook
  already set to that event, and the last 40 decisions (`TriggerActivity`, kept in main from `trigger.fired` and
  `trigger.dropped`; switched-off ones are not logged).
- **Chat chips**: under the message that set something off, one chip per firing (title and outcome). Click
  opens the Console filtered to that turn.
- **Console rows**: a readable row in `src/shared/console.ts` for every new event, coloured as its own part
  of the app.
- Colours through `T` only, both themes, checked by screenshot before reporting.

## Trace events

Add to `DEBUGGING.md`:

- `jev.request{questions, ms, inputTokens}`, `jev.answer{name, answer, p}`, `jev.timeout{ms}`, `jev.error{status}`
- `trigger.fired{id, by: event|when|said|ask, why}`, `trigger.dropped{id, reason: cooldown|gate|disabled|cap|user_speaking}`
- `playbook.applied{id, mode, chars}`
- `runbook.start{id, runId, trigger}`, `runbook.step{runId, step, kind, outcome, ms}`, `runbook.done{runId, status, steps, ms}`
- `playbooks.changed{id, action, by: voice|ui}`

## Where it hooks in

| Piece | Where |
|---|---|
| Schema, parser, expression engine, matcher, gates, runbook runner, Jev client | new `src/core/playbooks/` and `src/core/jev/` (no Electron, unit-tested) |
| Pre-reply evaluation and injection | `agent.ts`, after `memoryBlock(...)`, before `composeSystemParts(...)`; a new `playbookBlock` slot |
| Event feed for triggers | the agent's `tr(...)` and the Claude service's `cc.*` events, fed to the engine |
| Unprompted speech | `Agent.announce()` |
| Files, hot reload, git | new `src/main/services/playbooks.ts` |
| IPC and bridge | `ipc/register.ts`, `preload` |
| View | `views/PlaybooksView.tsx`, a rail entry in `App.tsx`, `View` in `store.ts` |
| Thresholds and caps | `src/shared/tuning.ts` |
| Jev price | `src/shared/pricing.ts` |

## Build phases

Each phase ends with `pnpm check` passing, a screenshot check of any UI, and a commit.

1. **Engine, code triggers only.** Schema, parser, expression engine, event and `when` matching, gates,
   injection, trace events, Console rows. Ships with template 1. Done when a long typed message is reshaped
   and the Console shows why.
2. **Playbooks view and chips.** List, toggle, editor with live validation, test against recent turns.
3. **Jev client and the root question.** Key in Settings, timeout, usage and price, `ask` triggers. Measure
   real latency from here and record it in `TUNING.md`. Templates 2 and 3.
4. **Authoring by voice.** Tools, drafter, guide, self-repair, git history, spoken confirmation.
5. **Runbooks.** Runner, step kinds, saved state, `wait`, caps, Mermaid view. Templates 4 and 5.
6. **Clock events and Claude session triggers.** Templates 6 and 7.
7. **Evaluation.** Replay logged turns, mark misses and false fires, suggest tighter code triggers.

## Templates to ship

1. **Long message breakdown** (playbook, phase 1): length condition, inject instruction.
2. **Idea, not instruction** (playbook, phase 3): root `idea` or `unsure` → note it in memory, say "noted",
   don't start work.
3. **Didn't like that** (playbook, phase 3): root `feedback` → ask which playbook, offer to turn it off.
4. **Brain dump to tasks** (runbook, phase 5): split, extract tasks, de-duplicate against memory, offer, add.
5. **Harness change request** (runbook, phase 5): pull the relevant docs, write a prompt, ask "run now or
   add to the list", then queue it to a Claude Code session.
6. **Push after a session finishes** (runbook, phase 6): `cc.finished` → ask "push it?" → `claude` step.
7. **Session check-up** (runbook, phase 6): `clock.every` → find stalled sessions → nudge or announce.

Added after the phases:

8. **How-to as steps** (playbook): "how do I…" questions → a short numbered list of steps.
9. **Plan bigger work first** (playbook, Jev): a long `task` → the plan as a short list and a yes before starting.
10. **Evening to-do roundup** (runbook, clock, off by default): at 18:00 on weekdays, read out saved to-dos.
11. **Afternoon push reminder** (runbook, clock, off by default): at 17:30 on weekdays, a nudge to commit and push.

Templates are generic on purpose (they ship to everyone): personal ones, such as context for a named project,
belong in the user's own playbooks folder, made by voice or in the Playbooks view.

## Not carried over

Counter-Strike game events and everything built on them: rounds, loadouts, maps, strategies and roulette.
Random chance. Multiple per-persona copies of the playbook set. Regex parsing of planner JSON. The
playground's replay, critic and stepwise-versus-fanout machinery (only the batched request is kept).
