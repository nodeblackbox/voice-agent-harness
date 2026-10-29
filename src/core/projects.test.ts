import { describe, expect, it } from 'vitest'
import type { Project, Settings } from '@shared/types'
import { withProjectDefaults } from './projects'

const current = { projectId: 'global', styleId: 'short' } as Settings
const projects: Project[] = [
  { id: 'p1', name: 'Docs', defaultStyleId: 'comprehensive', createdAt: 1 },
  { id: 'p2', name: 'Bare', createdAt: 1 }
]

describe('withProjectDefaults', () => {
  it('applies the project\'s default style when switching to it', () => {
    expect(withProjectDefaults({ projectId: 'p1' }, current, projects)).toEqual({ projectId: 'p1', styleId: 'comprehensive' })
  })

  it('leaves the style alone for a project without one, and when leaving a project', () => {
    expect(withProjectDefaults({ projectId: 'p2' }, current, projects)).toEqual({ projectId: 'p2' })
    expect(withProjectDefaults({ projectId: '' }, { ...current, projectId: 'p1' }, projects)).toEqual({ projectId: '' })
  })

  it('does nothing when the project is unchanged or the patch chooses a style itself', () => {
    expect(withProjectDefaults({ projectId: 'global' }, current, projects)).toEqual({ projectId: 'global' })
    expect(withProjectDefaults({ projectId: 'p1', styleId: 'short' }, current, projects)).toEqual({ projectId: 'p1', styleId: 'short' })
    expect(withProjectDefaults({ agentName: 'Ava' }, current, projects)).toEqual({ agentName: 'Ava' })
  })
})
