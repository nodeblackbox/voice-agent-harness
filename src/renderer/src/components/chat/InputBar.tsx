import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlignLeft, Bot, ChevronDown, Folder, Headphones, HeadphoneOff, Lock, MessageSquare, Mic, MicOff, Send, Sparkles, Wand2, type LucideIcon } from 'lucide-react'
import type { Mode } from '@shared/types'
import { T, alpha } from '../../theme'
import { keyedProviders, selectActiveModel, selectActiveProject, selectActiveStyle, useStore } from '../../state/store'
import { toggleListening, toggleMicMuted } from '../../audio/voice'
import { Dropdown, MenuItem } from '../primitives'
import { VoiceBars } from '../VoiceBars'
import { ClaudeStrip } from './ClaudeStrip'

const MODES: Array<{ id: Mode; label: string; desc: string }> = [
  { id: 'ask', label: 'Ask', desc: 'Single reply, tools only if needed' },
  { id: 'agent', label: 'Agent', desc: 'Multi-step: plans, calls tools, reports back' }
]

type Menu = 'mode' | 'model' | 'style' | null

/**
 * Discord-style voice controls: small round pills above the input, on the right, only while voice
 * mode is on. Mute (red when active) stops her hearing you; Deafen (blue when active) stops you
 * hearing her. Kept out of the input field so the Voice button stays the one obvious voice switch.
 */
function VoicePill({ icon: Icon, activeIcon: ActiveIcon, label, activeLabel, active, color, tint, title, onClick }: { icon: LucideIcon; activeIcon: LucideIcon; label: string; activeLabel: string; active: boolean; color: string; tint: string; title: string; onClick: () => void }) {
  const I = active ? ActiveIcon : Icon
  return (
    <button
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full text-xs"
      style={{
        height: 24,
        padding: '0 10px 0 8px',
        color: active ? color : T.text2,
        background: active ? tint : 'transparent',
        border: `1px solid ${active ? color : T.border}`,
        boxShadow: active ? `0 0 0 3px ${tint}` : 'none',
        cursor: 'pointer',
        transition: 'all .15s ease'
      }}
    >
      <I size={12} />
      <span style={{ fontWeight: active ? 600 : 400 }}>{active ? activeLabel : label}</span>
    </button>
  )
}

