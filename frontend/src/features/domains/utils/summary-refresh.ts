interface Pending {
  promise: Promise<void>;
  resolve: () => void;
  force: boolean;
}

/** One read in flight. Mutations during that read require one subsequent read. */
export class SummaryRefresh {
  private pending: Pending | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly load: (signal: AbortSignal, force: boolean) => Promise<void>, private readonly delay = 25) {}

  request(options: { invalidate?: boolean; force?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running && !this.pending && !options.invalidate && !options.force) return this.running;
    if (!this.pending) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      this.pending = { promise, resolve, force: false };
    }
    this.pending.force ||= Boolean(options.force);
    if (!this.running && this.timer === null) this.schedule();
    return this.pending.promise;
  }
  private schedule() {
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delay);
  }
  private flush() {
    if (this.disposed || !this.pending) return;
    const batch = this.pending; this.pending = null;
    const controller = new AbortController(); this.controller = controller;
    const task = Promise.resolve().then(() => this.load(controller.signal, batch.force))
      .catch(() => {}) // The loader owns error reporting; all callers still settle.
      .finally(() => {
        batch.resolve();
        if (this.running === task) this.running = null;
        if (this.controller === controller) this.controller = null;
        if (!this.disposed && this.pending) this.schedule();
      });
    this.running = task;
  }
  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.controller?.abort();
    this.pending?.resolve(); this.pending = null;
  }
}
