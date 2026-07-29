import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";

export type GitHubBudget = {
  restCalls: number;
  graphqlCalls: number;
  totalCalls: number;
  restBytes: number;
  graphqlBytes: number;
};

export const createBudget = (): GitHubBudget => ({
  restCalls: 0,
  graphqlCalls: 0,
  totalCalls: 0,
  restBytes: 0,
  graphqlBytes: 0,
});

export type GitHubRequest = {
  path?: string;
  graphql?: { query: string; variables: Record<string, unknown> };
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class GitHubClient {
  constructor(
    private readonly token: string,
    readonly budget: GitHubBudget = createBudget(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async json<T>(request: GitHubRequest): Promise<T> {
    const text = await this.request(request);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError(
        "GITHUB_UNAVAILABLE",
        "GitHub 응답 형식이 올바르지 않습니다",
      );
    }
  }

  text(request: GitHubRequest): Promise<string> {
    return this.request(request);
  }

  private async request(request: GitHubRequest): Promise<string> {
    const isGraphql = request.graphql !== undefined;
    this.admit(isGraphql);
    if (request.signal?.aborted) {
      throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
    }

    const controller = new AbortController();
    const relay = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", relay, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("GitHub request deadline")),
      request.timeoutMs ?? 15_000,
    );
    const url = isGraphql
      ? "https://api.github.com/graphql"
      : `https://api.github.com${request.path ?? ""}`;

    try {
      const init: RequestInit = {
        method: isGraphql ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: request.accept ?? "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "code-survivability/1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
        redirect: "error",
        ...(isGraphql ? { body: JSON.stringify(request.graphql) } : {}),
      };
      const response = await this.fetcher(url, init);
      if (response.status === 404) {
        throw new AppError(
          "USER_NOT_FOUND",
          "공개 GitHub 사용자를 찾을 수 없습니다",
        );
      }
      if (response.status === 403 || response.status === 429) {
        throw new AppError("RATE_LIMITED", "GitHub 요청 한도에 도달했습니다");
      }
      if (!response.ok) {
        throw new AppError(
          "GITHUB_UNAVAILABLE",
          "GitHub가 요청을 처리하지 못했습니다",
        );
      }

      const maxBytes =
        request.maxBytes ??
        (isGraphql ? LIMITS.graphqlBytes : LIMITS.searchBytes);
      const reader = response.body?.getReader();
      if (!reader)
        throw new AppError("GITHUB_UNAVAILABLE", "GitHub 응답 본문이 없습니다");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new AppError(
              "GITHUB_RESPONSE_LIMIT",
              "GitHub 응답 크기 한도를 초과했습니다",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      if (isGraphql) this.budget.graphqlBytes += size;
      else this.budget.restBytes += size;
      if (
        this.budget.restBytes > LIMITS.restBytes ||
        this.budget.graphqlBytes > LIMITS.graphqlBytes
      ) {
        throw new AppError(
          "GITHUB_RESPONSE_LIMIT",
          "GitHub 누적 응답 한도를 초과했습니다",
        );
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (request.signal?.aborted) {
        throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
      }
      if (controller.signal.aborted) {
        throw new AppError(
          "GITHUB_UNAVAILABLE",
          "GitHub 요청 시간이 초과되었습니다",
        );
      }
      throw new AppError("GITHUB_UNAVAILABLE", "GitHub에 연결할 수 없습니다");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", relay);
    }
  }

  private admit(graphql: boolean): void {
    this.budget.totalCalls += 1;
    if (graphql) this.budget.graphqlCalls += 1;
    else this.budget.restCalls += 1;
    if (
      this.budget.totalCalls > LIMITS.githubCalls ||
      this.budget.restCalls > LIMITS.restCalls ||
      this.budget.graphqlCalls > LIMITS.graphqlCalls
    ) {
      throw new AppError(
        "RATE_LIMITED",
        "분석별 GitHub 요청 한도를 초과했습니다",
      );
    }
  }
}
