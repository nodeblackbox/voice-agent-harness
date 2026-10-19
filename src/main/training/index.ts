import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AgentEvent, PromptStyle, Settings } from '@shared/types'
import type { SidecarEvent } from '../services/sidecar'
import { TrainingRecorder, type TapInfo } from './recorder'

// Opt-in training recording mode (RECORD_TRAINING_DATA=1 in .env). Everything it needs lives in this
// folder; main/index.ts only forwards events to it. With the flag off, setupTraining returns null and
// the renderer's one config query answers { enabled: false }.

export const DEFAULT_RECORD_DIR = 'D:\\Downloads\\fish-audio-cloning-pipe-line\\raw'
export const COACH_STYLE_ID = 'recording-coach'

export interface TrainingDeps {
  env: (name: string) => string | undefined
  appVersion: string
  log: (msg: string) => void
  notify: (msg: string) => void
}

export interface Training {
  recorder: TrainingRecorder
  /** The coach prompt as a style, when a prompt file was found. */
  styles: PromptStyle[]
  /** Settings as the agent should see them: the coach style while recording mode is on. */
  settings(s: Settings): Settings
  onEarEvent(evt: SidecarEvent): void
  onAgentEvent(evt: AgentEvent): void
}

const on = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v)

export function setupTraining(deps: TrainingDeps): Training | null {
  const enabled = on(deps.env('RECORD_TRAINING_DATA'))
  const root = deps.env('RECORD_DIR') ?? DEFAULT_RECORD_DIR
  ipcMain.handle(IPC.trainingConfig, () => ({ enabled }))
  if (!enabled) return null

  const recorder = new TrainingRecorder({ root, appVersion: deps.appVersion, roomtone: on(deps.env('RECORD_ROOMTONE')), log: deps.log, notify: deps.notify })
  ipcMain.handle(IPC.trainingTapStart, (_e, info: TapInfo) => recorder.tapStarted(info))
  ipcMain.on(IPC.trainingTapStop, () => recorder.tapStopped())
  ipcMain.on(IPC.trainingFrame, (_e, pcm: ArrayBuffer) => recorder.pushFrame(new Float32Array(pcm)))

  const promptFile = deps.env('RECORD_SYSTEM_PROMPT_FILE') ?? join(dirname(root), 'recording-coach.md')
  const styles: PromptStyle[] = []
  if (existsSync(promptFile)) {
    styles.push({
      id: COACH_STYLE_ID,
      label: 'Recording coach',
      desc: 'Training recording mode: gets you talking for the voice-clone dataset.',
      kind: 'custom',
      body: readFileSync(promptFile, 'utf8').trim(),
      length: 'short',
      format: 'plain'
    })
  } else deps.log(`training: no coach prompt at ${promptFile}; using the selected style`)
  deps.log(`training: recording mode on -> ${root}`)
  deps.notify(`Training recording mode is on: your mic audio is saved to ${root}.`)

  return {
    recorder,
    styles,
    settings: (s) => (styles.length ? { ...s, styleId: COACH_STYLE_ID } : s),
    onEarEvent: (evt) => {
      if (evt.type === 'speech_end') recorder.onSpeechEnd(evt)
      else if (evt.type === 'final') recorder.onFinal(evt.text)
      else if (evt.type === 'bargein' && evt.stage === 'cut') recorder.onBargeIn(evt.prerollMs)
      else if (evt.type === 'ready') recorder.earsRestarted()
    },
    onAgentEvent: (evt) => {
      // streaming updates count too: a reply cut off by a barge-in may never get a final update first
      if (evt.type !== 'message' || evt.message.role !== 'assistant') return
      const m = evt.message
      recorder.onAgentText(m.interrupted && m.spokenText ? m.spokenText : m.text)
    }
  }
}
