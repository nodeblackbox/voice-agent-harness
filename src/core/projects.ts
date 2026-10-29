import type { Project, Settings } from '@shared/types'

/**
 * Switching to a project brings its default prompt style along, unless the patch picks a style itself.
 * Leaving a project ('' = no project) keeps whatever style is active: that is the user's global choice.
 */
export function withProjectDefaults(patch: Partial<Settings>, current: Settings, projects: Project[]): Partial<Settings> {
  if (patch.projectId === undefined || patch.projectId === current.projectId || patch.styleId !== undefined) return patch
  const style = projects.find((p) => p.id === patch.projectId)?.defaultStyleId
  return style ? { ...patch, styleId: style } : patch
}
