/**
 * The live console: every app.log line and every trace event, as one stream the UI can show while you
 * use the app. `describe` turns an entry into a readable row ("Heard: …", "Cut off: you spoke over it");
 * the raw fields stay on the entry for the expanded view.
 */

export type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error'

/** Which part of the app an entry is about; the console's filter chips. */
export type ConsoleCategory = 'you' | 'turn' | 'voice' | 'playback' | 'claude' | 'system'

export const CONSOLE_CATEGORIES: Array<{ id: ConsoleCategory; label: string; hint: string }> = [
  { id: 'you', label: 'You', hint: 'What the ears heard: speech start and end, transcripts, interruptions' },
  { id: 'turn', label: 'Brain', hint: 'Each reply: which model, first words, tools, failures, cut-offs' },
  { id: 'voice', label: 'Voice', hint: 'Sentences turned into audio: engine, timing, fallbacks, routes' },
  { id: 'playback', label: 'Playback', hint: 'Audio starting and finishing in the speaker' },
  { id: 'claude', label: 'Claude Code', hint: 'Claude Code sessions: status, questions, finished jobs' },
  { id: 'system', label: 'System', hint: 'Processes, settings changes and plain log lines' }
]

export interface ConsoleEntry {
  /** Increasing per app run; stable key for the list. */
  id: number
  /** Epoch ms. */
  t: number
  kind: 'trace' | 'log'
  level: ConsoleLevel
  /** Trace: the event name (turn.start). Log: the scope (kokoro, renderer:capture). */
  name: string
  /** Log: the line. Trace: empty (the text is built from `data`). */
  msg: string
  /** Trace: the event's fields. Log: extra data, when the line had any. */
  data?: Record<string, unknown>
  turn?: string
}

export interface ConsoleRow {
  cat: ConsoleCategory
  /** The row's headline, in plain words. */
  title: string
  /** Secondary text: numbers and names. */
  detail: string
  tone: 'plain' | 'good' | 'warn' | 'bad' | 'accent' | 'dim'
  /** Frequent, low-value entries (partial transcripts, state changes) hidden unless "Verbose" is on. */
  noisy: boolean
  /** Starts a new reply: the console draws a divider above it. */
  turnStart?: boolean
}

import { fmtTokens, fmtUsd } from './pricing'

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const ms = (v: unknown): string => {
  const n = num(v)
  if (n === undefined) return ''
  return n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}
const quote = (v: unknown, max = 160): string => {
  const s = str(v).replace(/\s+/g, ' ').trim()
  return s ? `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”` : ''
}
const join = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' · ')
const model = (v: unknown): string => str(v).replace(/^[a-z]+:/, '')

/** "10.2k in (9.6k cached) / 23 out tokens · $0.0004" from a metrics or usage record. */
function usageText(u: Record<string, unknown>): string {
  const input = num(u.inputTokens) ?? 0
  const read = num(u.cacheReadTokens) ?? 0
  const cost = num(u.costUsd)
  return join(`${fmtTokens(input)} in${read ? ` (${fmtTokens(read)} cached)` : ''} / ${fmtTokens(num(u.outputTokens) ?? 0)} out tokens`, cost !== undefined ? fmtUsd(cost) : '')
}

const END_REASON: Record<string, string> = { done: 'sounded finished', timeout: 'silence ran out', max: 'hit the length cap' }
const CANCEL_REASON: Record<string, string> = {
  'barge-in': 'you spoke over it',
  'new-input': 'a new message arrived',
  continuation: 'you carried on speaking',
  'read-aloud': 'a read-aloud started',
  stop: 'stopped'
}

const CHANGE: Record<string, string> = { save: 'saved', rename: 'renamed', delete: 'deleted (moved to .trash)', on: 'switched on', off: 'switched off' }

const RUN_END: Record<string, string> = {
  done: 'finished',
  blocked: 'stopped by an error',
  out_of_budget: 'hit its limit',
  cancelled: 'cancelled',
  expired: 'gave up waiting',
  interrupted: 'cut off'
}

