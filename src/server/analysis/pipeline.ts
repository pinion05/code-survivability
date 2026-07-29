import { AppError } from "../errors";
import { getConfig } from "../config";
import { fetchCompleteBlame } from "../github/blame";
import { GitHubClient } from "../github/client";
import { fetchValidatedDiff } from "../github/diff";
import { discoverCandidates, type Candidate } from "../github/pull-requests";
import { GitSnapshotScanner, type SnapshotResult } from "../git/scanner";
import {
  ALGORITHM_VERSION,
  LIMITS,
  SELECTION_VERSION,
} from "../schemas/limits";
import type {
  AnalysisResult,
  CoverageReason,
  MetricSummary,
  MetricValue,
  PullRequestResult,
  RepositoryResult,
} from "../schemas/result";
import type { ParsedDiff } from "./diff-parser";
import { createMetric, evaluateMetrics } from "./metrics";

export type ProgressUpdate = {
  phase: string;
  completedUnits: number;
  totalUnits: number;
  coverageWarnings: number;
};

export type PipelineInput = {
  id: string;
  canonicalLogin: string;
  signal?: AbortSignal;
  now?: Date;
  onProgress?: (progress: ProgressUpdate) => void;
};

type ValidCandidate = { candidate: Candidate; diff: ParsedDiff };

