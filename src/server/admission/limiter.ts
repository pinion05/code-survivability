import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = LIMITS.rateLimiterEntries,
    private readonly ttlMs: number = LIMITS.rateLimiterTtlMs,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, ratePerMinute: number, burst: number): boolean {
    const now = this.now();
    if (
      now - this.lastSweep >= Math.min(this.ttlMs, 60_000) ||
      this.buckets.size >= this.maxEntries
    ) {
      this.prune(now);
    }
    const stored = this.buckets.get(key);
    const previous =
      stored && stored.updatedAt + this.ttlMs > now
        ? stored
        : { tokens: burst, updatedAt: now };
    const refill = ((now - previous.updatedAt) / 60_000) * ratePerMinute;
    const tokens = Math.min(burst, previous.tokens + refill);
    this.buckets.delete(key);
    while (this.buckets.size >= this.maxEntries) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt + this.ttlMs > now) break;
      this.buckets.delete(key);
    }
    this.lastSweep = now;
  }
}

export class AdmissionController {
  private readonly creationClients: TokenBucketLimiter;
  private readonly creationGlobal: TokenBucketLimiter;
  private readonly pollClients: TokenBucketLimiter;
  private readonly pollGlobal: TokenBucketLimiter;

  constructor(now: () => number = Date.now) {
    this.creationClients = new TokenBucketLimiter(now);
    this.creationGlobal = new TokenBucketLimiter(
      now,
      1,
      LIMITS.rateLimiterTtlMs,
    );
    this.pollClients = new TokenBucketLimiter(now);
    this.pollGlobal = new TokenBucketLimiter(now, 1, LIMITS.rateLimiterTtlMs);
  }

  admitCreation(clientKey: string): void {
    if (
      !this.creationClients.consume(
        clientKey,
        LIMITS.clientRatePerMinute,
        LIMITS.clientBurst,
      ) ||
      !this.creationGlobal.consume(
        "global",
        LIMITS.globalRatePerMinute,
        LIMITS.globalBurst,
      )
    ) {
      throw new AppError("RATE_LIMITED", "요청 생성 속도 한도를 초과했습니다");
    }
  }

  admitPoll(clientKey: string): void {
    if (
      !this.pollClients.consume(
        clientKey,
        LIMITS.pollRatePerMinute,
        LIMITS.pollBurst,
      ) ||
      !this.pollGlobal.consume(
        "global",
        LIMITS.globalPollRatePerMinute,
        LIMITS.globalPollBurst,
      )
    ) {
      throw new AppError("RATE_LIMITED", "상태 조회 속도 한도를 초과했습니다");
    }
  }
}
