type Entry<V> = { value: V; weight: number; expiresAt: number };

export class WeightedLru<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  get weight(): number {
    this.sweep();
    return this.totalWeight;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, weight: number, ttlMs: number): boolean {
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > this.maxWeight)
      return false;
    this.delete(key);
    this.entries.set(key, { value, weight, expiresAt: this.now() + ttlMs });
    this.totalWeight += weight;
    this.evict();
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.totalWeight -= entry.weight;
    return this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  private evict(): void {
    this.sweep();
    while (
      this.entries.size > this.maxEntries ||
      this.totalWeight > this.maxWeight
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
