import { expect, test } from "@playwright/test";

test("health and readiness expose only operational state", async ({
  request,
}) => {
  const health = await request.get("/healthz");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "alive" });
  expect(health.headers()["x-content-type-options"]).toBe("nosniff");

  await expect
    .poll(async () => {
      const response = await request.get("/readyz");
      return response.status();
    })
    .toBe(200);
  const ready = await request.get("/readyz");
  expect(await ready.json()).toEqual({ status: "ready" });
});

test("rejects cross-origin, malformed, and oversized analysis submissions", async ({
  request,
}) => {
  const crossOrigin = await request.post("/api/analyses", {
    headers: { origin: "https://evil.example" },
    data: { username: "pinion05" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await crossOrigin.json()).error.code).toBe("FORBIDDEN_ORIGIN");

  const malformed = await request.post("/api/analyses", {
    data: { username: "owner/repository" },
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error.code).toBe("INVALID_USERNAME");

  const oversized = await request.post("/api/analyses", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ username: "x".repeat(3_000) }),
  });
  expect(oversized.status()).toBe(413);
  expect((await oversized.json()).error.code).toBe("REQUEST_TOO_LARGE");
});

test("landing response applies browser security policy and never leaks the runtime token", async ({
  request,
}) => {
  const response = await request.get("/");
  const html = await response.text();
  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(html).not.toContain("e2e-public-token");
});
