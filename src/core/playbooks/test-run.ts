// "Would this have fired?": replay recent user messages against a playbook draft. Gates and on/off are not
// applied, so the answer is about the trigger itself.

import type { ChatMessage, PlaybookTestRow } from '@shared/types'
import { matchPlaybook, type EngineLimits } from './engine'
import { parsePlaybook, type ParseIssue } from './schema'

export function testPlaybook(id: string, text: string, messages: ChatMessage[], tuning: EngineLimits['tuning']): { errors: ParseIssue[]; rows: PlaybookTestRow[] } {
  const r = parsePlaybook(id, text)
  if (!r.ok) return { errors: r.errors, rows: [] }
  const rows = messages
    .filter((m) => m.role === 'user' && m.text.trim())
    .map((m) => ({
      text: m.text,
      createdAt: m.createdAt,
      via: m.via,
      why: matchPlaybook(r.playbook, { text: m.text, via: m.via === 'voice' ? 'voice' : 'typed', project: '', projectId: '', turnIndex: 0, fromSplit: false }, tuning)
    }))
  return { errors: [], rows }
}
