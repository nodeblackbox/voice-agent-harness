import { useStore } from '../state/store'
import { SessionsSidebar } from '../components/chat/SessionsSidebar'
import { ChatHeader } from '../components/chat/ChatHeader'
import { Transcript } from '../components/chat/Transcript'
import { InputBar } from '../components/chat/InputBar'
import { QuickPanel } from '../components/chat/QuickPanel'
import { NoKeyBanner } from '../components/chat/NoKeyBanner'
import { SlowVoiceBanner } from '../components/chat/SlowVoiceBanner'

export function ChatView() {
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  return (
    <>
      {leftOpen && <SessionsSidebar />}
      <main className="flex-1 flex flex-col min-w-0 relative">
        <ChatHeader />
        <NoKeyBanner />
        <SlowVoiceBanner />
        <Transcript />
        <InputBar />
      </main>
      {rightOpen && <QuickPanel />}
    </>
  )
}
