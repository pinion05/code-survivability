import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, ratePerMinute: number, burst: number): boolean {
    const now = this.now();
    const previous = this.buckets.get(key) ?? { tokens: burst, updatedAt: now };
    const refill = ((now - previous.updatedAt) / 60_000) * ratePerMinute;
    const tokens = Math.min(burst, previous.tokens + refill);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }
}

export class AdmissionController {
  private readonly limiter: TokenBucketLimiter;

  constructor(now?: () => number) {
    this.limiter = new TokenBucketLimiter(now);
  }

  admitCreation(clientKey: string): void {
    if (
      !this.limiter.consume(
        `create:${clientKey}`,
        LIMITS.clientRatePerMinute,
        LIMITS.clientBurst,
      ) ||
      !this.limiter.consume(
        "global",
        LIMITS.globalRatePerMinute,
        LIMITS.globalBurst,
      )
    ) {
      throw new AppError("RATE_LIMITED", "요청 생성 속도 한도를 초과했습니다");
    }
  }

  admitPoll(clientKey: string, jobId: string): void {
    if (
      !this.limiter.consume(
        `poll:${clientKey}:${jobId}`,
        LIMITS.pollRatePerMinute,
        6,
      )
    ) {
      throw new AppError("RATE_LIMITED", "상태 조회 속도 한도를 초과했습니다");
    }
  }
}
