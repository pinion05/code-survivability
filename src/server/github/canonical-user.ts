import { AppError } from "../errors";
import type { GitHubClient } from "./client";

const LOGIN = /^(?!-)(?!.*--)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function validateUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("INVALID_USERNAME", "GitHub 사용자명을 입력해 주세요");
  }
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (trimmed.length === 0 || trimmed.length > 39 || !LOGIN.test(trimmed)) {
    throw new AppError(
      "INVALID_USERNAME",
      "유효한 GitHub 사용자명을 입력해 주세요",
    );
  }
  return trimmed;
}

export async function canonicalizeUser(
  client: GitHubClient,
  username: string,
): Promise<{ login: string; id: number; avatarUrl: string }> {
  const data = await client.json<{
    login?: unknown;
    id?: unknown;
    avatar_url?: unknown;
    type?: unknown;
  }>({
    path: `/users/${encodeURIComponent(username)}`,
    maxBytes: 256 * 1024,
  });
  if (
    typeof data.login !== "string" ||
    typeof data.id !== "number" ||
    typeof data.avatar_url !== "string" ||
    data.type !== "User"
  ) {
    throw new AppError(
      "USER_NOT_FOUND",
      "공개 GitHub 사용자를 찾을 수 없습니다",
    );
  }
  return { login: data.login, id: data.id, avatarUrl: data.avatar_url };
}
