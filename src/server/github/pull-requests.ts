import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";
import type { DiscoveryCoverage } from "../schemas/result";
import type { GitHubClient } from "./client";

export type Candidate = {
  repositoryId: number;
  repository: string;
  owner: string;
  repo: string;
  repositoryUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  mergeCommitSha: string;
  additions: number;
  changedFiles: number;
  commitShas: string[];
};

type SearchItem = { pull_request?: { url?: string } };
type SearchResponse = {
  total_count?: number;
  incomplete_results?: boolean;
  items?: SearchItem[];
};

function subtractCalendarMonths(date: Date, months: number): Date {
  const output = new Date(date);
  const day = output.getUTCDate();
  output.setUTCDate(1);
  output.setUTCMonth(output.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(output.getUTCFullYear(), output.getUTCMonth() + 1, 0),
  ).getUTCDate();
  output.setUTCDate(Math.min(day, lastDay));
  return output;
}

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

export async function discoverCandidates(
  client: GitHubClient,
  canonicalLogin: string,
  snapshot = new Date(),
): Promise<{ candidates: Candidate[]; coverage: DiscoveryCoverage }> {
  const windowStart = subtractCalendarMonths(snapshot, 24);
  const query = `type:pr author:${canonicalLogin} -user:${canonicalLogin} is:merged merged:${dateOnly(windowStart)}..${dateOnly(snapshot)} is:public`;
  const search = await client.json<SearchResponse>({
    path: `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${LIMITS.maxCandidates}&page=1`,
    maxBytes: LIMITS.searchBytes,
    timeoutMs: LIMITS.searchMs,
  });
  if (!Array.isArray(search.items)) {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      "GitHub 검색 응답이 올바르지 않습니다",
    );
  }

  const reasons: DiscoveryCoverage["reasons"] = [];
  const hydrated: Candidate[] = [];
  for (const item of search.items.slice(0, LIMITS.maxCandidates)) {
    const url = item.pull_request?.url;
    if (!url?.startsWith("https://api.github.com/repos/")) {
      reasons.push({
        code: "HYDRATION_MISSING",
        message: "PR 식별자를 확인할 수 없습니다",
      });
      continue;
    }
    try {
      const path = new URL(url).pathname.replace(/^\/?/, "/");
      hydrated.push(await hydrateCandidate(client, path));
    } catch (error) {
      if (error instanceof AppError && error.code === "RATE_LIMITED")
        throw error;
      reasons.push({
        code: "HYDRATION_FAILED",
        message: "공개 PR 메타데이터를 확인하지 못했습니다",
      });
    }
  }

  hydrated.sort(
    (a, b) =>
      b.mergedAt.localeCompare(a.mergedAt) ||
      a.repositoryId - b.repositoryId ||
      a.number - b.number,
  );
  const candidates = hydrated.slice(0, LIMITS.maxCandidates);
  const total =
    typeof search.total_count === "number" ? search.total_count : null;
  const incomplete =
    typeof search.incomplete_results === "boolean"
      ? search.incomplete_results
      : null;
  const capped = total !== null && total > LIMITS.maxCandidates;
  if (capped)
    reasons.push({
      code: "SEARCH_CAP",
      message: "검색 결과가 30개를 초과했습니다",
    });
  if (incomplete)
    reasons.push({
      code: "SEARCH_INCOMPLETE",
      message: "GitHub가 불완전한 검색 결과를 반환했습니다",
    });

  return {
    candidates,
    coverage: {
      windowStart: windowStart.toISOString(),
      windowEnd: snapshot.toISOString(),
      queryTotalCount: total,
      returnedCount: search.items.length,
      hydratedCount: hydrated.length,
      selectedCount: candidates.length,
      maxCandidates: 30,
      pagesFetched: 1,
      incompleteResults: incomplete,
      capped,
      complete: !capped && !incomplete && reasons.length === 0,
      reasons,
    },
  };
}

async function hydrateCandidate(
  client: GitHubClient,
  path: string,
): Promise<Candidate> {
  const pr = await client.json<any>({ path, maxBytes: 1024 * 1024 });
  if (
    typeof pr.number !== "number" ||
    typeof pr.title !== "string" ||
    typeof pr.html_url !== "string" ||
    typeof pr.merged_at !== "string" ||
    typeof pr.merge_commit_sha !== "string" ||
    typeof pr.additions !== "number" ||
    typeof pr.changed_files !== "number" ||
    typeof pr.base?.repo?.id !== "number" ||
    typeof pr.base.repo.full_name !== "string" ||
    typeof pr.base.repo.html_url !== "string" ||
    typeof pr.base.repo.clone_url !== "string" ||
    typeof pr.base.repo.default_branch !== "string" ||
    pr.base.repo.private !== false
  ) {
    throw new AppError("GITHUB_UNAVAILABLE", "PR 메타데이터가 불완전합니다");
  }
  const [owner, repo] = pr.base.repo.full_name.split("/");
  if (!owner || !repo)
    throw new AppError("GITHUB_UNAVAILABLE", "저장소 이름이 올바르지 않습니다");

  const commitData = await client.json<Array<{ sha?: unknown }>>({
    path: `${path}/commits?per_page=${LIMITS.commitShasPerPr}`,
    maxBytes: 2 * 1024 * 1024,
  });
  if (
    !Array.isArray(commitData) ||
    commitData.length > LIMITS.commitShasPerPr
  ) {
    throw new AppError("GITHUB_RESPONSE_LIMIT", "PR 커밋 한도를 초과했습니다");
  }
  const commitShas = commitData
    .map((item) => item.sha)
    .filter((sha): sha is string => typeof sha === "string");
  return {
    repositoryId: pr.base.repo.id,
    repository: pr.base.repo.full_name,
    owner,
    repo,
    repositoryUrl: pr.base.repo.html_url,
    cloneUrl: pr.base.repo.clone_url,
    defaultBranch: pr.base.repo.default_branch,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    mergedAt: pr.merged_at,
    mergeCommitSha: pr.merge_commit_sha,
    additions: pr.additions,
    changedFiles: pr.changed_files,
    commitShas,
  };
}
