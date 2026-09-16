type Entry<T> = { pending?: Promise<T>; value?: T; expiresAt: number; timer?: ReturnType<typeof setTimeout> };

/** Bounded, process-local reads. Concurrent readers share one request; failed
 * reads are never cached. Invalidated in-flight work cannot refill the cache. */
export class ReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  private ttl: number | ((value: T) => number);
  private limit: number;
  constructor(ttl: number | ((value: T) => number), limit = 32) { this.ttl = ttl; this.limit = limit; }

  delete(key: string) {
    clearTimeout(this.entries.get(key)?.timer);
    this.entries.delete(key);
  }

  clear(prefix = "") {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.delete(key);
  }

  get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const current = this.entries.get(key);
    if (current?.pending) return current.pending;
    if (!fresh && current && current.expiresAt > Date.now()) return Promise.resolve(current.value!);
    this.delete(key);
    while (this.entries.size >= this.limit) this.delete(this.entries.keys().next().value!);
    const entry: Entry<T> = { expiresAt: 0 };
    this.entries.set(key, entry);
    const pending = Promise.resolve().then(load).then(value => {
      if (this.entries.get(key) === entry) {
        const ttl = typeof this.ttl === "function" ? this.ttl(value) : this.ttl;
        if (!(ttl > 0)) this.delete(key);
        else {
          entry.value = value;
          entry.expiresAt = Date.now() + ttl;
          entry.pending = undefined;
          entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.delete(key); }, ttl);
          entry.timer.unref();
        }
      }
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.delete(key);
      throw error;
    });
    entry.pending = pending;
    return pending;
  }
}
