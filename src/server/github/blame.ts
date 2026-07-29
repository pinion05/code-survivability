import { LIMITS } from "../schemas/limits";
import type { CompleteBlame } from "../analysis/metrics";
import type { GitHubClient } from "./client";

const QUERY = `
query BlameAtOid($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        oid
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit { oid }
          }
        }
      }
    }
  }
}`;

type Response = {
  data?: {
    repository?: {
      object?: {
        oid?: unknown;
        blame?: {
          ranges?: Array<{
            startingLine?: unknown;
            endingLine?: unknown;
            commit?: { oid?: unknown };
          }>;
        } | null;
      } | null;
    } | null;
  };
  errors?: unknown[];
};

export async function fetchCompleteBlame(
  client: GitHubClient,
  input: { owner: string; repo: string; oid: string; path: string },
): Promise<CompleteBlame | null> {
  const response = await client.json<Response>({
    graphql: {
      query: QUERY,
      variables: {
        owner: input.owner,
        name: input.repo,
        oid: input.oid,
        path: input.path,
      },
    },
    maxBytes: LIMITS.graphqlBytes,
  });
  if (response.errors?.length) return null;
  const object = response.data?.repository?.object;
  const ranges = object?.blame?.ranges;
  if (
    object?.oid !== input.oid ||
    !Array.isArray(ranges) ||
    ranges.length > LIMITS.blameRangesPerPr
  ) {
    return null;
  }
  const parsed: CompleteBlame["ranges"] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      typeof range.startingLine !== "number" ||
      typeof range.endingLine !== "number" ||
      typeof range.commit?.oid !== "string" ||
      range.startingLine <= previousEnd ||
      range.endingLine < range.startingLine
    ) {
      return null;
    }
    parsed.push({
      startLine: range.startingLine,
      endLine: range.endingLine,
      oid: range.commit.oid,
    });
    previousEnd = range.endingLine;
  }
  return { oid: input.oid, path: input.path, ranges: parsed };
}
