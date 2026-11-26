const BY_TOOL: Record<string, string[]> = {
  web_search: ['Let me check that.', 'One sec, looking that up.', 'Let me have a look.'],
  research: ['Give me a moment, I will dig into that.', 'Let me read up on that.'],
  read_page: ['Let me read that page.', 'One moment, opening that.'],
  recall: ['Let me think back.', 'One sec.'],
  search_history: ['Let me look through our earlier chats.'],
  remember: ['Got it, noting that down.'],
  update_memory: ['Updating that.', 'Let me fix that note.'],
  diagram_create: ['Let me draw that.', 'One sec, sketching it out.'],
  diagram_edit: ['Let me change that.', 'Updating the diagram.'],
  diagram_get: ['Let me look at it.'],
  pc_find: ['Let me look for that.', 'One sec, searching your files.'],
  pc_list: ['Let me see what is in there.', 'Having a look.'],
  pc_read: ['Let me read that.', 'One sec, opening it.'],
  pc_grep: ['Let me search through those files.'],
  pc_explore: ['Let me have a look around.', 'Give me a moment, I will dig through your files.'],
  default: ['Hold on.', 'One sec.', 'Let me check.']
}

/** Spoken while a tool has been quiet for a while, so the agent never goes dead silent mid-work. */
export const CONTINUATION = ['Still looking.', 'One sec.', 'Almost there.', 'Bear with me.']

/** Spoken when the tool-round cap is hit before the model said anything, instead of ending the turn silently. */
export const STEP_LIMIT_PHRASE = "I've hit my limit for tool calls this turn. Here's what I have so far."

let counter = 0
let continuationCounter = 0

export function fillerFor(toolName: string): string {
  const key = toolName.startsWith('mcp__') ? 'default' : toolName
  const options = BY_TOOL[key] ?? BY_TOOL.default!
  return options[counter++ % options.length]!
}

export function continuationFiller(): string {
  return CONTINUATION[continuationCounter++ % CONTINUATION.length]!
}

export function toolLabel(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const [, server, ...rest] = toolName.split('__')
    return `${rest.join('_')} via ${server}`
  }
  return (
    {
      web_search: 'Searching the web',
      research: 'Researching',
      read_page: 'Reading page',
      recall: 'Checking memory',
      search_history: 'Searching history',
      remember: 'Saving to memory',
      update_memory: 'Updating memory',
      forget: 'Asking to forget',
      current_time: 'Checking the time',
      diagram_create: 'Drawing a diagram',
      diagram_edit: 'Changing the diagram',
      diagram_get: 'Reading the diagram',
      pc_find: 'Finding on your PC',
      pc_list: 'Listing a folder',
      pc_read: 'Reading a file',
      pc_grep: 'Searching in files',
      pc_explore: 'Exploring your PC',
      claude_list: 'Listing sessions',
      claude_start: 'Starting a session',
      claude_send: 'Sending to Claude',
      claude_status: 'Checking on Claude',
      claude_answer: 'Answering Claude',
      claude_interrupt: 'Stopping Claude',
      claude_stop: 'Shutting down a session',
      claude_reset: 'Starting it fresh',
      claude_compact: 'Compacting it',
      claude_remove: 'Removing sessions',
      claude_files: 'Looking at its files',
      claude_recent: 'Looking at your other sessions',
      claude_attach: 'Bringing that session in',
      claude_mode: 'Switching its mode',
      claude_details: 'Reading the details'
    }[toolName] ?? toolName
  )
}
