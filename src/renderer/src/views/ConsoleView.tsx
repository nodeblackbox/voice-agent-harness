import { FolderOpen, MessageSquare } from 'lucide-react'
import { T } from '../theme'
import { useStore } from '../state/store'
import { useConsole } from '../state/console'
import { Btn } from '../components/primitives'
import { StateIndicator } from '../components/chat/StateIndicator'
import { ConsoleFeed } from '../components/console/ConsoleFeed'

/** The whole window as a live log: what was heard, which model and voice answered, what was cut off and why. */
export function ConsoleView() {
  const agentState = useStore((s) => s.agentState)
  const services = useStore((s) => s.services)
  const micMuted = useStore((s) => s.micMuted)
  const setView = useStore((s) => s.setView)
  const setRightOpen = useStore((s) => s.setRightOpen)
  const setRightTab = useStore((s) => s.setRightTab)
  const total = useConsole((s) => s.entries.length + s.trimmed)

  const besideChat = (): void => {
    setRightTab('console')
    setRightOpen(true)
    setView('chat')
  }

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0">
      <header className="flex items-center justify-between gap-4 px-4" style={{ height: 52, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-base font-semibold" style={{ margin: 0, color: T.text }}>
            Console
          </h1>
          <span className="text-xs truncate" style={{ color: T.text3 }}>
            Everything the app does, live. Click a row for the raw event. {total > 0 && `${total.toLocaleString()} events this run.`}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StateIndicator state={agentState} toolLabel={null} toolSummary={null} services={services} micMuted={micMuted} />
          <Btn small icon={MessageSquare} onClick={besideChat}>
            Show beside chat
          </Btn>
          <Btn small icon={FolderOpen} onClick={() => void window.api.diag.openLogsFolder()}>
            Log files
          </Btn>
        </div>
      </header>
      <ConsoleFeed />
    </main>
  )
}
