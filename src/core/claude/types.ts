/** Types for voice-managed Claude Code sessions. Electron-free: shared by the manager, tools and IPC. */

import type { CcAnswer, CcEvent, CcExternal, CcFile, CcFileContent, CcManagerEvent, CcMode, CcPending, CcQuestion, CcResult, CcSession, CcStatus } from '@shared/claude'
import type { FenceVerdict } from './fence'

export type { CcAnswer, CcEvent, CcExternal, CcFile, CcFileContent, CcManagerEvent, CcMode, CcPending, CcQuestion, CcResult, CcSession, CcStatus }

// ---- SDK seam (real implementation in sdk.ts, a scripted fake in tests) ----

export type CcPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export interface CcRunOpts {
  cwd: string
  model?: string
  resume?: string
  /** With resume: continue in a new session id, leaving the original transcript as it was. */
  fork?: boolean
  /** The CLI's own mode: 'plan' keeps it read-only until a plan is approved. */
  permissionMode: SdkMode
  /** Streaming prompt: the manager pushes user messages here. */
  input: AsyncIterable<unknown>
  /** `reason`: why it asks (a fence 'ask' arrives here with FENCE_TAG in front). */
  canUseTool: (toolName: string, input: Record<string, unknown>, meta: { reason?: string }) => Promise<CcPermissionResult>
  /** Hard gate, run as a PreToolUse hook before any permission logic. `cwd` = the shell's current folder. */
  gate: (toolName: string, input: Record<string, unknown>, cwd?: string) => FenceVerdict
}

export type SdkMode = 'plan' | 'default'
/** Marks a permission request that came from the fence asking (not refusing). */
export const FENCE_TAG = '[fence] '

export interface CcRun {
  messages: AsyncIterable<any>
  interrupt(): Promise<void>
  /** Change the CLI's mode mid-session (lab: works on the live stream). */
  setPermissionMode?(mode: SdkMode): Promise<void>
  close(): void
}

export type CcSdk = (opts: CcRunOpts) => CcRun

/** Saved sessions on this machine (real: the SDK's listSessions/getSessionMessages). */
export interface CcHistory {
  list(limit: number): Promise<CcExternal[]>
  messages(sessionId: string, cwd?: string): Promise<unknown[]>
}
