/** Types for voice-managed Claude Code sessions. Electron-free: shared by the manager, tools and IPC. */

import type { CcAnswer, CcEvent, CcFile, CcFileContent, CcManagerEvent, CcPending, CcQuestion, CcResult, CcSession, CcStatus } from '@shared/claude'

export type { CcAnswer, CcEvent, CcFile, CcFileContent, CcManagerEvent, CcPending, CcQuestion, CcResult, CcSession, CcStatus }

// ---- SDK seam (real implementation in sdk.ts, a scripted fake in tests) ----

export type CcPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export interface CcRunOpts {
  cwd: string
  model?: string
  resume?: string
  /** Streaming prompt: the manager pushes user messages here. */
  input: AsyncIterable<unknown>
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<CcPermissionResult>
  /** Hard gate, run as a PreToolUse hook before any permission logic. */
  gate: (toolName: string, input: Record<string, unknown>) => { allow: true } | { allow: false; reason: string }
}

export interface CcRun {
  messages: AsyncIterable<any>
  interrupt(): Promise<void>
  close(): void
}

export type CcSdk = (opts: CcRunOpts) => CcRun
