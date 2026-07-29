import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/server/errors";
import { GitHubClient } from "../../src/server/github/client";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("bounded GitHub transport", () => {
  test("rejects a response before buffering beyond the request budget", async () => {
    const client = new GitHubClient(
      "server-only-token",
      undefined,
      (async () =>
        new Response("x".repeat(100), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const error = await rejection(
      client.text({ path: "/users/test", maxBytes: 10 }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(client.budget.restCalls).toBe(1);
  });

  test("uses POST for GraphQL without exposing the token in the URL", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const client = new GitHubClient("server-only-token", undefined, (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    const value = await client.json<{ data: { ok: boolean } }>({
      graphql: { query: "query { viewer { login } }", variables: {} },
    });
    expect(value.data.ok).toBe(true);
    expect(observedUrl).toBe("https://api.github.com/graphql");
    expect(observedUrl).not.toContain("server-only-token");
    expect(observedInit?.method).toBe("POST");
    expect(new Headers(observedInit?.headers).get("authorization")).toBe(
      "Bearer server-only-token",
    );
  });

  test("maps GitHub throttling to a stable public error", async () => {
    const client = new GitHubClient(
      "token",
      undefined,
      (async () =>
        new Response("rate limited", {
          status: 429,
        })) as unknown as typeof fetch,
    );
    const error = await rejection(client.text({ path: "/rate_limit" }));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).publicMessage).toContain("GitHub 요청 한도");
  });
});
