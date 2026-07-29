import { describe, expect, test } from "bun:test";
import {
  assertMetricInvariants,
  evaluateMetrics,
  type CompleteBlame,
  type CurrentPath,
} from "../../src/server/analysis/metrics";
import { AppError } from "../../src/server/errors";

const oid = "a".repeat(40);
const own = "b".repeat(40);

function current(path: string, lines: string[]): CurrentPath {
  return {
    path,
    occurrences: lines.map((line, index) => ({ line, lineNumber: index + 1 })),
  };
}

function blame(path: string, oids: string[]): CompleteBlame {
  return {
    oid,
    path,
    ranges: oids.map((commitOid, index) => ({
      startLine: index + 1,
      endLine: index + 1,
      oid: commitOid,
    })),
  };
}

describe("path-aware survival metrics", () => {
  test("does not transfer an identical line between destination paths", () => {
    const result = evaluateMetrics({
      additions: [{ path: "src/a.ts", line: "const kept = 1;" }],
      currentPaths: new Map([
        ["src/a.ts", current("src/a.ts", [])],
        ["src/b.ts", current("src/b.ts", ["const kept = 1;"])],
      ]),
      repositoryCounts: new Map([["const kept = 1;", 1]]),
      blameByPath: new Map(),
      authoritativeOid: oid,
      lineageOids: new Set([own]),
    });

    expect(result.originalPath.numerator).toBe(0);
    expect(result.repositoryText.numerator).toBe(1);
    expect(result.lineage.numerator).toBe(0);
  });

  test("selects duplicate physical occurrences by ascending line number before blame", () => {
    const line = "return durable;";
    const result = evaluateMetrics({
      additions: [
        { path: "src/a.ts", line },
        { path: "src/a.ts", line },
      ],
      currentPaths: new Map([
        ["src/a.ts", current("src/a.ts", [line, line, line])],
      ]),
      repositoryCounts: new Map([[line, 3]]),
      blameByPath: new Map([
        ["src/a.ts", blame("src/a.ts", [own, "c".repeat(40), own])],
      ]),
      authoritativeOid: oid,
      lineageOids: new Set([own]),
    });

    expect(result.originalPath.numerator).toBe(2);
    expect(result.blameEvaluated.numerator).toBe(2);
    expect(result.lineage.numerator).toBe(1);
    expect(result.repositoryText.numerator).toBe(2);
  });

  test("marks lineage unavailable instead of returning a partial score", () => {
    const line = "const evidence = true;";
    const result = evaluateMetrics({
      additions: [{ path: "src/a.ts", line }],
      currentPaths: new Map([["src/a.ts", current("src/a.ts", [line])]]),
      repositoryCounts: new Map([[line, 1]]),
      blameByPath: new Map([
        ["src/a.ts", { oid, path: "src/a.ts", ranges: [] }],
      ]),
      authoritativeOid: oid,
      lineageOids: new Set([own]),
    });

    expect(result.originalPath.available).toBe(true);
    expect(result.lineage.available).toBe(false);
    expect(result.lineage.percent).toBeNull();
    expect(result.lineage.unavailableReasons[0]).toContain("BLAME_INCOMPLETE");
  });

  test("rejects impossible aggregate values", () => {
    expect(() =>
      assertMetricInvariants({
        eligible: 1,
        originalPath: metric(1, 1),
        repositoryText: metric(1, 1),
        blameEvaluated: metric(1, 1),
        lineage: metric(2, 1),
      }),
    ).toThrow(AppError);
  });
});

function metric(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    percent: denominator > 0 ? (numerator / denominator) * 100 : null,
    available: true,
    unavailableReasons: [],
  };
}
