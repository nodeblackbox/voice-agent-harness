/** How AskUserQuestion reaches the host and how to answer it (option pick and free text). */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { MODEL, describe, finding, freshWorkspace, log } from './_common'

const cwd = freshWorkspace('02-ask-user')
const seen: string[] = []

const q = query({
  prompt: 'Use the AskUserQuestion tool to ask me which language to write a hello-world in (options: Python, TypeScript, Go). Then create hello.<ext> in the current folder using my answer.',
  options: {
    cwd, model: MODEL, settingSources: [], permissionMode: 'default', maxTurns: 6,
    canUseTool: async (toolName, input, opts) => {
      seen.push(toolName)
      log('canUseTool', toolName, JSON.stringify(input).slice(0, 300), 'title=', opts.title)
      if (toolName === 'AskUserQuestion') {
        const qs = (input as any).questions
        const answers: Record<string, string> = {}
        for (const item of qs) answers[item.question] = item.options[1].label // "voice says option 2"
        log('answering with', JSON.stringify(answers))
        return { behavior: 'allow', updatedInput: { ...input, answers } }
      }
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

for await (const m of q as AsyncIterable<any>) {
  log(describe(m))
  if (m.type === 'result') finding('ask-user', `canUseTool saw [${seen.join(', ')}]; result: ${String(m.result).slice(0, 160)}`)
}
