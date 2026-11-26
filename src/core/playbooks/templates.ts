// Playbooks that ship with the app. They are copied into the playbooks folder the first time it is created
// (and any new one the first time a build that has it runs), and from then on they are ordinary files the
// user can edit, switch off or delete. A deleted template does not come back.

export interface Template {
  id: string
  text: string
}

export const TEMPLATES: Template[] = [
  {
    id: 'long-message-breakdown',
    text: `---
kind: playbook
title: Break down long messages
goal: Answer the main point briefly and name everything else that was said, so nothing gets lost.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  when: "chars > tuning.longMessageChars and not fromSplit"
gates:
  cooldownS: 0
tags: [speech]
---
The user just said a lot in one go, probably several ideas at once. Do not try to answer all of it in full.
First answer the one thing they most seem to want, in two or three sentences.
Then say "you also mentioned" and name the other topics in a few words each, in the order they came up.
End by asking which one they want to go into next.
`
  },
  {
    id: 'idea-not-instruction',
    text: `---
kind: playbook
title: Idea, not instruction
goal: Treat thinking out loud as an idea to shape, not as work to start.
enabled: true
priority: high
triggers:
  events: [turn.user]
  when: 'intent == "idea"'
gates:
  cooldownS: 0
tags: [jev]
---
The user is thinking out loud, not asking for anything to be done yet.
Do not start, queue or plan any work: no Claude Code sessions, no file changes, no tool that changes anything.
Say back the idea in one sentence so they know you got it, add the one thought or question that would help
them shape it, and offer to note it down. Only act on it if they then ask you to.
`
  },
  {
    id: 'feedback-on-replies',
    text: `---
kind: playbook
title: Feedback on how I answer
goal: Take a comment about the assistant's own behaviour seriously, and offer to make it stick.
enabled: true
priority: high
triggers:
  events: [turn.user]
  when: 'intent == "feedback"'
gates:
  cooldownS: 0
tags: [jev]
---
The user is commenting on how you behaved or answered.
If it is a complaint, acknowledge it in one short sentence without apologising at length, say plainly what
you will do differently, and do it from this reply on. If it sounds like something they will want every time,
offer to remember it as a preference. If it is praise, take it in a few words and carry on.
`
  },
  {
    id: 'brain-dump-to-tasks',
    text: `---
kind: runbook
title: Brain dump to tasks
goal: Pull the concrete tasks out of a long message and offer to save them, so nothing said gets lost.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  when: "chars > tuning.longMessageChars and not fromSplit"
gates:
  cooldownS: 300
ack: "I'll pull the tasks out of that in the background."
budget:
  maxSteps: 10
  maxSeconds: 90
steps:
  - id: tasks
    do: model
    prompt: |
      Below is something the user said out loud, transcribed. List every concrete task in it: a thing they
      want done, as a short instruction of under twelve words ("Add a spend tab to the left bar"). Leave out
      ideas they were only musing about, opinions and questions. One task per line, no numbering. If there
      are none, answer NONE.

      What came just before, for context:
      {{recent}}

      What they said:
      {{text}}
    save: tasks
    list: true
  - id: any
    do: check
    if: "tasks_count > 0"
    next: { yes: offer, no: end }
  - id: offer
    do: say
    text: "From that last message I picked out {{tasks_count}} tasks:\\n{{tasks|lines}}\\n\\nWant me to add them to your to-do list?"
  - id: reply
    do: wait
    expireS: 300
  - id: agree
    do: ask
    question: "Is \`latest\` agreeing to add the tasks (yes, sure, go ahead, add them)?"
    next: { no: end }
  - id: add
    do: tool
    tool: remember
    each: tasks
    args: { key: "To do: {{item}}", value: "{{item}}", kind: todo }
---
Runs after a long message: the reply answers it as usual (the "Break down long messages" playbook shapes
that), and this pulls the tasks out in the background, says them at the next pause, and adds them to memory
as to-dos if the answer is yes. Asking again within five minutes is skipped (cooldownS).
`
  },
  {
    id: 'app-change-request',
    text: `---
kind: runbook
title: Change request for this app
goal: Turn a request to change this voice app into a brief for Claude Code, then start it or save it for later.
enabled: true
priority: high
triggers:
  events: [turn.user]
  when: 'intent == "task"'
  ask:
    question: "Is \`latest\` asking to change this voice assistant app itself: its features, screens, settings or how it behaves?"
    yes: "Asks for a change to the assistant app itself"
    no: "Asks about something else: another project, a fact, or a task that is not changing the app"
    min: 0.8
gates:
  cooldownS: 60
ack: "I'll write that up as a job for Claude Code."
budget:
  maxSteps: 10
  maxSeconds: 120
steps:
  - id: brief
    do: model
    prompt: |
      Write a brief for a Claude Code session that will change a voice assistant app (Electron and
      TypeScript; it should read AGENTS.md in its folder first). Say what to change and why, in the user's
      terms, with every detail they gave, and ask it to plan first. Under 150 words, no preamble.

      What came just before:
      {{recent}}

      The request:
      {{text}}
    save: brief
  - id: title
    do: model
    prompt: "A title of at most six words for this change, nothing else: {{brief}}"
    save: title
  - id: offer
    do: say
    text: "I've written that up as a job for Claude Code: {{title}}. Should I start a session on it now, or add it to your list for later?"
  - id: reply
    do: wait
    expireS: 600
  - id: when
    do: ask
    question: "What does \`latest\` want done with the job?"
    options:
      now: "Start it now"
      later: "Add it to the list for later"
      drop: "Neither: drop it"
    min: 0.6
    next: { now: start, later: note, drop: dropped, unsure: note }
  - id: start
    do: claude
    name: "{{title}}"
    prompt: "{{brief}}"
    folder: app
  - id: started
    do: say
    text: "Started a Claude Code session on it. It will show you a plan before it changes anything."
    next: end
  - id: note
    do: tool
    tool: remember
    args: { key: "App change: {{title}}", value: "{{brief}}", kind: todo }
  - id: noted
    do: say
    text: "Added it to your to-do list as {{title}}. Say start it whenever you want a session on it."
    next: end
  - id: dropped
    do: say
    text: "Okay, dropped it."
---
Needs Jev (a TypeSafe key). The session starts in plan mode in this app's own folder, so it changes nothing
until you approve its plan. An answer that is neither clearly now nor clearly drop keeps the job on the
to-do list, the safe choice, and says so.
`
  },
  {
    id: 'push-after-session',
    text: `---
kind: runbook
title: Push after a session finishes
goal: When a Claude Code session finishes with uncommitted changes in a git project, offer to have it commit and push them.
enabled: true
priority: normal
triggers:
  events: [cc.finished]
  when: "changedFiles > 0"
gates:
  cooldownS: 120
budget:
  maxSteps: 8
  maxSeconds: 60
steps:
  - id: offer
    do: say
    text: "{{session}} left {{changes}} that are not committed. Want it to commit and push them?"
  - id: reply
    do: wait
    expireS: 600
  - id: agree
    do: ask
    question: "Is \`latest\` agreeing to commit and push (yes, go ahead, push it)?"
    next: { no: end }
  - id: push
    do: claude
    session: "{{sessionId}}"
    prompt: "Commit your uncommitted changes with a short message that says what changed for the user, then push the current branch. If there is no remote, or the push fails, say why and stop."
  - id: sent
    do: say
    text: "Asked {{session}} to commit and push."
---
Only sessions working in a git project count (a fresh sandbox folder has no git, so it never asks). It asks
every time, and only your yes sends the instruction; the session then works in its own mode, behind the
workspace fence, so a push may still ask for approval there.
`
  },
  {
    id: 'waiting-session-reminder',
    text: `---
kind: runbook
title: Remind me about waiting sessions
goal: Remind the user once in a while when a Claude Code session has been waiting on them for a long time.
enabled: true
priority: low
triggers:
  events: [clock.tick]
  when: "minute % 10 == 0 and sessionsWaiting > 0 and oldestWaitMinutes >= 10"
gates:
  cooldownS: 1500
budget:
  maxSteps: 3
  maxSeconds: 10
steps:
  - id: remind
    do: say
    text: "Just a reminder, Claude Code is still waiting on you in {{waitingNames}}, the longest for about {{oldestWaitMinutes}} minutes."
---
Checks every ten minutes and speaks at most every 25 minutes (cooldownS). A session counts as waiting while
it has a question, a permission or a plan for you.
`
  },
  {
    id: 'how-to-steps',
    text: `---
kind: playbook
title: How-to as steps
goal: Answer "how do I" questions as a short list of steps that is easy to follow by ear and by eye.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  when: 'any_of(lower(text), ["how do i", "how do you", "how can i", "how to ", "what are the steps", "walk me through"])'
gates:
  cooldownS: 0
tags: [format]
---
They want to know how to do something. Give one short sentence that says what the steps get them to,
then the steps, each on its own line starting with "1.", "2." and so on: at most six, a few words each,
in the order they do them. If a step needs a command or code, describe it in words. End with one short
sentence on what to check when it is done, or offer to go through it with them.
`
  },
  {
    id: 'plan-bigger-work',
    text: `---
kind: playbook
title: Plan bigger work first
goal: When asked for a sizeable piece of work, lay out the plan and get a yes before starting it.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  when: 'intent == "task" and words >= 40'
gates:
  cooldownS: 0
tags: [jev, format]
---
This is a bigger request with several parts. Before doing anything, say in one sentence what you understood
the goal to be, then the plan as a short list, each step on its own line starting with "- ", at most six.
Say which step you would start with and ask whether that plan is right. Do not start the work, call tools
that change things, or start a Claude Code session until they say yes.
`
  },
  {
    id: 'evening-todo-roundup',
    text: `---
kind: runbook
title: Evening to-do roundup
goal: At six on weekdays, read out the to-dos still saved, so nothing carries over by accident.
enabled: false
priority: low
triggers:
  events: [schedule]
  schedule: { at: ["18:00"], days: [mon, tue, wed, thu, fri] }
gates:
  cooldownS: 3600
budget:
  maxSteps: 5
  maxSeconds: 60
steps:
  - id: saved
    do: tool
    tool: recall
    args: { query: "To do" }
    save: saved
  - id: open
    do: model
    prompt: |
      These are entries from the user's memory. List the ones that are to-dos (kind todo), one per line, as a
      short instruction of a few words, at most eight, most urgent first. If there are none, answer NONE.

      {{saved}}
    save: open
    list: true
  - id: any
    do: check
    if: "open_count > 0"
    next: { yes: say, no: end }
  - id: say
    do: say
    text: "It's six o'clock. Still on your list:\\n{{open|lines}}\\n\\nWant to go through any of them before you stop?"
---
Off by default: switch it on if you want a nudge at the end of the day. It only reads; it changes nothing.
`
  },
  {
    id: 'push-reminder',
    text: `---
kind: runbook
title: Afternoon push reminder
goal: Late on weekday afternoons, remind the user to commit and push their work before they stop.
enabled: false
priority: low
triggers:
  events: [schedule]
  schedule: { at: ["17:30"], days: [mon, tue, wed, thu, fri] }
gates:
  cooldownS: 3600
budget:
  maxSteps: 3
  maxSeconds: 10
steps:
  - id: remind
    do: say
    text: "It's half past five. Anything to commit and push before you finish for the day?"
---
Off by default: switch it on for a daily nudge to push. "Push after a session finishes" covers work that a
Claude Code session did; this one is for everything else.
`
  },
  {
    id: 'compact-when-full',
    text: `---
kind: runbook
title: Offer to compact a full session
goal: When a Claude Code session's context passes 80%, offer to compact it before Claude Code has to do it by itself.
enabled: true
priority: normal
triggers:
  events: [cc.context]
  when: "percent >= 80"
gates:
  cooldownS: 600
budget:
  maxSteps: 6
  maxSeconds: 30
steps:
  - id: offer
    do: say
    text: "{{session}} has used {{percent}}% of its context. Want me to compact it now? You can tell me what it should keep."
  - id: reply
    do: wait
    expireS: 300
  - id: agree
    do: ask
    question: "Is \`latest\` agreeing to compact the session (yes, go ahead, do it, compact it)?"
    next: { no: end }
  - id: keep
    do: model
    prompt: |
      The user agreed to compact a Claude Code session and said: "{{reply}}".
      If they said what the summary should keep (a feature, a file, a bug), write that in a few words.
      Otherwise answer with nothing at all.
    save: focus
  - id: compact
    do: claude
    session: "{{sessionId}}"
    prompt: "/compact {{focus}}"
  - id: done
    do: say
    text: "Compacting {{session}}."
---
Fires as the context passes 80% and again at 90% (it reports each tenth on the way up), at most every ten
minutes. Claude Code compacts by itself when the window is nearly full; doing it a little earlier, with a
word on what to keep, keeps the parts you care about. Compact by voice any time: "compact the API session".
`
  },
  {
    id: 'session-error-readout',
    text: `---
kind: runbook
title: Tell me when a session fails
goal: When a Claude Code session fails, say which one and what went wrong, in a sentence.
enabled: true
priority: normal
triggers:
  events: [cc.error]
gates:
  cooldownS: 60
budget:
  maxSteps: 3
  maxSeconds: 30
steps:
  - id: short
    do: model
    prompt: |
      A Claude Code session called "{{session}}" failed with this error:
      {{error}}
      Say what went wrong in one short plain sentence a person can act on. No preamble.
    save: what
  - id: tell
    do: say
    text: "{{session}} stopped with a problem: {{what}}"
---
A run that errors or loses its connection. Sending the session a new instruction resumes it.
`
  },
  {
    id: 'auto-compacted-notice',
    text: `---
kind: runbook
title: Note when a session compacts itself
goal: When Claude Code compacts a session by itself because it was full, say so, since it may have lost some detail.
enabled: true
priority: low
triggers:
  events: [cc.compacted]
  when: 'how == "auto"'
gates:
  cooldownS: 300
budget:
  maxSteps: 2
  maxSeconds: 10
steps:
  - id: tell
    do: say
    text: "Heads up: {{session}} filled its context and compacted itself, so it may have lost some detail. Remind it of anything important."
---
Compacting you asked for is not mentioned; only the automatic kind, near the end of the window.
`
  },
  {
    id: 'idle-session-nudge',
    text: `---
kind: runbook
title: Nudge me about an idle session
goal: When a Claude Code session has sat finished for half an hour, ask whether it has more to do or can be stopped.
enabled: false
priority: low
triggers:
  events: [cc.idle]
  when: "idleMinutes == 30"
gates:
  cooldownS: 900
budget:
  maxSteps: 2
  maxSeconds: 10
steps:
  - id: nudge
    do: say
    text: "{{session}} finished half an hour ago and has been idle since. Anything else for it, or shall I stop it?"
---
Off by default. idleMinutes counts at 5, 10, 15, 20, 30, 45 and 60 minutes, then every half hour; change 30
to suit.
`
  },
  {
    id: 'start-of-day',
    text: `---
kind: runbook
title: Start-of-day to-dos
goal: When the app opens in the morning, read out the to-dos still saved.
enabled: false
priority: low
triggers:
  events: [app.start]
  when: "hour >= 6 and hour < 12"
gates:
  cooldownS: 14400
budget:
  maxSteps: 5
  maxSeconds: 60
steps:
  - id: saved
    do: tool
    tool: recall
    args: { query: "To do" }
    save: saved
  - id: open
    do: model
    prompt: |
      These are entries from the user's memory. List the ones that are to-dos (kind todo), one per line, as a
      short instruction of a few words, at most six, most urgent first. If there are none, answer NONE.

      {{saved}}
    save: open
    list: true
  - id: any
    do: check
    if: "open_count > 0"
    next: { yes: say, no: end }
  - id: say
    do: say
    text: "Morning. On your list:\\n{{open|lines}}"
---
Off by default. It only reads; it changes nothing.
`
  }
]

