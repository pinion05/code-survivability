import type { EffectiveLimits } from "./limits";

export type CoverageReason = {
  code: string;
  message: string;
  repositoryId?: number;
  pullRequest?: number;
  path?: string;
};

export type DiscoveryCoverage = {
  windowStart: string;
  windowEnd: string;
  queryTotalCount: number | null;
  returnedCount: number;
  hydratedCount: number;
  selectedCount: number;
  maxCandidates: 30;
  pagesFetched: number;
  incompleteResults: boolean | null;
  capped: boolean;
  complete: boolean;
  reasons: CoverageReason[];
};

export type MetricValue = {
  numerator: number;
  denominator: number;
  percent: number | null;
  available: boolean;
  unavailableReasons: string[];
};

export type PullRequestResult = {
  repositoryId: number;
  repository: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  eligibleAdditions: number;
  originalPath: MetricValue;
  repositoryText: MetricValue;
  blameEvaluated: MetricValue;
  lineage: MetricValue;
  excluded: boolean;
  exclusions: CoverageReason[];
};

export type RepositoryResult = {
  id: number;
  nameWithOwner: string;
  url: string;
  authoritativeOid: string | null;
  pullRequestCount: number;
  coverage: CoverageReason[];
};

export type SummaryScope = {
  kind: "SELECTED_ANALYZED_PULL_REQUESTS";
  complete: boolean;
  discoveryComplete: boolean;
  queryTotalCount: number | null;
  selectedPullRequests: number;
  analyzedPullRequests: number;
  excludedPullRequests: number;
  reasons: string[];
};

export type MetricSummary = {
  scope: SummaryScope;
  eligibleAdditions: number;
  analyzedPullRequests: number;
  excludedPullRequests: number;
  originalPath: MetricValue;
  repositoryText: MetricValue;
  blameEvaluated: MetricValue;
  lineage: MetricValue;
};

export type AnalysisResult = {
  schemaVersion: "1";
  algorithmVersion: string;
  selectionVersion: string;
  id: string;
  canonicalLogin: string;
  analyzedAt: string;
  authoritativeWindow: { start: string; end: string };
  discovery: DiscoveryCoverage;
  summary: MetricSummary;
  repositories: RepositoryResult[];
  pullRequests: PullRequestResult[];
  exclusions: CoverageReason[];
  limits: EffectiveLimits;
  reachedLimits: CoverageReason[];
  caveats: string[];
  shareExpiresAt: string;
};
