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
    text: "From that last message I picked out {{tasks_count}} tasks: {{tasks}}. Want me to add them to your to-do list?"
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
- clock.tick: every minute. Fields: time ("14:30"), hour, minute, weekday, sessionsWaiting, waitingNames,
  oldestWaitMinutes, sessionsWorking. "minute % 10 == 0" is every ten minutes; use a cooldown to space it out.
The event's fields are in the steps too ({{session}}), and a claude step can message that session with
session: "{{sessionId}}" instead of starting a new one with name:.

Runs, their steps and anything they are waiting on show on the Playbooks page and in the Console.
`
