/**
 * Minimal scheduler — just tracks in-flight promises so we can
 * wait for all cascading reactive work to complete.
 */
export class Scheduler {
  private inflight = new Set<Promise<unknown>>();

  /**
   * Fire a task immediately. Returns a promise for its result.
   */
  schedule<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const p = fn();
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
