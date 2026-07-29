import { describe, expect, test } from "bun:test";
import {
  AdmissionController,
  TokenBucketLimiter,
} from "../../src/server/admission/limiter";
import { WeightedLru } from "../../src/server/cache/weighted-lru";
import { AppError } from "../../src/server/errors";

describe("weighted TTL LRU", () => {
  test("evicts least-recently-used entries by count and weight", () => {
    let now = 1_000;
    const cache = new WeightedLru<string>(2, 6, () => now);

    expect(cache.set("a", "A", 2, 1_000)).toBe(true);
    expect(cache.set("b", "B", 2, 1_000)).toBe(true);
    expect(cache.get("a")).toBe("A");
    expect(cache.set("c", "C", 3, 1_000)).toBe(true);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.weight).toBe(5);

    now += 1_001;
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  test("rejects an entry that cannot fit without evicting itself", () => {
    const cache = new WeightedLru<string>(2, 5);
    expect(cache.set("too-large", "value", 6, 1_000)).toBe(false);
    expect(cache.size).toBe(0);
  });
});

describe("admission limits", () => {
  test("refills token buckets deterministically", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(() => now);
    expect(limiter.consume("client", 2, 2)).toBe(true);
    expect(limiter.consume("client", 2, 2)).toBe(true);
    expect(limiter.consume("client", 2, 2)).toBe(false);
    now = 30_000;
    expect(limiter.consume("client", 2, 2)).toBe(true);
  });

  test("bounds attacker-controlled bucket keys and expires inactive entries", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(() => now, 3, 1_000);
    for (const key of ["a", "b", "c", "d", "e"]) {
      expect(limiter.consume(key, 1, 1)).toBe(true);
    }
    expect(limiter.size).toBe(3);

    now = 1_001;
    expect(limiter.consume("fresh", 1, 1)).toBe(true);
    expect(limiter.size).toBe(1);
  });

  test("enforces client creation and poll bursts", () => {
    const admission = new AdmissionController(() => 0);
    admission.admitCreation("client-a");
    admission.admitCreation("client-a");
    expect(() => admission.admitCreation("client-a")).toThrow(AppError);

    for (let index = 0; index < 6; index += 1) {
      admission.admitPoll("client-a");
    }
    expect(() => admission.admitPoll("client-a")).toThrow(AppError);
  });
});
