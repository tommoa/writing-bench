/**
 * Minimal scheduler -- just tracks in-flight promises so we can
 * wait for all cascading reactive work to complete.
 *
 * Each task is deferred to the next macrotask via setTimeout(0)
 * so the event loop can process signals (SIGINT) between tasks.
 * Without this, cached results create a synchronous microtask
 * cascade that starves the event loop and prevents Ctrl+C.
 */
export class Scheduler {
  private inflight = new Set<Promise<unknown>>();

  /**
   * Defer a task to the next macrotask, then run it.
   */
  schedule<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const p = new Promise<T>((resolve, reject) => {
      setTimeout(() => fn().then(resolve, reject), 0);
    });
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }

  /**
   * Wait for all in-flight tasks (and any they spawn) to complete.
   */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }
}
