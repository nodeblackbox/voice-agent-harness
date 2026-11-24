import type { ToolActivity, ToolSource } from '@shared/types'

export function toolKind(name: string): ToolActivity['kind'] {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('claude_')) return 'claude'
  if (name === 'web_search' || name === 'research') return 'search'
  if (name === 'read_page') return 'read'
  if (name === 'remember' || name === 'recall' || name === 'forget' || name === 'search_history' || name === 'update_memory') return 'memory'
  if (name === 'current_time') return 'time'
  if (name.startsWith('diagram_')) return 'diagram'
  if (name.startsWith('pc_')) return 'files'
  return 'other'
}

export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  return name.split('__')[1]
}

const str = (v: unknown, max = 120): string => {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function describeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'web_search':
    case 'research':
      return typeof i.query === 'string' ? `“${i.query}”` : ''
    case 'read_page':
      return typeof i.url === 'string' ? i.url : ''
    case 'remember':
      return typeof i.key === 'string' ? `${i.key}: ${str(i.value, 60)}` : ''
    case 'update_memory': {
      const what = i.append !== undefined ? `append ${str(i.append, 50)}` : i.replace ? `replace ${str((i.replace as { find?: unknown }).find, 30)}` : i.value !== undefined ? `rewrite` : 'edit'
      return `${typeof i.key === 'string' ? i.key : i.id !== undefined ? `#${String(i.id)}` : ''} · ${what}`
    }
    case 'recall':
    case 'search_history':
      return typeof i.query === 'string' ? `“${i.query}”` : ''
    case 'forget':
      return i.id !== undefined ? `#${String(i.id)}` : ''
    case 'current_time':
      return ''
    case 'diagram_create':
      return typeof i.title === 'string' ? i.title : ''
    case 'diagram_edit':
      return str(i.note ?? i.title ?? i.diagram ?? '', 80)
    case 'diagram_get':
      return typeof i.diagram === 'string' ? i.diagram : ''
    case 'pc_find':
      return `${str(i.query, 60)}${typeof i.path === 'string' && i.path ? ` in ${str(i.path, 50)}` : ''}`
    case 'pc_grep':
      return `“${str(i.text, 50)}”${typeof i.path === 'string' && i.path ? ` in ${str(i.path, 50)}` : ''}`
    case 'pc_list':
      return typeof i.path === 'string' && i.path ? str(i.path, 90) : 'approved folders'
    case 'pc_read':
      return str(i.path, 90)
    case 'pc_explore':
      return str(i.request, 100)
    case 'claude_start':
      return typeof i.name === 'string' ? `${i.name}${typeof i.task === 'string' && i.task ? ` · ${str(i.task, 70)}` : ''}` : ''
    case 'claude_send':
      return `${typeof i.session === 'string' && i.session ? `${i.session} · ` : ''}${str(i.prompt, 80)}${i.mode === 'now' ? ' (now)' : ''}`
    case 'claude_answer':
      return `${typeof i.session === 'string' && i.session ? `${i.session} · ` : ''}${Array.isArray(i.choice) ? `option ${i.choice.join(', ')}` : typeof i.text === 'string' ? `“${str(i.text, 60)}”` : i.approve === true ? `approve${typeof i.mode === 'string' ? ` · ${i.mode}` : ''}` : i.approve === false ? 'deny' : ''}`
    case 'claude_list':
      return ''
    case 'claude_mode':
      return `${typeof i.session === 'string' && i.session ? `${i.session} · ` : ''}${typeof i.mode === 'string' ? `${i.mode} mode` : ''}`
    case 'claude_details':
      return `${typeof i.session === 'string' && i.session ? `${i.session} · ` : ''}${typeof i.what === 'string' ? i.what : ''}`
    case 'claude_remove':
      return Array.isArray(i.sessions) ? `${i.sessions.join(', ')}${i.delete_folder ? ' + folders' : ''}` : ''
    case 'claude_status':
    case 'claude_interrupt':
    case 'claude_stop':
    case 'claude_reset':
    case 'claude_files':
    case 'claude_attach':
      return typeof i.session === 'string' ? i.session : ''
    default: {
      const entries = Object.entries(i)
      return entries.length ? entries.map(([k, v]) => `${k}=${str(v, 40)}`).join(' ') : ''
    }
  }
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function describeOutput(name: string, output: unknown): { detail?: string; sources?: ToolSource[] } {
  const o = output as Record<string, unknown> | string | null | undefined
  if (o && typeof o === 'object' && 'error' in o) return { detail: str((o as { error: unknown }).error, 90) }
  switch (name) {
    case 'web_search': {
      const results = ((o as { results?: Array<{ title?: string; url?: string; snippet?: string }> })?.results ?? []).filter((r) => r.url)
      const answers = (o as { answers?: string[] })?.answers ?? []
      return {
        detail: `${results.length} result${results.length === 1 ? '' : 's'}${answers.length ? `, ${answers.length} direct answer${answers.length === 1 ? '' : 's'}` : ''}`,
        sources: results.map((r) => ({ title: r.title || host(r.url!), url: r.url!, snippet: r.snippet }))
      }
    }
    case 'research': {
      const sources = ((o as { sources?: Array<{ title?: string; url?: string; text?: string; error?: string }> })?.sources ?? []).filter((s) => s.url)
      return {
        detail: `read ${sources.length} page${sources.length === 1 ? '' : 's'}`,
        sources: sources.map((s) => ({ title: s.title || host(s.url!), url: s.url!, snippet: s.text?.slice(0, 160) }))
      }
    }
    case 'read_page': {
      const r = o as { title?: string; url?: string; text?: string } | undefined
      return r?.url ? { detail: `${(r.text?.length ?? 0).toLocaleString()} chars`, sources: [{ title: r.title || host(r.url), url: r.url }] } : {}
    }
    case 'remember':
    case 'update_memory': {
      const s = (o as { status?: string })?.status
      return { detail: s === 'saved' ? 'saved' : s === 'updated' ? 'updated' : s === 'pending' ? 'waiting for your OK' : s === 'not_found' ? 'no such memory' : s === 'no_change' ? 'nothing to change' : s }
    }
    case 'recall':
    case 'search_history': {
      const n = Array.isArray(o) ? o.length : 0
      return { detail: n ? `${n} match${n === 1 ? '' : 'es'}` : 'nothing found' }
    }
    case 'forget': {
      const s = (o as { status?: string })?.status
      return { detail: s === 'pending' ? 'waiting for your OK' : s }
    }
    case 'current_time':
      return { detail: (o as { now?: string })?.now }
    case 'diagram_create':
      return { detail: (o as { kind?: string })?.kind ? `${(o as { kind: string }).kind.toLowerCase()} drawn` : 'drawn' }
    case 'diagram_edit': {
      const r = o as { status?: string; version?: number; changed?: string } | undefined
      return { detail: r?.status === 'no_change' ? 'nothing to change' : `version ${r?.version ?? '?'}${r?.changed ? ` · ${r.changed}` : ''}` }
    }
    case 'diagram_get': {
      const r = o as { title?: string; version?: number } | undefined
      return { detail: r?.title ? `${r.title} · version ${r.version ?? 1}` : '' }
    }
    case 'pc_find':
    case 'pc_grep': {
      const r = o as { matches?: unknown[]; more_matches?: number; incomplete?: string } | undefined
      const n = r?.matches?.length ?? 0
      return { detail: `${n ? `${n}${r?.more_matches ? '+' : ''} match${n === 1 ? '' : 'es'}` : 'nothing found'}${r?.incomplete ? ' (stopped early)' : ''}` }
    }
    case 'pc_list': {
      const r = o as { total_folders?: number; total_files?: number; approved_folders?: unknown[] } | undefined
      return { detail: r?.approved_folders ? `${r.approved_folders.length} approved folders` : `${r?.total_folders ?? 0} folders, ${r?.total_files ?? 0} files` }
    }
    case 'pc_read': {
      const r = o as { lines?: string; kb?: number } | undefined
      return { detail: r?.lines ? `lines ${r.lines}` : '' }
    }
    case 'pc_explore': {
      const r = o as { answer?: string; steps_taken?: unknown[]; unfinished?: string } | undefined
      const n = r?.steps_taken?.length ?? 0
      return { detail: `${n} step${n === 1 ? '' : 's'}${r?.unfinished ? ', unfinished' : ''}` }
    }
    case 'claude_list':
      return { detail: `${((o as { sessions?: unknown[] })?.sessions ?? []).length} sessions` }
    case 'claude_start':
    case 'claude_send':
    case 'claude_answer':
    case 'claude_interrupt':
    case 'claude_reset':
    case 'claude_stop': {
      const r = o as { status?: string; error?: string; session?: unknown } | undefined
      return { detail: r?.error ?? r?.status }
    }
    case 'claude_status': {
      const r = o as { status?: string; error?: string } | undefined
      return { detail: r?.error ?? r?.status }
    }
    case 'claude_files': {
      const r = o as { count?: number; error?: string } | undefined
      return { detail: r?.error ?? `${r?.count ?? 0} files` }
    }
    case 'claude_remove': {
      const r = o as { removed?: string[]; failed?: unknown[] } | undefined
      return { detail: `${r?.removed?.length ?? 0} removed${r?.failed?.length ? `, ${r.failed.length} failed` : ''}` }
    }
    case 'claude_recent': {
      const r = o as { count?: number } | undefined
      return { detail: `${r?.count ?? 0} saved sessions` }
    }
    case 'claude_attach': {
      const r = o as { status?: string; error?: string } | undefined
      return { detail: r?.error ?? r?.status }
    }
    default:
      return { detail: str(o, 90) }
  }
}
