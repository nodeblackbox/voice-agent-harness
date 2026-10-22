/** Side panel next to the activity feed: the session's plan, what it changed, and how it spent its effort. */
import { CircleCheck, CircleDot, Circle } from 'lucide-react'
import type { CcEvent, CcSession } from '@shared/claude'
import { T } from '../../theme'
import { FAMILY } from './Activity'
import { ago, latestTodos, toolStats, type Touched } from './feed'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium uppercase" style={{ color: T.text3, letterSpacing: 0.6, fontSize: 10.5 }}>{title}</div>
      {children}
    </div>
  )
}

export function Inspector({ session, events, touched, onOpenFile }: { session: CcSession; events: CcEvent[]; touched: Touched[]; onOpenFile: (rel: string) => void }) {
  const todos = latestTodos(events)
  const stats = toolStats(events)
  const max = Math.max(1, ...stats.map((s) => s.count))
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <aside className="va-scroll hidden xl:flex flex-col gap-5 p-4 overflow-y-auto" style={{ width: 250, borderLeft: `1px solid ${T.border}`, background: T.rail }}>
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Cost', `$${session.costUsd.toFixed(2)}`],
          ['Turns', String(session.turns)],
          ['Files', String(touched.length)],
          ['Tool calls', String(stats.reduce((n, s) => n + s.count, 0))]
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg px-2.5 py-2" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
            <div style={{ color: T.text3, fontSize: 10.5 }}>{k}</div>
            <div className="text-sm font-semibold" style={{ color: T.text, fontFamily: T.mono }}>{v}</div>
          </div>
        ))}
      </div>

      {todos.length > 0 && (
        <Section title={`Plan · ${done}/${todos.length}`}>
          <div className="rounded-full overflow-hidden" style={{ height: 4, background: T.raised }}>
            <div style={{ width: `${(done / todos.length) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${T.violet}, ${T.green})`, transition: 'width .4s ease' }} />
          </div>
          <div className="flex flex-col gap-1.5">
            {todos.map((t, i) => {
              const Icon = t.status === 'completed' ? CircleCheck : t.status === 'in_progress' ? CircleDot : Circle
              return (
                <div key={i} className="flex items-start gap-2 text-xs" style={{ color: t.status === 'completed' ? T.text3 : T.text2, lineHeight: 1.45 }}>
                  <Icon size={12} className={t.status === 'in_progress' ? 'va-pulse' : undefined} style={{ marginTop: 2, flexShrink: 0, color: t.status === 'completed' ? T.green : t.status === 'in_progress' ? T.violet : T.text3 }} />
                  <span style={{ textDecoration: t.status === 'completed' ? 'line-through' : undefined }}>{t.content}</span>
                </div>
              )
            })}
          </div>
        </Section>
      )}

      <Section title="Changed files">
        {touched.length === 0 && <div className="text-xs" style={{ color: T.text3 }}>Nothing yet.</div>}
        {touched.slice(0, 12).map((t) => (
          <button key={t.path} type="button" onClick={() => onOpenFile(t.path)} className="va-tree-row flex items-center gap-2 text-xs rounded-md px-1.5 py-1 text-left" style={{ cursor: 'pointer', background: 'transparent' }}>
            <span style={{ color: t.writes ? T.green : T.violet, fontFamily: T.mono, fontWeight: 600, width: 10 }}>{t.writes ? 'A' : 'M'}</span>
            <span className="truncate flex-1" style={{ color: T.text2, fontFamily: T.mono }}>{t.path}</span>
            <span style={{ color: T.text3, fontSize: 10.5, flexShrink: 0 }}>{ago(t.t)}</span>
          </button>
        ))}
      </Section>

      {stats.length > 0 && (
        <Section title="Where the work went">
          {stats.map((s) => {
            const f = FAMILY[s.family]
            return (
              <div key={s.family} className="flex items-center gap-2 text-xs">
                <f.icon size={12} style={{ color: f.color, flexShrink: 0 }} />
                <span style={{ color: T.text2, width: 62, flexShrink: 0 }}>{f.label}</span>
                <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: T.raised }}>
                  <div style={{ width: `${(s.count / max) * 100}%`, height: '100%', background: f.color, opacity: 0.75, transition: 'width .4s ease' }} />
                </div>
                <span style={{ color: T.text3, fontFamily: T.mono, width: 20, textAlign: 'right' }}>{s.count}</span>
              </div>
            )
          })}
        </Section>
      )}

      <Section title="Session">
        <div className="text-xs flex flex-col gap-1" style={{ color: T.text3, lineHeight: 1.5 }}>
          <span>Started {ago(session.createdAt)}</span>
          <span>Last activity {ago(session.updatedAt)}</span>
          <span>{session.sdkSessionId ? 'Remembers its conversation' : 'Fresh conversation'}</span>
        </div>
      </Section>
    </aside>
  )
}
