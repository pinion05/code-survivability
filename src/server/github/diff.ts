import { LIMITS } from "../schemas/limits";
import { parseAndValidateDiff, type ParsedDiff } from "../analysis/diff-parser";
import type { GitHubClient } from "./client";
import type { Candidate } from "./pull-requests";

export async function fetchValidatedDiff(
  client: GitHubClient,
  candidate: Candidate,
  signal?: AbortSignal,
): Promise<ParsedDiff> {
  const diff = await client.text({
    path: `/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.repo)}/pulls/${candidate.number}`,
    accept: "application/vnd.github.v3.diff",
    maxBytes: LIMITS.diffBytes,
    timeoutMs: LIMITS.diffMs,
    ...(signal ? { signal } : {}),
  });
  return parseAndValidateDiff(diff, {
    additions: candidate.additions,
    changedFiles: candidate.changedFiles,
  });
}
