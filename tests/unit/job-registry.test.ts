import { describe, expect, test } from "bun:test";
import { JobRegistry, type Runner } from "../../src/server/jobs/registry";
import type { AnalysisResult } from "../../src/server/schemas/result";
import { AppError } from "../../src/server/errors";
import { LIMITS } from "../../src/server/schemas/limits";

type Resolver = (result: AnalysisResult) => void;

function fixtureResult(id: string, login: string): AnalysisResult {
  return {
    id,
    canonicalLogin: login,
    schemaVersion: "1",
  } as AnalysisResult;
}

function deferredRunner() {
  const resolvers = new Map<string, Resolver>();
  const runner: Runner = (id) =>
    new Promise<AnalysisResult>((resolve) => {
      resolvers.set(id, resolve);
    });
  return { runner, resolvers };
}

async function settle(): Promise<void> {
  await Bun.sleep(5);
}

describe("one-running one-waiting registry", () => {
  test("rejects a third reservation and promotes the waiting job", async () => {
    const { runner, resolvers } = deferredRunner();
    const registry = new JobRegistry(runner);

    const first = registry.finalizeReservation(
      registry.reserve("client-a"),
      "Pinion05",
      "pinion05",
    );
    const second = registry.finalizeReservation(
      registry.reserve("client-b"),
      "another-user",
      "another-user",
    );

    expect(first.job.state).toBe("RUNNING");
    expect(second.job.state).toBe("QUEUED");
    expect(() => registry.reserve("client-c")).toThrow(AppError);

    resolvers.get(first.job.id)?.(fixtureResult(first.job.id, "pinion05"));
    await settle();
    expect(registry.getJob(first.job.id)?.state).toBe("SUCCEEDED");
    expect(registry.getJob(second.job.id)?.state).toBe("RUNNING");

    resolvers.get(second.job.id)?.(
      fixtureResult(second.job.id, "another-user"),
    );
    await settle();
    expect(registry.getJob(second.job.id)?.state).toBe("SUCCEEDED");
  });

  test("deduplicates a known case-folded alias without occupying another slot", async () => {
    const { runner, resolvers } = deferredRunner();
    const registry = new JobRegistry(runner);
    const created = registry.finalizeReservation(
      registry.reserve("client-a"),
      "Pinion05",
      "pinion05",
    );

    const known = registry.lookupKnownAlias("PINION05");
    expect(known?.job.id).toBe(created.job.id);
    expect(known?.deduplicated).toBe(true);

    const reservedDuplicate = registry.finalizeReservation(
      registry.reserve("client-b"),
      "pinion05",
      "pinion05",
    );
    expect(reservedDuplicate.job.id).toBe(created.job.id);
    expect(reservedDuplicate.deduplicated).toBe(true);

    resolvers.get(created.job.id)?.(fixtureResult(created.job.id, "pinion05"));
    await settle();
    expect(registry.getResult(created.job.id)?.canonicalLogin).toBe("pinion05");
  });

  test("enforces one active analysis per client", async () => {
    const { runner, resolvers } = deferredRunner();
    const registry = new JobRegistry(runner);
    const first = registry.finalizeReservation(
      registry.reserve("same-client"),
      "pinion05",
      "pinion05",
    );

    expect(() => registry.reserve("same-client")).toThrow(
      "클라이언트별 동시 분석 한도",
    );
    resolvers.get(first.job.id)?.(fixtureResult(first.job.id, "pinion05"));
    await settle();
  });

  test("counts unresolved reservations toward the per-client limit", () => {
    const { runner } = deferredRunner();
    const registry = new JobRegistry(runner);
    const reservation = registry.reserve("same-client");

    expect(() => registry.reserve("same-client")).toThrow(
      "클라이언트별 동시 분석 한도",
    );

    registry.releaseReservation(reservation);
    expect(typeof registry.reserve("same-client")).toBe("string");
  });

  test("caps alias storage and expires stale aliases", async () => {
    let now = 0;
    const { runner, resolvers } = deferredRunner();
    const registry = new JobRegistry(
      runner,
      () => 1,
      () => now,
    );
    const created = registry.finalizeReservation(
      registry.reserve("client-owner"),
      "alias-0",
      "pinion05",
    );

    for (let index = 1; index < LIMITS.aliasEntries + 50; index += 1) {
      const duplicate = registry.finalizeReservation(
        registry.reserve(`client-${index}`),
        `alias-${index}`,
        "pinion05",
      );
      expect(duplicate.job.id).toBe(created.job.id);
    }

    expect(registry.lookupKnownAlias("alias-0")).toBeNull();
    expect(
      registry.lookupKnownAlias(`alias-${LIMITS.aliasEntries + 49}`)?.job.id,
    ).toBe(created.job.id);

    now = LIMITS.aliasTtlMs + 1;
    expect(
      registry.lookupKnownAlias(`alias-${LIMITS.aliasEntries + 49}`),
    ).toBeNull();

    resolvers.get(created.job.id)?.(fixtureResult(created.job.id, "pinion05"));
    await settle();
  });
  test("aborts the active runner and marks it cancelled during shutdown", async () => {
    let aborted = false;
    const runner: Runner = (_id, _login, signal) =>
      new Promise<AnalysisResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new AppError("SHUTTING_DOWN", "cancelled"));
          },
          { once: true },
        );
      });
    const registry = new JobRegistry(runner);
    const created = registry.finalizeReservation(
      registry.reserve("client-a"),
      "pinion05",
      "pinion05",
    );

    await registry.shutdown();

    expect(aborted).toBe(true);
    expect(registry.getJob(created.job.id)?.state).toBe("CANCELLED_SHUTDOWN");
    expect(registry.isShuttingDown()).toBe(true);
  });
});