const DROP_REASON: Record<string, string> = {
  disabled: 'it is switched off',
  cooldown: 'still cooling down from its last firing',
  session_cap: 'already fired as often as allowed in this conversation',
  cap: 'too many playbooks matched; higher priorities won',
  one_runbook: 'another runbook started on this message'
}

function category(name: string, kind: ConsoleEntry['kind']): ConsoleCategory {
  if (kind === 'log') {
    if (/^(claude|cc)\b/.test(name)) return 'claude'
    if (/^(tts|kokoro)\b/.test(name)) return 'voice'
    if (/^(ear|renderer:capture|renderer:voice)\b/.test(name)) return 'you'
    if (/^renderer:playback\b/.test(name)) return 'playback'
    if (/^(agent)\b/.test(name)) return 'turn'
    return 'system'
  }
  const head = name.split('.')[0]
  if (head === 'ear') return 'you'
  if (head === 'turn' || head === 'state' || head === 'announce' || head === 'tuning' || head === 'explore' || head === 'trigger' || head === 'playbook' || head === 'playbooks' || head === 'jev' || head === 'runbook') return 'turn'
  if (head === 'tts') return 'voice'
  if (head === 'playback') return 'playback'
  if (head === 'cc') return 'claude'
  return 'system'
}

/** One readable row for an entry. Unknown events fall back to their name and a compact field list. */
export function describe(e: ConsoleEntry): ConsoleRow {
  const cat = category(e.name, e.kind)
  if (e.kind === 'log') {
    const tone = e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'debug' ? 'dim' : 'plain'
    return { cat, title: e.msg, detail: e.name, tone, noisy: e.level === 'debug' || /^renderer:toast$/.test(e.name) }
  }
  const d = e.data ?? {}
  const row = (title: string, detail = '', tone: ConsoleRow['tone'] = 'plain', extra: Partial<ConsoleRow> = {}): ConsoleRow => ({ cat, title, detail, tone, noisy: false, ...extra })

  switch (e.name) {
    // ---- you ----
    case 'ear.speech_start':
      return row('You started speaking', '', 'accent')
    case 'ear.partial':
      return row(`…${quote(d.text, 120)}`, 'hearing', 'dim', { noisy: true })
    case 'ear.speech_end':
      return row(`You stopped (${END_REASON[str(d.reason)] ?? str(d.reason)})`, join(`spoke ${ms(d.speechMs)}`, `waited ${ms(d.silenceMs)}`, num(d.turnP) !== undefined && `finished-score ${num(d.turnP)!.toFixed(2)}`, d.afterCut ? 'after cutting in' : ''), 'plain')
    case 'ear.final':
      return str(d.text).trim()
        ? row(`Heard: ${quote(d.text, 400)}`, join(`transcribed in ${ms(d.asrMs)}`, num(d.queuedMs) ? `queued ${ms(d.queuedMs)}` : '', d.afterCut ? 'after cutting in' : ''), 'accent')
        : row('Heard nothing (empty transcript)', join(`transcribed in ${ms(d.asrMs)}`), 'warn')
    case 'ear.segment':
      return row(`Heard so far: ${quote(d.text, 300)}`, 'long utterance, still listening', 'dim')
    case 'ear.bargein': {
      const stage = str(d.stage)
      return stage === 'cut' ? row('You cut in: reply stopped', 'barge-in', 'warn') : stage === 'duck' ? row('You made a sound: reply turned down', 'duck', 'dim') : row('Reply volume restored', 'it was a backchannel', 'dim')
    }
    case 'ear.status':
      return row(`Ears: ${str(d.stage)}`, '', 'dim')
    case 'ear.ready':
      return row('Ears ready (speech recognition loaded)', num(d.loadS) !== undefined ? `loaded in ${num(d.loadS)!.toFixed(1)} s` : '', 'good')
    case 'ear.stats':
      return row('Ear statistics', join(`${str(d.turns)} turns`, `${str(d.cuts)} cuts`, num(d.asrFailures) ? `${str(d.asrFailures)} ASR failures` : ''), 'dim', { noisy: true })
    case 'ear.error':
      return row(`Ears error: ${str(d.message ?? d.error ?? d.text)}`, '', 'bad')

    // ---- turn ----
    case 'state':
      return row(`State: ${str(d.from)} → ${str(d.to)}`, str(d.event), 'dim', { noisy: true })
    case 'turn.start':
      return row(`${d.via === 'voice' ? 'You said' : 'You typed'}: ${quote(d.text, 400)}`, join(model(d.model), str(d.mode), d.afterCut ? 'after cutting in' : ''), 'accent', { turnStart: true })
    case 'turn.attempt':
      return row(`Trying ${model(d.model)}`, str(d.reason), 'warn')
    case 'turn.attempt_failed':
      return row(`${model(d.model)} failed: ${str(d.error)}`, d.transient ? 'temporary' : '', 'bad')
    case 'turn.model_skipped':
      return row(`Skipped ${model(d.model)}`, str(d.reason).replace(/_/g, ' '), 'warn')
    case 'turn.workspace_dropped':
      return row('Anthropic workspace not found: retrying without it', model(d.model), 'warn')
    case 'turn.first_token':
      return row('Model started answering', join(model(d.model), `${ms(d.ttftMs)} after the turn began`), 'plain')
    case 'turn.first_sentence':
      return row('First sentence ready to speak', ms(d.ttfsMs), 'dim')
    case 'turn.first_audio':
      return row('First audio playing', join(num(d.speechEndToAudioMs) !== undefined ? `${ms(d.speechEndToAudioMs)} after you stopped` : `${ms(d.ttfaMs)} after the turn began`, `voice took ${ms(d.ttsFirstMs)}`), 'good')
    case 'turn.tool_start':
      return row(`Tool: ${str(d.name)}`, str(d.summary), 'accent')
    case 'turn.tool_end':
      return row(`Tool ${str(d.name)} ${d.ok ? 'finished' : 'failed'}`, join(ms(d.ms), str(d.detail), num(d.resultChars) ? `about ${fmtTokens(Math.ceil(num(d.resultChars)! / 4))} tokens of result` : ''), d.ok ? 'plain' : 'bad')
    case 'turn.filler':
      return row(`Filler: ${quote(d.text)}`, str(d.kind), 'dim')
    case 'turn.notice':
      return row(`Notice: ${str(d.text)}`, '', 'warn')
    case 'turn.stall':
      return row(`Model stalled: ${str(d.reason)}`, model(d.model), 'bad')
    case 'turn.step_limit':
      return row('Tool round limit reached', `${str(d.steps)} of ${str(d.maxSteps)}`, 'warn')
    case 'turn.cancel': {
      const reason = str(d.reason)
      const unspoken = str(d.unspokenText).trim()
      return row(`Reply cut off: ${CANCEL_REASON[reason] ?? reason}`, join(str(d.spokenText).trim() ? `said ${quote(d.spokenText, 140)}` : 'nothing was said yet', unspoken ? `never said ${quote(unspoken, 140)}` : ''), 'warn')
    }
    case 'turn.context': {
      const k = (chars: unknown): string => fmtTokens(Math.ceil((num(chars) ?? 0) / 4))
      const tools = num(d.tools) ?? 0
      return row(
        `Sending about ${fmtTokens(num(d.estimateTokens) ?? 0)} tokens to the model`,
        join(`rules ${k(d.stableChars)}`, `this turn's details and memory ${k(d.liveChars)}`, `conversation ${k(d.historyChars)} in ${str(d.messages)} messages`, tools ? `${tools} tools about ${fmtTokens(tools * 120)}` : ''),
        'dim'
      )
    }
    case 'turn.usage':
      return row(`Model call ${str(d.step)}: ${usageText(d)}`, join(model(d.model), num(d.reasoningTokens) ? `${fmtTokens(num(d.reasoningTokens)!)} spent thinking` : '', d.finish === 'tool-calls' ? 'asked for a tool' : ''), 'dim', { noisy: true })
    case 'turn.end': {
      const m = (d.metrics ?? {}) as Record<string, unknown>
      const steps = num(m.steps) ?? 0
      return row(
        d.interrupted ? 'Reply ended (interrupted)' : 'Reply finished',
        join(ms(d.totalMs), `${str(d.chars)} characters`, `${str(d.chunks)} sentences`, model(m.model), num(m.inputTokens) !== undefined ? usageText(m) : '', steps > 1 ? `${steps} model calls` : '', m.fallbackUsed ? 'backup model' : ''),
        d.interrupted ? 'warn' : 'good'
      )
    }
    case 'turn.error':
      return row(`Reply failed: ${str(d.message)}`, '', 'bad')
    case 'turn.dropped':
      return row('Ignored what was heard', str(d.reason).replace(/-/g, ' '), 'dim')
    case 'turn.mergeable':
      return row('That sounded unfinished: waiting to see if you carry on', join(str(d.reason), ms(d.windowMs)), 'dim')
    case 'turn.continuation':
      return row('You carried on: joining it to what you said before', ms(d.gapMs), 'plain')
    case 'turn.merged':
      return row(`Joined ${str(d.parts)} parts: ${quote(d.text, 300)}`, '', 'plain')
    case 'turn.resume':
      return row('Resumed the interrupted reply', str(d.kind), 'plain')
    case 'turn.self_cut_suspect':
      return row('Possibly heard its own voice and cut itself off', '', 'warn')
    case 'turn.final_overdue':
      return row('The transcript never arrived: ears restarted', '', 'bad')
    case 'turn.drain_timeout':
      return row('Audio never reported finishing', ms(d.waitMs), 'bad')
    case 'turn.spoken_split':
      return row('Worked out where the reply was cut', `sentence ${str(d.seq)}`, 'dim', { noisy: true })
    case 'turn.announce':
      return row(`Announced: ${quote(d.text, 300)}`, '', 'accent')
    case 'announce.queued':
      return row(`Announcement waiting: ${quote(d.text, 200)}`, `${str(d.queued)} queued`, 'dim')

    // ---- voice ----
    case 'tts.sentence': {
      const outcome = str(d.outcome)
      const what = d.kind === 'filler' ? 'filler' : `sentence ${num(d.seq) !== undefined ? num(d.seq)! + 1 : ''}`
      const detail = join(str(d.engine), `${str(d.chars)} chars`, `first audio ${ms(d.firstByteMs)}`, `total ${ms(d.ms)}`, num(d.attempts) && num(d.attempts)! > 1 ? `${str(d.attempts)} tries` : '')
      if (outcome === 'ok') return row(`Voiced ${what}`, detail, 'plain')
      if (outcome === 'fallback') return row(`Voiced ${what} with the backup voice`, detail, 'warn')
      return row(`Skipped ${what}: the voice failed`, detail, 'bad')
    }
    case 'tts.warm':
      return row('Voice connection opened ahead of the reply', ms(d.ms), 'dim', { noisy: true })
    case 'tts.pace':
      return row('First chunk lengthened for a slow voice', join(str(d.engine), `${str(d.firstMinWords)} words`), 'dim', { noisy: true })
    case 'tts.engine_down':
      return row(`${str(d.engine)} voice is down: ${str(d.reason)}`, join(`using ${str(d.fallback)}`, `retry in ${ms(d.retryInMs)}`), 'bad')
    case 'tts.engine_probe':
      return row(d.ok ? `${str(d.engine)} voice works again` : `${str(d.engine)} voice still failing`, str(d.reason), d.ok ? 'good' : 'warn')
    case 'tts.kokoro_state':
      return row(`Kokoro: ${str(d.state)}`, str(d.error), d.state === 'ready' ? 'good' : d.state === 'failed' ? 'bad' : 'plain')
    case 'tts.route':
      return row(`Edge route: ${str(d.url)}${d.changed ? ' (changed)' : ''}`, join(str(d.reason), `${ms(d.firstMs)} to first audio`, `direct ${num(d.directMs) !== undefined ? ms(d.directMs) : 'failed'}`, `${str(d.tested)} tested in ${ms(d.ms)}`), d.changed ? 'accent' : 'dim')

    // ---- playback ----
    case 'playback.started':
      return row(`Playing ${d.kind === 'filler' ? 'filler' : `sentence ${num(d.seq) !== undefined ? num(d.seq)! + 1 : ''}`}`, '', 'plain')
    case 'playback.finished':
      return row(`Finished sentence ${num(d.seq) !== undefined ? num(d.seq)! + 1 : ''}`, '', 'dim', { noisy: true })
    case 'playback.drained':
      return row('All audio played', `${str(d.chunks)} sentences`, 'good')

    // ---- claude ----
    case 'cc.status':
      return row(`${str(d.session)}: ${str(d.status).replace(/_/g, ' ')}`, join(num(d.queued) ? `${str(d.queued)} queued` : '', num(d.tokensIn) ? `${fmtTokens(num(d.tokensIn)!)} in / ${fmtTokens(num(d.tokensOut) ?? 0)} out tokens so far` : '', num(d.costUsd) ? `${fmtUsd(num(d.costUsd)!)} at API prices` : ''), d.status === 'error' ? 'bad' : /needs/.test(str(d.status)) ? 'warn' : 'plain')
    case 'cc.needs_input':
      return row(`${str(d.session)} needs you: ${str(d.summary)}`, str(d.kind), 'warn')
    case 'cc.finished':
      return row(`${str(d.session)} finished`, `${str(d.chars)} characters`, 'good')
    case 'cc.denied':
      return row(`Blocked a Claude Code action: ${str(d.reason)}`, str(d.session), 'warn')

    // ---- system ----
    case 'ui.toast':
      return { cat: 'system', title: `Shown to you: ${str(d.text)}`, detail: str(d.kind), tone: d.kind === 'error' ? 'bad' : d.kind === 'warn' ? 'warn' : 'plain', noisy: false }
    case 'settings.changed': {
      const changed = (d.changed ?? {}) as Record<string, unknown>
      const keys = Object.keys(changed)
      const one = (k: string): string => `${k} = ${typeof changed[k] === 'string' && (changed[k] as string).length > 40 ? `${(changed[k] as string).slice(0, 38)}…` : JSON.stringify(changed[k])}`
      return row(`Setting changed: ${keys.slice(0, 3).map(one).join(', ')}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}`, '', 'plain')
    }
    case 'session.start':
      return row('New conversation started', '', 'dim')
    case 'session.select':
      return row('Switched conversation', '', 'dim')
    case 'sidecar.spawn':
      return row('Starting the ears process', join(str(d.model), str(d.device)), 'plain')
    case 'sidecar.connected':
      return row('Connected to the ears', '', 'good')
    case 'sidecar.idle_shutdown':
      return row('Ears unloaded after sitting idle', ms(d.idleMs), 'warn')
    case 'sidecar.buffer_flushed':
      return row('Replayed speech captured while the ears loaded', join(`${str(d.frames)} frames`, ms(d.ms)), 'plain')
    case 'sidecar.exit':
      return row('Ears process exited', `code ${str(d.code)}`, d.code === 0 ? 'dim' : 'bad')
    case 'sidecar.restart':
      return row('Restarting the ears', join(str(d.reason), ms(d.delayMs)), 'warn')
    case 'app.crash':
      return row(`Crash caught: ${str(d.message)}`, str(d.kind), 'bad')
    case 'explore.start':
      return d.goal !== undefined ? row(`Explorer goal: ${quote(d.goal, 200)}`, join(model(d.model), d.mayEdit ? 'may edit files' : 'read-only', `up to ${str(d.maxSteps)} steps, ${ms(d.budgetMs)}`), 'accent') : row('Explorer started', model(d.model), 'dim', { noisy: true })
    case 'explore.step':
      return row(`Explorer step ${str(d.step)}: ${str(d.call)}`, '', d.outcome === 'refused' ? 'warn' : d.outcome === 'error' ? 'bad' : 'dim')
    case 'explore.usage':
      return row('Explorer token use', `${fmtTokens(num(d.inputTokens) ?? 0)} in / ${fmtTokens(num(d.outputTokens) ?? 0)} out tokens`, 'dim')
    case 'explore.done': {
      const status = str(d.status).replace('_', ' ')
      return row(d.answered ? `Explorer finished: ${status}` : `Explorer stopped without an answer (${str(d.reason) || status})`, join(`${str(d.steps)} steps`, ms(d.ms), num(d.edits) ? `${str(d.edits)} edited` : '', num(d.refused) ? `${str(d.refused)} refused` : ''), d.answered && d.status === 'done' ? 'good' : 'warn')
    }
    case 'trigger.fired':
      return row(`Playbook fired: ${str(d.title) || str(d.id)}`, str(d.why), 'accent')
    case 'trigger.dropped':
      return row(`Playbook held back: ${str(d.title) || str(d.id)}`, DROP_REASON[str(d.reason)] ?? str(d.reason), 'dim')
    case 'playbook.applied':
      return row(`Added the ${str(d.id)} instruction to this reply`, `${str(d.chars)} characters`, 'dim', { noisy: true })
    case 'playbooks.loaded':
      return row(`Loaded ${str(d.count)} playbook${d.count === 1 ? '' : 's'} (${str(d.enabled)} on)`, num(d.invalid) ? `${str(d.invalid)} file${d.invalid === 1 ? '' : 's'} could not be read` : '', num(d.invalid) ? 'warn' : 'dim')
    case 'jev.request':
      return row(`Asked Jev ${Array.isArray(d.questions) ? (d.questions as unknown[]).length : ''} question${Array.isArray(d.questions) && (d.questions as unknown[]).length === 1 ? '' : 's'}`.replace('  ', ' '), join(ms(d.ms), num(d.inputTokens) !== undefined ? `${fmtTokens(num(d.inputTokens)!)} tokens` : '', num(d.costUsd) !== undefined ? fmtUsd(num(d.costUsd)!) : ''), 'dim')
    case 'jev.answer':
      return row(d.name === 'intent' ? `Jev read it as: ${str(d.answer)}` : `Jev on ${str(d.name).replace(/^pb_/, '')}: ${str(d.answer)}`, num(d.p) !== undefined ? `${Math.round(num(d.p)! * 100)}% sure` : '', 'accent')
    case 'jev.warm':
      return row('Opened the connection to Jev', ms(d.ms), 'dim', { noisy: true })
    case 'jev.timeout':
      return row('Jev did not answer in time; the reply went ahead without it', `waited ${ms(d.ms)}`, 'warn')
    case 'jev.error':
      return row(`Jev failed: ${str(d.message)}`, str(d.kind), d.kind === 'no_key' ? 'dim' : 'warn')
    case 'playbooks.changed':
      if (d.action === 'undo') return row(`Undid a playbook change: ${str(d.id)}`, d.by === 'voice' ? 'asked by voice' : 'from the Playbooks view', 'plain')
      return row(`Playbook ${CHANGE[str(d.action)] ?? str(d.action)}: ${str(d.id)}`, d.by === 'ui' ? 'from the Playbooks view' : d.by === 'voice' ? 'asked by voice' : str(d.by), 'plain')
    case 'playbook.draft':
      return d.ok
        ? row(`Drafted the playbook ${str(d.id)}`, join(ms(d.ms), d.repaired ? 'needed one fix' : ''), 'plain')
        : row('Could not draft a playbook that loads; nothing saved', join(Array.isArray(d.errors) ? (d.errors as unknown[]).map(str)[0] ?? '' : str(d.error), ms(d.ms)), 'warn')
    case 'runbook.start':
      return row(`Runbook started: ${str(d.title) || str(d.id)}`, 'runs in the background', 'accent')
    case 'runbook.step':
      return row(`${str(d.id)}: ${str(d.step)} (${str(d.kind)})${d.note ? `: ${str(d.note)}` : ''}`, ms(d.ms), d.outcome === 'ok' ? 'dim' : 'bad', { noisy: d.outcome === 'ok' && d.kind !== 'wait' })
    case 'runbook.wait':
      return row(`${str(d.id)} is waiting for your reply`, `gives up after ${str(d.expireS)} s`, 'warn')
    case 'runbook.reply':
      return row(`${str(d.id)} got your reply`, `after ${ms(d.waitedMs)}`, 'plain')
    case 'runbook.done':
      return row(`Runbook ${RUN_END[str(d.status)] ?? str(d.status)}: ${str(d.id)}`, join(`${str(d.steps)} steps`, ms(d.ms), d.status === 'done' ? '' : str(d.reason)), d.status === 'done' ? 'good' : d.status === 'blocked' ? 'bad' : 'warn')
    case 'runbook.skipped':
      return row(`Runbook not started: ${str(d.id)}`, d.reason === 'already_running' ? 'it is already running' : d.reason === 'waiting_for_reply' ? 'another one is waiting for your reply' : 'too many runbooks are running', 'dim')
    case 'playbook.review': {
      const parts = [`${str(d.checked)} messages`, `fires on ${str(d.fires)}`, num(d.misses) ? `missed ${str(d.misses)}` : '', num(d.falseFires) ? `fired wrongly on ${str(d.falseFires)}` : '', ms(d.ms)]
      return row(`Reviewed the trigger of ${str(d.id)}`, join(...parts), num(d.misses) || num(d.falseFires) ? 'warn' : 'good')
    }
    case 'playbook.label':
      return row(`Marked a message for ${str(d.id)}: ${d.label === 'should' ? 'it should fire' : d.label === 'should_not' ? 'it should not fire' : 'mark cleared'}`, '', 'plain')
    case 'playbook.suggest':
      return row(d.ok ? `Drafted a tighter trigger for ${str(d.id)}` : `Could not draft a tighter trigger for ${str(d.id)}`, join(num(d.misses) ? `${str(d.misses)} missed` : '', num(d.falseFires) ? `${str(d.falseFires)} wrong` : ''), d.ok ? 'plain' : 'warn')
    case 'runbook.withheld':
      return row('Left out of this reply, a background job does it', Array.isArray(d.tools) ? (d.tools as unknown[]).map(str).join(', ') : '', 'dim', { noisy: true })
    case 'runbook.usage':
      return row('Runbook model token use', `${fmtTokens(num(d.inputTokens) ?? 0)} in / ${fmtTokens(num(d.outputTokens) ?? 0)} out tokens`, 'dim', { noisy: true })
    case 'playbook.usage':
      return row('Playbook drafter token use', `${fmtTokens(num(d.inputTokens) ?? 0)} in / ${fmtTokens(num(d.outputTokens) ?? 0)} out tokens`, 'dim', { noisy: true })
    case 'playbooks.invalid': {
      const errs = Array.isArray(d.errors) ? (d.errors as unknown[]).map(str) : []
      return row(`Playbook file not loaded: ${str(d.id)}.md`, join(errs[0] ?? '', errs.length > 1 ? `${errs.length - 1} more problem${errs.length > 2 ? 's' : ''}` : ''), 'bad')
    }
    case 'trace.dropped':
      return row('Some events were dropped (too many at once)', str(d.note), 'warn')
    default: {
      const fields = Object.entries(d)
        .filter(([, v]) => typeof v !== 'object' || v === null)
        .slice(0, 6)
        .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 60 ? `${v.slice(0, 58)}…` : String(v)}`)
        .join('  ')
      return row(e.name, fields, /error|fail|crash/.test(e.name) ? 'bad' : 'plain')
    }
  }
}

/** Plain text of a row, for search and copy. */
export function rowText(e: ConsoleEntry, r: ConsoleRow = describe(e)): string {
  return `${new Date(e.t).toISOString().slice(11, 23)} ${e.kind === 'trace' ? e.name : `[${e.name}]`} ${r.title}${r.detail ? ` (${r.detail})` : ''}`
}
