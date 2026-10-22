/** A push-able async iterable: the SDK's streaming-input prompt. Messages pushed before iteration starts are kept. */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.queue.push(item)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift() as T
      if (this.closed) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = null
    }
  }
}
