// Key-scoped async mutex that serializes tasks with the same key in FIFO order while allowing concurrency across keys (#24).
export class KeyedMutex {
  // Tail of the per-key waiting promise chain.
  private tails = new Map<string, Promise<void>>();

  // Acquire lock. Returns an idempotent release function. Callers must release in try/finally.
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    await prev;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      // Clean up map entry when no subsequent tasks are waiting to prevent memory leaks.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