/** The guide at the top of the folder: what a playbook file is. Not loaded as a playbook (it starts with _). */
/** The runbook part of the guide, also given to the drafter. */
export const GUIDE = `# Playbooks

Each .md file in this folder is a playbook: when its trigger matches what you say, its instruction is added
to the assistant's next reply. Files whose name starts with _ are ignored.

A file is a header between two --- lines, then the instruction in plain words:

---
kind: playbook
title: Short name
goal: One sentence on what it is for.
enabled: true                # false switches it off
priority: normal             # low, normal, high or critical; the highest win when too many match
triggers:
  events: [turn.user]        # turn.user = you finished saying or typing something
  when: "chars > 1200"       # optional condition (see below)
  said: ["push the changes"] # optional phrases; every meaningful word must be in what you said
  ask:                       # optional: a yes/no question Jev answers about the message
    question: "Is \`latest\` asking to publish or push changes?"
    yes: "Asks to push, publish or ship something now"
    no: "Anything else"
    min: 0.7                 # how sure Jev must be that the answer is yes
gates:
  cooldownS: 0               # seconds before it can fire again
  maxPerSession: null        # most times per conversation, null for no limit
tags: []
---
The instruction for the assistant.

The when: condition can read text, chars, words, via ("voice" or "typed"), project, projectId, turnIndex,
fromSplit and tuning.<name> (the Playbooks values in Settings > Tuning). With a TypeSafe key (Settings >
Providers) it can also read intent, what kind of message Jev read it as (task, question, chat, idea,
feedback, or unsure), and intentP, how sure it was: when: 'intent == "idea"'. Jev is only asked when a
playbook needs it, and a playbook that needs it never fires without it. It supports and, or, not, the
comparisons == != < <= > >=, in, + - * /, lists like ["a", "b"], and the functions len, min, max, abs,
lower, has(text, "word") and any_of(text, ["a", "b"]). A name that does not exist is empty, so a condition
on a missing field is simply false.

You can also ask the assistant to make or change one by voice ("from now on, whenever I..."), switch one off,
delete one, or undo the last change: the folder keeps its own git history.

Every firing, and every playbook that matched but was held back, shows in the Console. Review (on the Playbooks
page, or "review the push playbook" by voice) shows where a trigger fired wrongly or missed, and can draft a tighter
one; the small mark next to a chip in the chat records "this should not have fired here".

## Runbooks

A runbook is a playbook with kind: runbook and a list of steps. When it fires it runs those steps in the
background, one after another, while the conversation carries on. The text under the header is only notes.

---
kind: runbook
title: Short name
goal: One sentence on what it is for.
triggers: { events: [turn.user], when: "chars > 1200" }   # the same triggers as a playbook
ack: "On it, in the background."   # optional: the reply mentions the job in a few words like this
budget: { maxSteps: 15, maxSeconds: 120 }   # the run stops at whichever comes first (waiting not counted)
steps:
  - id: tasks                 # every step has an id; by default the next step in the list follows
    do: model                 # ask the background model; {{text}} is the message, {{recent}} what came before
    prompt: "List the tasks in {{text}}. One per line, or NONE."
    save: tasks               # later steps read it as {{tasks}}
    list: true                # one item per line; also saves {{tasks_count}}
  - id: any
    do: check                 # a condition over what was saved (same language as when:)
    if: "tasks_count > 0"
    next: { yes: offer, no: end }   # "end" stops
  - id: offer
    do: say                   # spoken at the next pause in the conversation
    text: "I found {{tasks_count}} tasks: {{tasks}}. Add them?"
  - id: reply
    do: wait                  # wait for the user's next message (saved as {{reply}}); gives up after expireS
    expireS: 300
  - id: agree
    do: ask                   # a question about \`latest\` (the reply, or about: <a saved value>); Jev answers
    question: "Is \`latest\` agreeing to go ahead?"   # it when it can, the model otherwise
    next: { no: end }         # yes/no, or options: { key: meaning } for a choice; unsure stops
  - id: add
    do: tool                  # remember, update_memory, recall, web_search, read_page, current_time, diagram_create
    tool: remember
    each: tasks               # once per item, with {{item}}
    args: { key: "To do: {{item}}", value: "{{item}}", kind: todo }
  - id: start
    do: claude                # start a Claude Code session in plan mode (only after a wait step: the user says yes first)
    name: "fix it"
    prompt: "{{brief}}"
    folder: app               # app = this app's own folder, sandbox = a new folder of its own
---
Notes on what it is for.

A runbook can also react to things other than a message, with events: [...]:
- cc.finished: a Claude Code session finished. Fields: session, sessionId, summary, folder, mode, changedFiles
  (files changed and not committed, by git status; empty outside a git project).
- cc.needs_input: a session needs you. Fields: session, sessionId, kind (question, permission, plan), summary.
- cc.started: a session was created. Fields: session, sessionId, task.
- cc.error: a session's run failed. Fields: session, sessionId, error.
- cc.idle: a session has sat finished. Fields: session, sessionId, idleMinutes (5, 10, 15, 20, 30, 45, 60, then
  every 30), summary.
- cc.context: a session's context passed another tenth of its window on the way up. Fields: session, sessionId,
  percent, previous, tokens, maxTokens. when: "percent >= 80" fires at 80% and again at 90%.
- cc.compacted: a session's conversation was compacted. Fields: session, sessionId, how ("auto" or "manual"),
  before, after. A claude step with prompt: "/compact <what to keep>" compacts one.
- schedule: by the clock, with triggers.schedule saying when:
    schedule: { at: ["09:00", "17:30"], days: [mon, tue, wed, thu, fri] }   # set times; no days = every day
    schedule: { every: 30, from: "09:00", until: "18:00" }                  # every 30 minutes in a window
  Fields: time, hour, minute, weekday, sessionsWaiting, waitingNames, sessionsWorking.
- app.start: once, a few seconds after the app opens. Fields: time, hour, weekday, sessions, sessionsWaiting.
- clock.tick: every minute. Fields: time ("14:30"), hour, minute, weekday, sessionsWaiting, waitingNames,
  oldestWaitMinutes, sessionsWorking. "minute % 10 == 0" is every ten minutes; use a cooldown to space it out.
  For set times, a schedule is simpler.
The event's fields are in the steps too ({{session}}), and a claude step can message that session with
session: "{{sessionId}}" instead of starting a new one with name:.

Runs, their steps and anything they are waiting on show on the Playbooks page and in the Console.
`
