import { describe, expect, test } from "bun:test";
import { validateUsername } from "../../src/server/github/canonical-user";
import { parseBatchBlobs, parseTree } from "../../src/server/git/scanner";
import { spawnBounded } from "../../src/server/git/spawn";
import { readBoundedJson } from "../../src/server/schemas/api";
import { LIMITS } from "../../src/server/schemas/limits";
import { AppError } from "../../src/server/errors";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected promise to reject");
}

describe("untrusted input boundaries", () => {
  test("accepts canonical GitHub login syntax and rejects injection-shaped values", () => {
    expect(validateUsername("  pinion05\n")).toBe("pinion05");
    for (const value of [
      "-owner",
      "owner-",
      "owner--repo",
      "owner/repo",
      "$(id)",
      "한글",
    ]) {
      expect(() => validateUsername(value)).toThrow(AppError);
    }
  });

  test("requires bounded JSON with the exact media type", async () => {
    const mediaTypeError = await rejection(
      readBoundedJson(
        new Request("http://local", { method: "POST", body: "{}" }),
      ),
    );
    expect(mediaTypeError.publicMessage).toContain("Content-Type");

    const oversized = JSON.stringify({
      username: "x".repeat(LIMITS.requestBodyBytes),
    });
    const oversizedError = await rejection(
      readBoundedJson(
        new Request("http://local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversized,
        }),
      ),
    );
    expect(oversizedError.publicMessage).toContain("요청 본문 크기 한도");
  });

  test("parses only complete safe NUL-delimited regular-blob tree records", () => {
    const sha = "a".repeat(40);
    const parsed = parseTree(
      Buffer.from(`100644 blob ${sha}       12\tsrc/index.ts\0`),
    );
    expect(parsed).toEqual([
      { mode: "100644", oid: sha, size: 12, path: "src/index.ts" },
    ]);
    expect(() =>
      parseTree(Buffer.from(`100644 blob ${sha} 12\tsrc/index.ts`)),
    ).toThrow("Git 트리 출력이 잘렸습니다");
    expect(() =>
      parseTree(Buffer.from(`100644 blob ${sha} 12\t../secret\0`)),
    ).toThrow("Git 트리 경로가 안전하지 않습니다");
  });

  test("parses complete ordered cat-file batches and rejects truncation", () => {
    const oid = "b".repeat(40);
    const expected = [{ oid, size: 5 }];
    const parsed = parseBatchBlobs(
      Buffer.from(`${oid} blob 5\nhello\n`, "ascii"),
      expected,
    );
    expect(parsed.get(oid)?.toString()).toBe("hello");
    expect(() =>
      parseBatchBlobs(Buffer.from(`${oid} blob 5\nhello`, "ascii"), expected),
    ).toThrow("Git blob batch 본문이 잘렸습니다");
  });

  test("spawns argv without a shell and enforces output bounds", async () => {
    const literal = "; echo injected";
    const safe = await spawnBounded(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", literal],
      {
        cwd: process.cwd(),
        env: process.env,
        limits: { timeoutMs: 2_000, stdoutBytes: 100, stderrBytes: 100 },
      },
    );
    expect(safe.stdout.toString()).toBe(literal);

    const outputError = await rejection(
      spawnBounded(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(200))"],
        {
          cwd: process.cwd(),
          env: process.env,
          limits: { timeoutMs: 2_000, stdoutBytes: 10, stderrBytes: 100 },
        },
      ),
    );
    expect(outputError.publicMessage).toContain("표준 출력 한도");
  });
});
