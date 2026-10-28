/**
 * One HTTP byte range ("bytes=100-", "bytes=0-499", "bytes=-500") against a file of `size` bytes. Media elements
 * ask for ranges to start and to seek; without 206 answers a video plays but cannot be scrubbed.
 * Returns null for no/unsupported header (send the whole file) and 'unsatisfiable' for a range past the end.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
