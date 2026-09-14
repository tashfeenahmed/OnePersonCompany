/** Coordinate agent configuration with requests using that configuration.
 * Preparation is serialized, but requests on an unchanged provider run in parallel. */
export class ProviderUse {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;
  private idle = new Set<() => void>();

  private async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.tail.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.tail = next.catch(() => {});
    return next;
  }

  private waitIdle = (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (!this.active) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal?.reason); };
      const clean = () => { this.idle.delete(done); signal?.removeEventListener("abort", abort); };
      this.idle.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };

  async acquire(prepare: (idle: () => Promise<void>) => Promise<void>, signal?: AbortSignal): Promise<() => void> {
    return this.exclusive(async () => {
      await prepare(() => this.waitIdle(signal));
      signal?.throwIfAborted();
      this.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active -= 1;
        if (!this.active) for (const done of [...this.idle]) done();
      };
    }, signal);
  }

  /** Background/configuration actions use the same lock as new requests. */
  async configure<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.exclusive(async () => {
      await this.waitIdle(signal);
      return work();
    }, signal);
  }
}