export function InputBar() {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const styles = useStore((s) => s.styles)
  const model = useStore(selectActiveModel)
  const keyStatus = useStore((s) => s.keys)
  const keyed = useMemo(() => keyedProviders(keyStatus), [keyStatus])
  const style = useStore(selectActiveStyle)
  const project = useStore(selectActiveProject)
  const listening = useStore((s) => s.listening)
  const micMuted = useStore((s) => s.micMuted)
  const deafened = useStore((s) => s.muted)
  const setDeafened = useStore((s) => s.setMuted)
  const agentState = useStore((s) => s.agentState)
  const updateSettings = useStore((s) => s.updateSettings)
  const setView = useStore((s) => s.setView)
  const [open, setOpen] = useState<Menu>(null)
  const [draft, setDraft] = useState('')
  const barRef = useRef<HTMLDivElement>(null)
  // The bar floats over the transcript and grows (Claude strip, chips, multi-line drafts): publish its
  // height so the transcript can keep its last message clear of it.
  useEffect(() => {
    const el = barRef.current
    const host = el?.parentElement
    if (!el || !host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      host.style.setProperty('--va-input-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
      window.dispatchEvent(new Event('va-input-resize'))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const claudeAvailable = !!settings?.claude && !!window.api.claude
  const claudeOn = claudeAvailable && !!settings?.claude?.enabled
  const toggleClaude = () => {
    if (!settings) return
    void updateSettings({ claude: { ...settings.claude, enabled: !claudeOn } })
  }

  const mode = MODES.find((m) => m.id === settings?.mode) ?? MODES[0]
  const busy = agentState === 'thinking' || agentState === 'tool' || agentState === 'speaking'

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void window.api.chat.send(text)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.api.chat.cancel()
    }
  }

  const menuBtn = (id: Exclude<Menu, null>, Icon: typeof MessageSquare, label: string) => (
    <button
      onClick={() => setOpen(open === id ? null : id)}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
      style={{ color: T.text2, background: open === id ? T.surface : 'transparent', border: 'none', cursor: 'pointer' }}
    >
      <Icon size={13} />
      {label}
      <ChevronDown size={11} style={{ color: T.text3 }} />
    </button>
  )

  return (
    <div
      ref={barRef}
      className="absolute left-0 right-0 flex justify-center px-6"
      style={{ bottom: 0, paddingTop: 28, paddingBottom: 20, pointerEvents: 'none', background: `linear-gradient(to top, ${T.bg} 0%, ${T.bg} 72%, ${alpha(T.bg, 0)} 100%)` }}
    >
      <div className="w-full flex flex-col gap-2" style={{ maxWidth: 720, pointerEvents: 'auto' }}>
        {claudeOn && <ClaudeStrip />}
        <div className="flex items-center gap-2 px-1">
          <button
            onClick={() => setView('projects')}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            style={{ color: T.text2, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: T.mono }}
          >
            <Folder size={12} />
            {project?.path ?? project?.name ?? 'Global'}
            <ChevronDown size={11} style={{ color: T.text3 }} />
          </button>
          <Lock size={11} style={{ color: T.text3 }} />
          <span className="text-xs" style={{ color: T.text3 }}>
            {project ? 'memory scoped to this project' : 'global memory only'}
          </span>
          {listening && (
            <div className="ml-auto flex items-center gap-1.5 va-fade">
              <VoicePill
                icon={Mic}
                activeIcon={MicOff}
                label="Mute"
                activeLabel="Muted"
                active={micMuted}
                color={T.red}
                tint={T.redTint}
                title={micMuted ? 'Unmute: let her hear you again' : 'Mute: she stops hearing you (voice mode stays on)'}
                onClick={toggleMicMuted}
              />
              <VoicePill
                icon={Headphones}
                activeIcon={HeadphoneOff}
                label="Deafen"
                activeLabel="Deafened"
                active={deafened}
                color={T.cyan}
                tint={T.cyanTint}
                title={deafened ? 'Undeafen: hear her again' : 'Deafen: you stop hearing her (replies still show in the transcript)'}
                onClick={() => setDeafened(!deafened)}
              />
            </div>
          )}
        </div>
        <div
          className="rounded-2xl shadow-2xl"
          style={{ background: T.raised, border: `1px solid ${listening ? T.cyanBorder : claudeOn ? T.violetBorder : T.border}`, transition: 'border-color .2s' }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={claudeOn ? 'Talk or type — e.g. “start a session called landing page and build a one-page site”' : listening ? 'Listening — or type to override…' : 'Ask anything, or press Voice to talk…'}
            rows={2}
            className="w-full bg-transparent px-4 pt-3 pb-1 text-sm resize-none"
            style={{ color: T.text, border: 'none', lineHeight: 1.5 }}
          />
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              <div className="relative">
                {menuBtn('mode', MessageSquare, mode?.label ?? 'Ask')}
                <Dropdown open={open === 'mode'} onClose={() => setOpen(null)} width={260}>
                  {MODES.map((m) => (
                    <MenuItem
                      key={m.id}
                      title={m.label}
                      sub={m.desc}
                      selected={mode?.id === m.id}
                      onClick={() => {
                        void updateSettings({ mode: m.id })
                        setOpen(null)
                      }}
                    />
                  ))}
                </Dropdown>
              </div>
              <div className="relative">
                {menuBtn('model', Sparkles, model?.label ?? 'Model')}
                <Dropdown open={open === 'model'} onClose={() => setOpen(null)} width={260}>
                  {[...models]
                    // models you can actually use come first; the rest stay visible, dimmed, with the way to unlock them
                    .sort((a, b) => Number(keyed?.has(b.provider) ?? true) - Number(keyed?.has(a.provider) ?? true))
                    .map((m) => {
                      const locked = keyed !== null && !keyed.has(m.provider)
                      return (
                        <MenuItem
                          key={m.id}
                          title={m.label}
                          sub={m.note ? `${m.providerLabel} · ${m.note}` : m.providerLabel}
                          selected={model?.id === m.id}
                          disabled={locked}
                          hint={locked ? `No ${m.providerLabel} key · add one in Settings` : undefined}
                          onClick={() => {
                            setOpen(null)
                            if (locked) setView('settings')
                            else void updateSettings({ modelId: m.id })
                          }}
                        />
                      )
                    })}
                </Dropdown>
              </div>
              <div className="relative">
                {menuBtn('style', AlignLeft, style?.label ?? 'Style')}
                <Dropdown open={open === 'style'} onClose={() => setOpen(null)} width={300}>
                  {styles.map((s) => (
                    <MenuItem
                      key={s.id}
                      title={s.label}
                      sub={s.desc}
                      selected={style?.id === s.id}
                      onClick={() => {
                        void updateSettings({ styleId: s.id })
                        setOpen(null)
                      }}
                    />
                  ))}
                  <button
                    onClick={() => {
                      setOpen(null)
                      setView('prompts')
                    }}
                    className="w-full text-left px-3 py-2 text-xs inline-flex items-center gap-2"
                    style={{ color: T.violet, background: 'transparent', border: 'none', borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                  >
                    <Wand2 size={12} /> Create a new style with AI
                  </button>
                </Dropdown>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {claudeAvailable && (
              <button
                aria-label={claudeOn ? 'Turn off Claude Code control' : 'Turn on Claude Code control'}
                aria-pressed={claudeOn}
                title={claudeOn ? 'Claude Code control is on: the voice agent can start, steer and answer Claude Code sessions. Click to turn off.' : 'Turn on Claude Code control: manage Claude Code sessions by voice'}
                onClick={toggleClaude}
                className="inline-flex items-center gap-1.5 rounded-lg text-xs"
                style={{
                  height: 32,
                  padding: '0 10px',
                  color: claudeOn ? T.violet : T.text2,
                  background: claudeOn ? T.violetTint : 'transparent',
                  border: `1px solid ${claudeOn ? T.violetBorder : T.border}`,
                  cursor: 'pointer',
                  transition: 'all .2s ease'
                }}
              >
                <Bot size={13} />
                <span style={{ fontWeight: claudeOn ? 600 : 400 }}>Claude</span>
              </button>
              )}
              {busy && (
                <button
                  onClick={() => void window.api.chat.cancel()}
                  className="text-xs rounded-lg px-2 py-1.5"
                  style={{ color: T.text3, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  title="Esc"
                >
                  stop
                </button>
              )}
              <button
                aria-label={listening ? 'Stop listening' : 'Start voice'}
                onClick={() => void toggleListening()}
                className={`inline-flex items-center justify-center gap-2 rounded-lg text-xs ${listening && !micMuted ? 'va-ring' : ''}`}
                style={{
                  height: 32,
                  minWidth: listening ? 96 : 76,
                  padding: '0 12px',
                  color: listening ? (micMuted ? T.red : T.cyan) : T.text,
                  background: listening ? (micMuted ? T.redTint : T.cyanTint) : T.surface,
                  border: `1px solid ${listening ? (micMuted ? T.red : T.cyan) : T.border}`,
                  cursor: 'pointer',
                  transition: 'all .2s ease'
                }}
              >
                {listening ? micMuted ? <MicOff size={13} /> : <VoiceBars source="mic" color={T.cyan} h={12} /> : <Mic size={13} />}
                <span>{listening ? (micMuted ? 'Muted' : 'Live') : 'Voice'}</span>
              </button>
              <button
                aria-label="Send"
                onClick={send}
                disabled={!draft.trim()}
                className="flex items-center justify-center rounded-lg"
                style={{
                  width: 32,
                  height: 32,
                  background: draft.trim() ? T.text : T.surface,
                  color: draft.trim() ? T.bg : T.text3,
                  border: `1px solid ${T.border}`,
                  cursor: draft.trim() ? 'pointer' : 'default'
                }}
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
