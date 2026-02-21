// ─── Concurrency Utilities ───────────────────────────────────────────────────

/**
 * Classic counting semaphore for async code.
 * Limits how many async operations can be in-flight simultaneously.
 *
 * Usage:
 *   const sem = new Semaphore(5);
 *   await sem.acquire();
 *   try { await doWork(); } finally { sem.release(); }
 */
export class Semaphore {
  constructor(max) {
    this._max = max;
    this._count = 0;
    this._queue = [];
  }

  /** Block until a slot is free, then occupy it. */
  async acquire() {
    if (this._count < this._max) {
      this._count++;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
    this._count++;
  }

  /** Release a slot, waking the next waiter if any. */
  release() {
    this._count--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    }
  }
}

/**
 * A serial queue that runs async tasks one at a time, in submission order.
 * Useful to serialise file writes that would otherwise race when concurrent
 * fetch operations all complete around the same time.
 *
 * Usage:
 *   const q = new SerialQueue();
 *   await q.enqueue(() => writeFileSomewhere(data));
 */
export class SerialQueue {
  constructor() {
    // Invariant: _tail is always a resolved promise after the last enqueued task
    this._tail = Promise.resolve();
  }

  /**
   * Enqueue an async task.  The task will not start until all previously
   * enqueued tasks have finished (successfully or not).
   * Returns a promise that resolves/rejects with the task's own result.
   */
  enqueue(fn) {
    const result = this._tail.then(() => fn(), () => fn());
    // Keep the chain alive but swallow errors so one failed task doesn't
    // prevent subsequent tasks from running.
    this._tail = result.then(() => {}, () => {});
    return result;
  }
}
