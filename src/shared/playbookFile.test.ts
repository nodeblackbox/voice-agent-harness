import { describe, expect, it } from 'vitest'
import { NEW_PLAYBOOK_TEXT, NEW_RUNBOOK_TEXT, field, readPlaybookFile, setPlaybookBody, setPlaybookField } from './playbookFile'

const FILE = '---\ntitle: Push # the name\ntriggers:\n  said: ["push the changes"]\ngates:\n  cooldownS: 30\n---\nOffer to push.\n'

describe('playbook file editing', () => {
  it('reads the header and the body, and says why when it cannot', () => {
    const r = readPlaybookFile(FILE)
    expect(r.header).toEqual({ title: 'Push', triggers: { said: ['push the changes'] }, gates: { cooldownS: 30 } })
    expect(r.body).toBe('Offer to push.\n')
    expect(readPlaybookFile('no header').problem).toMatch(/no header/)
    expect(readPlaybookFile('---\ntitle: [x\n---\nb').problem).toMatch(/^YAML/)
  })

  it('sets a nested field and keeps comments, order and the body', () => {
    const out = setPlaybookField(FILE, ['triggers', 'when'], 'chars > 100')!
    expect(out).toContain('title: Push # the name')
    expect(out).toContain('when: chars > 100')
    expect(out.endsWith('---\nOffer to push.\n')).toBe(true)
    expect(readPlaybookFile(out).header!.triggers).toEqual({ said: ['push the changes'], when: 'chars > 100' })
  })

  it('removes a field with undefined, and an emptied section with it', () => {
    const out = setPlaybookField(FILE, ['gates', 'cooldownS'], undefined)!
    expect(out).not.toContain('gates')
    expect(out).not.toContain('cooldownS')
  })

  it('replaces the body, and keeps Windows line endings', () => {
    const crlf = FILE.replace(/\n/g, '\r\n')
    const out = setPlaybookBody(crlf, 'New instruction.')!
    expect(out.endsWith('---\r\nNew instruction.\r\n')).toBe(true)
    expect(setPlaybookField(crlf, ['title'], 'Ship')!).toContain('title: Ship # the name\r\n')
  })

  it('refuses to edit a file whose header cannot be read', () => {
    expect(setPlaybookField('---\ntitle: [x\n---\nb', ['title'], 'y')).toBeNull()
    expect(setPlaybookBody('nothing', 'b')).toBeNull()
  })

  it('reads typed values with defaults, and the new-file skeletons read cleanly', () => {
    expect(field.num('3', 5)).toBe(5)
    expect(field.list(['a', 2, 'b'])).toEqual(['a', 'b'])
    expect(readPlaybookFile(NEW_PLAYBOOK_TEXT).header!.kind).toBe('playbook')
    expect((readPlaybookFile(NEW_RUNBOOK_TEXT).header!.steps as unknown[]).length).toBe(2)
  })
})
