import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConsoleEntry } from '@shared/console'
import { useConsole } from '../../state/console'
import { ConsoleFeed } from './ConsoleFeed'

let host: HTMLDivElement
let root: Root
let id = 0
const ev = (name: string, data: Record<string, unknown> = {}): ConsoleEntry => ({ id: ++id, t: 1_795_160_000_000 + id * 100, kind: 'trace', level: 'info', name, msg: '', data })
const add = async (...e: ConsoleEntry[]) => { await act(async () => useConsole.getState().add(e)) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }
const type = async (value: string) => {
  const input = host.querySelector('input[aria-label="Search the console"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const log = () => host.querySelector('[role="log"]')!.textContent ?? ''

beforeEach(async () => {
  localStorage.clear()
  id = 0
  useConsole.setState({ entries: [], trimmed: 0, clearedBefore: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<ConsoleFeed />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('ConsoleFeed', () => {
  it('shows events in plain words as they arrive, with a divider per turn', async () => {
    expect(log()).toContain('Nothing yet.')
    await add(ev('ear.final', { text: 'Hello there.', asrMs: 120 }), ev('turn.start', { via: 'voice', text: 'Hello there.', model: 'openai:gpt-4.1-mini' }), ev('tts.sentence', { seq: 0, outcome: 'ok', engine: 'edge', chars: 12, ms: 300, firstByteMs: 200 }))
    expect(log()).toContain('Heard: “Hello there.”')
    expect(log()).toContain('new turn')
    expect(log()).toContain('Voiced sentence 1')
  })

  it('hides chatty events until Verbose is on', async () => {
    await add(ev('ear.partial', { text: 'hel' }), ev('ear.final', { text: 'Hello.', asrMs: 90 }))
    expect(log()).not.toContain('hearing')
    await click(button('Verbose'))
    expect(log()).toContain('hearing')
  })

  it('filters by category, by problems and by search', async () => {
    await add(ev('ear.final', { text: 'Hello.', asrMs: 90 }), ev('tts.engine_down', { engine: 'elevenlabs', reason: '404', fallback: 'kokoro', retryInMs: 60000 }), ev('playback.started', { seq: 0, kind: 'speech' }))
    await click(button('Voice'))
    expect(log()).not.toContain('elevenlabs voice is down')
    expect(log()).toContain('Heard')
    await click(button('Voice'))
    await click(button('Problems'))
    expect(log()).toContain('elevenlabs voice is down')
    expect(log()).not.toContain('Heard')
    await click(button('Problems'))
    await type('playing')
    expect(log()).toContain('Playing sentence 1')
    expect(log()).not.toContain('Heard')
  })

  it('pause freezes the list and counts what arrives meanwhile; resume shows it', async () => {
    await add(ev('ear.final', { text: 'One.', asrMs: 90 }))
    await click(button('Pause'))
    await add(ev('ear.final', { text: 'Two.', asrMs: 90 }))
    expect(log()).not.toContain('Two.')
    expect(button('Resume').textContent).toContain('1 new')
    await click(button('Resume'))
    expect(log()).toContain('Two.')
  })

  it('a click on a row shows the raw event; Clear empties the list', async () => {
    await add(ev('turn.cancel', { reason: 'barge-in', spokenText: 'Hey', unspokenText: 'there' }))
    await click(host.querySelector('.va-tree-row')!)
    expect(host.querySelector('pre')?.textContent).toContain('"ev": "turn.cancel"')
    await click(host.querySelector('button[title^="Empty the console"]')!)
    expect(log()).toContain('Nothing yet.')
    await add(ev('ear.final', { text: 'After.', asrMs: 90 }))
    expect(log()).toContain('After.')
  })

  it('the store drops duplicates and anything older than a clear', () => {
    const a = ev('ear.final', { text: 'a' })
    useConsole.getState().add([a])
    useConsole.getState().add([a])
    expect(useConsole.getState().entries).toHaveLength(1)
    useConsole.getState().clear()
    useConsole.getState().add([a])
    expect(useConsole.getState().entries).toHaveLength(0)
  })
})
