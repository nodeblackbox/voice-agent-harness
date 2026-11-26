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
  }
]

/** The guide at the top of the folder: what a playbook file is. Not loaded as a playbook (it starts with _). */
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
gates:
  cooldownS: 0               # seconds before it can fire again
  maxPerSession: null        # most times per conversation, null for no limit
tags: []
---
The instruction for the assistant.

The when: condition can read text, chars, words, via ("voice" or "typed"), project, projectId, turnIndex,
fromSplit and tuning.<name> (the Playbooks values in Settings > Tuning). It supports and, or, not, the
comparisons == != < <= > >=, in, + - * /, lists like ["a", "b"], and the functions len, min, max, abs,
lower, has(text, "word") and any_of(text, ["a", "b"]). A name that does not exist is empty, so a condition
on a missing field is simply false.

Every firing, and every playbook that matched but was held back, shows in the Console.
`
