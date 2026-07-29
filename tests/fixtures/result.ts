import type {
  AnalysisResult,
  MetricValue,
} from "../../src/server/schemas/result";
import { LIMITS } from "../../src/server/schemas/limits";

const metric = (numerator: number, denominator: number): MetricValue => ({
  numerator,
  denominator,
  percent: denominator ? (numerator / denominator) * 100 : null,
  available: true,
  unavailableReasons: [],
});

export const fixtureJobId = "11111111-1111-4111-8111-111111111111";

export const fixtureResult: AnalysisResult = {
  schemaVersion: "1",
  algorithmVersion: "line-v1-path-v2",
  selectionVersion: "github-search-v1",
  id: fixtureJobId,
  canonicalLogin: "pinion05",
  analyzedAt: "2026-07-29T00:00:00.000Z",
  authoritativeWindow: {
    start: "2024-07-29T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
  },
  discovery: {
    windowStart: "2024-07-29T00:00:00.000Z",
    windowEnd: "2026-07-29T00:00:00.000Z",
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
  },
  summary: {
    scope: {
      kind: "SELECTED_ANALYZED_PULL_REQUESTS",
      complete: true,
      discoveryComplete: true,
      queryTotalCount: 2,
      selectedPullRequests: 2,
      analyzedPullRequests: 2,
      excludedPullRequests: 0,
      reasons: [],
    },
    eligibleAdditions: 100,
    analyzedPullRequests: 2,
    excludedPullRequests: 0,
    originalPath: metric(78, 100),
    repositoryText: metric(91, 100),
    blameEvaluated: metric(78, 100),
    lineage: metric(71, 100),
  },
  repositories: [
    {
      id: 1,
      nameWithOwner: "open/source",
      url: "https://github.com/open/source",
      authoritativeOid: "a".repeat(40),
      pullRequestCount: 2,
      coverage: [],
    },
  ],
  pullRequests: [
    {
      repositoryId: 1,
      repository: "open/source",
      number: 42,
      title: "Keep useful code alive",
      url: "https://github.com/open/source/pull/42",
      mergedAt: "2025-12-01T00:00:00.000Z",
      eligibleAdditions: 100,
      originalPath: metric(78, 100),
      repositoryText: metric(91, 100),
      blameEvaluated: metric(78, 100),
      lineage: metric(71, 100),
      excluded: false,
      exclusions: [],
    },
  ],
  exclusions: [],
  limits: LIMITS,
  reachedLimits: [],
  caveats: [
    "저장소 전체 텍스트 생존은 출처나 저작권을 증명하지 않습니다.",
    "불완전한 증거는 0점으로 대체하지 않습니다.",
  ],
  shareExpiresAt: "2026-07-29T00:30:00.000Z",
};