export async function runAnalysis(
  input: PipelineInput,
): Promise<AnalysisResult> {
  const config = getConfig();
  const client = new GitHubClient(config.GITHUB_TOKEN);
  const scanner = new GitSnapshotScanner(
    config.WORKSPACE_ROOT,
    config.WORKSPACE_THRESHOLD_BYTES,
  );
  const now = input.now ?? new Date();
  const { candidates, coverage: discovery } = await discoverCandidates(
    client,
    input.canonicalLogin,
    now,
  );
  input.onProgress?.({
    phase: "DIFFS",
    completedUnits: 0,
    totalUnits: Math.max(candidates.length * 2, 1),
    coverageWarnings: discovery.reasons.length,
  });

  const exclusions: CoverageReason[] = [...discovery.reasons];
  const valid: ValidCandidate[] = [];
  let eligibleTotal = 0;
  for (const candidate of candidates) {
    try {
      const diff = await fetchValidatedDiff(client, candidate);
      if (
        eligibleTotal + diff.eligibleAdditions.length >
        LIMITS.maxEligibleAdditions
      ) {
        exclusions.push(
          reason(
            "ANALYSIS_ADDITION_LIMIT",
            "분석 적격 줄 한도로 PR을 제외했습니다",
            candidate,
          ),
        );
      } else {
        eligibleTotal += diff.eligibleAdditions.length;
        valid.push({ candidate, diff });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "WORKSPACE_LIMIT")
        throw error;
      exclusions.push(reason("DIFF_EXCLUDED", publicReason(error), candidate));
    }
    input.onProgress?.({
      phase: "DIFFS",
      completedUnits: valid.length,
      totalUnits: Math.max(candidates.length * 2, 1),
      coverageWarnings: exclusions.length,
    });
  }

  const acceptedRepositoryIds = new Set<number>();
  const repositoryGroups = new Map<number, ValidCandidate[]>();
  for (const item of valid) {
    if (!acceptedRepositoryIds.has(item.candidate.repositoryId)) {
      if (acceptedRepositoryIds.size >= LIMITS.maxRepositories) {
        exclusions.push(
          reason(
            "REPOSITORY_LIMIT",
            "저장소 수 한도로 PR을 제외했습니다",
            item.candidate,
          ),
        );
        continue;
      }
      acceptedRepositoryIds.add(item.candidate.repositoryId);
    }
    const group = repositoryGroups.get(item.candidate.repositoryId) ?? [];
    group.push(item);
    repositoryGroups.set(item.candidate.repositoryId, group);
  }

  const pullRequests: PullRequestResult[] = [];
  const repositories: RepositoryResult[] = [];
  let completed = candidates.length;
  for (const group of repositoryGroups.values()) {
    const first = group[0]!;
    const requestedPaths = new Set(
      group.flatMap((item) =>
        item.diff.eligibleAdditions.map((line) => line.path),
      ),
    );
    let snapshot: SnapshotResult | null = null;
    const repositoryCoverage: CoverageReason[] = [];
    try {
      snapshot = await scanner.scan({
        owner: first.candidate.owner,
        repo: first.candidate.repo,
        defaultBranch: first.candidate.defaultBranch,
        requestedPaths,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for (const code of snapshot.coverageReasons) {
        repositoryCoverage.push({
          code,
          message: "저장소 전체 검사가 완전하지 않습니다",
        });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "WORKSPACE_LIMIT")
        throw error;
      repositoryCoverage.push({
        code: "REPOSITORY_SCAN_UNAVAILABLE",
        message: publicReason(error),
      });
    }

    repositories.push({
      id: first.candidate.repositoryId,
      nameWithOwner: first.candidate.repository,
      url: first.candidate.repositoryUrl,
      authoritativeOid: snapshot?.authoritativeOid ?? null,
      pullRequestCount: group.length,
      coverage: repositoryCoverage,
    });

    for (const item of group) {
      const blameByPath = new Map();
      const paths = new Set(
        item.diff.eligibleAdditions.map((addition) => addition.path),
      );
      if (
        snapshot &&
        config.BLAME_ENABLED &&
        paths.size <= LIMITS.blamePathsPerPr
      ) {
        for (const path of paths) {
          if (snapshot.unavailableOriginalPaths.has(path)) {
            blameByPath.set(path, null);
            continue;
          }
          try {
            blameByPath.set(
              path,
              await fetchCompleteBlame(client, {
                owner: item.candidate.owner,
                repo: item.candidate.repo,
                oid: snapshot.authoritativeOid,
                path,
              }),
            );
          } catch {
            blameByPath.set(path, null);
          }
        }
      } else {
        for (const path of paths) blameByPath.set(path, null);
      }
      const originalUnavailable =
        !snapshot ||
        [...paths].some((path) => snapshot?.unavailableOriginalPaths.has(path));
      const metrics = evaluateMetrics({
        additions: item.diff.eligibleAdditions,
        currentPaths: originalUnavailable ? null : snapshot!.currentPaths,
        repositoryCounts: snapshot?.repositoryCounts ?? null,
        blameByPath,
        authoritativeOid: snapshot?.authoritativeOid ?? "",
        lineageOids: new Set([
          item.candidate.mergeCommitSha,
          ...item.candidate.commitShas,
        ]),
      });
      pullRequests.push({
        repositoryId: item.candidate.repositoryId,
        repository: item.candidate.repository,
        number: item.candidate.number,
        title: item.candidate.title,
        url: item.candidate.url,
        mergedAt: item.candidate.mergedAt,
        eligibleAdditions: metrics.eligible,
        originalPath: metrics.originalPath,
        repositoryText: metrics.repositoryText,
        blameEvaluated: metrics.blameEvaluated,
        lineage: metrics.lineage,
        excluded: false,
        exclusions: repositoryCoverage,
      });
      completed += 1;
      input.onProgress?.({
        phase: "SCANNING_REPOSITORIES",
        completedUnits: completed,
        totalUnits: Math.max(candidates.length * 2, 1),
        coverageWarnings: exclusions.length + repositoryCoverage.length,
      });
    }
  }

  const includedKeys = new Set(
    pullRequests.map((pr) => `${pr.repositoryId}:${pr.number}`),
  );
  for (const candidate of candidates) {
    if (includedKeys.has(`${candidate.repositoryId}:${candidate.number}`))
      continue;
    const candidateReasons = exclusions.filter(
      (entry) =>
        entry.repositoryId === candidate.repositoryId &&
        entry.pullRequest === candidate.number,
    );
    pullRequests.push(excludedPullRequest(candidate, candidateReasons));
  }
  pullRequests.sort(
    (a, b) =>
      b.mergedAt.localeCompare(a.mergedAt) ||
      a.repositoryId - b.repositoryId ||
      a.number - b.number,
  );

  const result: AnalysisResult = {
    schemaVersion: "1",
    algorithmVersion: ALGORITHM_VERSION,
    selectionVersion: SELECTION_VERSION,
    id: input.id,
    canonicalLogin: input.canonicalLogin,
    analyzedAt: now.toISOString(),
    authoritativeWindow: {
      start: discovery.windowStart,
      end: discovery.windowEnd,
    },
    discovery,
    summary: summarize(pullRequests),
    repositories,
    pullRequests,
    exclusions,
    limits: LIMITS,
    reachedLimits: exclusions.filter(
      (entry) => entry.code.includes("LIMIT") || entry.code.includes("CAP"),
    ),
    caveats: [
      "저장소 전체 텍스트 생존은 출처나 저작권을 증명하지 않습니다.",
      "정규화된 줄의 정확한 중복 발생 횟수만 비교하며 의미적 동등성은 판단하지 않습니다.",
      "결과 링크는 메모리 캐시의 TTL, 재시작, 배포 또는 제거 시 사라집니다.",
      "불완전한 트리·blob·blame 증거는 0점이나 부분 점수로 대체하지 않습니다.",
    ],
    shareExpiresAt: new Date(Date.now() + LIMITS.resultTtlMs).toISOString(),
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(result));
  if (serializedBytes > LIMITS.resultBytes) {
    throw new AppError(
      "RESULT_TOO_LARGE",
      "분석 결과 크기 한도를 초과했습니다",
    );
  }
  return result;
}

function reason(
  code: string,
  message: string,
  candidate: Candidate,
): CoverageReason {
  return {
    code,
    message,
    repositoryId: candidate.repositoryId,
    pullRequest: candidate.number,
  };
}

function publicReason(error: unknown): string {
  return error instanceof AppError
    ? error.publicMessage
    : "분석 증거를 완전하게 확인하지 못했습니다";
}

function excludedPullRequest(
  candidate: Candidate,
  reasons: CoverageReason[],
): PullRequestResult {
  const unavailable = createMetric(
    0,
    0,
    false,
    reasons.map((entry) => entry.code),
  );
  return {
    repositoryId: candidate.repositoryId,
    repository: candidate.repository,
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    mergedAt: candidate.mergedAt,
    eligibleAdditions: 0,
    originalPath: unavailable,
    repositoryText: unavailable,
    blameEvaluated: unavailable,
    lineage: unavailable,
    excluded: true,
    exclusions: reasons,
  };
}

function summarize(pullRequests: PullRequestResult[]): MetricSummary {
  const included = pullRequests.filter((pr) => !pr.excluded);
  const aggregate = (
    select: (pr: PullRequestResult) => MetricValue,
  ): MetricValue => {
    const available = included.map(select).filter((value) => value.available);
    const numerator = available.reduce(
      (sum, value) => sum + value.numerator,
      0,
    );
    const denominator = available.reduce(
      (sum, value) => sum + value.denominator,
      0,
    );
    return createMetric(numerator, denominator, true, []);
  };
  return {
    eligibleAdditions: included.reduce(
      (sum, pr) => sum + pr.eligibleAdditions,
      0,
    ),
    analyzedPullRequests: included.length,
    excludedPullRequests: pullRequests.length - included.length,
    originalPath: aggregate((pr) => pr.originalPath),
    repositoryText: aggregate((pr) => pr.repositoryText),
    blameEvaluated: aggregate((pr) => pr.blameEvaluated),
    lineage: aggregate((pr) => pr.lineage),
  };
}
