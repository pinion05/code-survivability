import { describe, expect, test } from "bun:test";
import { summarize } from "../../src/server/analysis/pipeline";
import type {
  DiscoveryCoverage,
  MetricValue,
  PullRequestResult,
} from "../../src/server/schemas/result";

const metric = (
  numerator: number,
  denominator: number,
  available = true,
  unavailableReasons: string[] = [],
): MetricValue => ({
  numerator,
  denominator,
  percent: available && denominator ? (numerator / denominator) * 100 : null,
  available,
  unavailableReasons,
});

function pull(number: number, lineage: MetricValue): PullRequestResult {
  return {
    repositoryId: 1,
    repository: "open/source",
    number,
    title: `PR ${number}`,
    url: `https://github.com/open/source/pull/${number}`,
    mergedAt: "2026-01-01T00:00:00Z",
    eligibleAdditions: 10,
    originalPath: metric(8, 10),
    repositoryText: metric(9, 10),
    blameEvaluated: lineage.available
      ? metric(8, 10)
      : metric(0, 10, false, lineage.unavailableReasons),
    lineage,
    excluded: false,
    exclusions: [],
  };
}
function discovery(
  overrides: Partial<DiscoveryCoverage> = {},
): DiscoveryCoverage {
  return {
    windowStart: "2024-01-01T00:00:00Z",
    windowEnd: "2026-01-01T00:00:00Z",
    queryTotalCount: 2,
    returnedCount: 2,
    hydratedCount: 2,
    selectedCount: 2,
    maxCandidates: 30,
    pagesFetched: 1,
    incompleteResults: false,
    capped: false,
    complete: true,
    reasons: [],
    ...overrides,
  };
}

describe("headline metric completeness", () => {
  test("does not publish a partial aggregate when one included PR is unavailable", () => {
    const summary = summarize(
      [
        pull(1, metric(8, 10)),
        pull(2, metric(0, 10, false, ["BLAME_UNAVAILABLE:src/a.ts"])),
      ],
      discovery(),
    );

    expect(summary.originalPath).toMatchObject({
      available: true,
      numerator: 16,
      denominator: 20,
    });
    expect(summary.lineage.available).toBe(false);
    expect(summary.lineage.percent).toBeNull();
    expect(summary.lineage.denominator).toBe(20);
    expect(summary.lineage.unavailableReasons).toContain(
      "PARTIAL_EVIDENCE_NOT_AGGREGATED",
    );
  });

  test("marks an empty analysis unavailable instead of returning available 0/0", () => {
    const summary = summarize([], discovery({ selectedCount: 0 }));
    expect(summary.originalPath.available).toBe(false);
    expect(summary.originalPath.unavailableReasons).toContain(
      "NO_ANALYZABLE_PULL_REQUESTS",
    );
  });

  test("labels a capped search as an explicit selected sample", () => {
    const summary = summarize(
      [pull(1, metric(8, 10)), pull(2, metric(8, 10))],
      discovery({
        queryTotalCount: 49,
        capped: true,
        complete: false,
        reasons: [{ code: "SEARCH_CAP", message: "capped" }],
      }),
    );

    expect(summary.originalPath.available).toBe(true);
    expect(summary.scope).toMatchObject({
      kind: "SELECTED_ANALYZED_PULL_REQUESTS",
      complete: false,
      queryTotalCount: 49,
      selectedPullRequests: 2,
      analyzedPullRequests: 2,
      reasons: ["SEARCH_CAP"],
    });
  });

  test("blocks the headline when discovery evidence or a selected PR is missing", () => {
    const excluded = { ...pull(2, metric(8, 10)), excluded: true };
    const summary = summarize(
      [pull(1, metric(8, 10)), excluded],
      discovery({
        complete: false,
        reasons: [{ code: "HYDRATION_FAILED", message: "missing" }],
      }),
    );

    expect(summary.originalPath.available).toBe(false);
    expect(summary.originalPath.unavailableReasons).toContain(
      "HYDRATION_FAILED",
    );
    expect(summary.originalPath.unavailableReasons).toContain(
      "SELECTED_PULL_REQUESTS_EXCLUDED",
    );
  });
});
