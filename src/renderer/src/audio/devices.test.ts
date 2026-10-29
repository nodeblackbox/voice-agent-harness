import { describe, expect, it } from 'vitest'
import { pickDefaults, type DeviceLists } from './devices'

const dev = (deviceId: string, label: string, kind: 'audioinput' | 'audiooutput'): MediaDeviceInfo =>
  ({ deviceId, label, kind, groupId: 'g', toJSON: () => ({}) }) as MediaDeviceInfo

const lists = (inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] = []): DeviceLists => ({ inputs, outputs })

describe('pickDefaults', () => {
  it('leaves the system default in place when nothing is configured, whatever mics exist', () => {
    expect(pickDefaults({}, lists([dev('default', 'Default - Yeti Classic', 'audioinput'), dev('abc', 'Yeti Classic (Blue)', 'audioinput')]))).toBeNull()
    expect(pickDefaults({}, lists([dev('x', 'Webcam mic', 'audioinput')]))).toBeNull()
  })

  it('keeps the configured input when it is still present', () => {
    expect(pickDefaults({ inputDeviceId: 'x', inputLabel: 'Webcam mic' }, lists([dev('x', 'Webcam mic', 'audioinput')]))).toBeNull()
  })

  it('re-resolves a missing input by label', () => {
    const patch = pickDefaults(
      { inputDeviceId: 'old', inputLabel: 'Webcam mic' },
      lists([dev('new', 'Webcam mic', 'audioinput'), dev('y', 'Yeti', 'audioinput')])
    )
    expect(patch).toEqual({ inputDeviceId: 'new', inputLabel: 'Webcam mic' })
  })

  it('clears a configured input that vanished with no substitute, never picking another mic by name', () => {
    const patch = pickDefaults({ inputDeviceId: 'old', inputLabel: 'Gone' }, lists([dev('x', 'Other', 'audioinput'), dev('y', 'Yeti', 'audioinput')]))
    expect(patch).toEqual({ inputDeviceId: undefined, inputLabel: undefined })
  })

  it('re-resolves a missing output by label', () => {
    const patch = pickDefaults({ outputDeviceId: 'o1', outputLabel: 'Headphones' }, lists([], [dev('o2', 'Headphones', 'audiooutput')]))
    expect(patch).toEqual({ outputDeviceId: 'o2', outputLabel: 'Headphones' })
  })
})
