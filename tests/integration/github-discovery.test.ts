import { describe, expect, test } from "bun:test";
import { discoverCandidates } from "../../src/server/github/pull-requests";
import type {
  GitHubClient,
  GitHubRequest,
} from "../../src/server/github/client";

class FakeGitHubClient {
  requests: GitHubRequest[] = [];

  async json<T>(request: GitHubRequest): Promise<T> {
    this.requests.push(request);
    const path = request.path ?? "";
    if (path.startsWith("/search/issues")) {
      return {
        total_count: 31,
        incomplete_results: false,
        items: [
          {
            pull_request: {
              url: "https://api.github.com/repos/acme/tool/pulls/1",
            },
          },
          {
            pull_request: {
              url: "https://api.github.com/repos/acme/tool/pulls/2",
            },
          },
        ],
      } as T;
    }
    if (path.endsWith("/commits?per_page=100&page=1")) {
      return [
        { sha: path.includes("pulls/1") ? "1".repeat(40) : "2".repeat(40) },
      ] as T;
    }
    if (path.endsWith("/pulls/1")) return pull(1, "2026-01-01T00:00:00Z") as T;
    if (path.endsWith("/pulls/2")) return pull(2, "2026-02-01T00:00:00Z") as T;
    throw new Error(`Unexpected request: ${path}`);
  }
}

function pull(number: number, mergedAt: string) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/tool/pull/${number}`,
    merged_at: mergedAt,
    merge_commit_sha: String(number).repeat(40),
    additions: 2,
    changed_files: 1,
    commits: 1,
    base: {
      repo: {
        id: 10,
        full_name: "acme/tool",
        html_url: "https://github.com/acme/tool",
        clone_url: "https://github.com/acme/tool.git",
        default_branch: "main",
        private: false,
      },
    },
  };
}

describe("bounded external PR discovery", () => {
  test("excludes self-owned repositories, sorts hydrated candidates, and reports caps", async () => {
    const fake = new FakeGitHubClient();
    const { candidates, coverage } = await discoverCandidates(
      fake as unknown as GitHubClient,
      "pinion05",
      new Date("2026-07-29T00:00:00Z"),
    );

    const searchPath = fake.requests[0]?.path ?? "";
    const decoded = decodeURIComponent(searchPath);
    expect(decoded).toContain("author:pinion05");
    expect(decoded).toContain("-user:pinion05");
    expect(candidates.map((candidate) => candidate.number)).toEqual([2, 1]);
    expect(coverage.capped).toBe(true);
    expect(coverage.complete).toBe(false);
    expect(coverage.reasons.map((reason) => reason.code)).toContain(
      "SEARCH_CAP",
    );
    expect(coverage.pagesFetched).toBe(1);
  });

  test("excludes a PR from metadata before GitHub's 250-commit endpoint truncation", async () => {
    const requests: string[] = [];
    const fake = {
      async json<T>(request: GitHubRequest): Promise<T> {
        const path = request.path ?? "";
        requests.push(path);
        if (path.startsWith("/search/issues")) {
          return {
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                pull_request: {
                  url: "https://api.github.com/repos/acme/tool/pulls/1",
                },
              },
            ],
          } as T;
        }
        if (path.endsWith("/pulls/1"))
          return {
            ...pull(1, "2026-01-01T00:00:00Z"),
            commits: 251,
          } as T;
        if (path.includes("/commits?per_page=100&page=")) {
          return Array.from(
            { length: path.endsWith("page=3") ? 50 : 100 },
            (_, index) => ({
              sha: `${index}`.padStart(40, "a"),
            }),
          ) as T;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    };

    const { candidates, coverage } = await discoverCandidates(
      fake as unknown as GitHubClient,
      "pinion05",
      new Date("2026-07-29T00:00:00Z"),
    );

    expect(requests.some((path) => path.includes("/commits?"))).toBe(false);
    expect(candidates).toHaveLength(0);
    expect(coverage.complete).toBe(false);
    expect(coverage.reasons.map((reason) => reason.code)).toContain(
      "HYDRATION_FAILED",
    );
  });

  test("accepts exactly 250 commits only when all three pages match metadata", async () => {
    const fake = {
      async json<T>(request: GitHubRequest): Promise<T> {
        const path = request.path ?? "";
        if (path.startsWith("/search/issues")) {
          return {
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                pull_request: {
                  url: "https://api.github.com/repos/acme/tool/pulls/1",
                },
              },
            ],
          } as T;
        }
        if (path.endsWith("/pulls/1")) {
          return {
            ...pull(1, "2026-01-01T00:00:00Z"),
            commits: 250,
          } as T;
        }
        const page = Number(
          new URL(`https://api.github.com${path}`).searchParams.get("page"),
        );
        if (path.includes("/commits?")) {
          const length = page === 3 ? 50 : 100;
          const offset = (page - 1) * 100;
          return Array.from({ length }, (_, index) => ({
            sha: (offset + index).toString(16).padStart(40, "0"),
          })) as T;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    };

    const { candidates, coverage } = await discoverCandidates(
      fake as unknown as GitHubClient,
      "pinion05",
      new Date("2026-07-29T00:00:00Z"),
    );

    expect(candidates[0]?.commitShas).toHaveLength(250);
    expect(coverage.complete).toBe(true);
  });

  test("rejects discovery metadata whose completeness cannot be proven", async () => {
    const fake = {
      async json<T>(): Promise<T> {
        return { items: [] } as T;
      },
    };

    let failure: unknown;
    try {
      await discoverCandidates(
        fake as unknown as GitHubClient,
        "pinion05",
        new Date("2026-07-29T00:00:00Z"),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "GitHub 검색 응답이 올바르지 않습니다",
    );
  });
});
