import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { fixtureJobId, fixtureResult } from "../fixtures/result";

test("landing page explains the three independent signals", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: /당신이 만든 코드는.*지금도 살아 있나요/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("GitHub 사용자명")).toBeVisible();
  await expect(page.getByRole("heading", { name: "원래 경로" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "저장소 전체 텍스트" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blame 계보" })).toBeVisible();
});

test("submits a username, polls status, and renders evidence-rich results", async ({
  page,
}) => {
  await page.route("**/api/analyses", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ username: "pinion05" });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: fixtureJobId,
        canonicalLogin: "pinion05",
        state: "RUNNING",
        statusUrl: `/api/analyses/${fixtureJobId}/status`,
      }),
    });
  });
  await page.route(`**/api/analyses/${fixtureJobId}/status`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: fixtureJobId,
        state: "SUCCEEDED",
        phase: "COMPLETE",
        progress: { completedUnits: 4, totalUnits: 4 },
        coverageWarnings: 0,
        resultUrl: `/api/analyses/${fixtureJobId}/result`,
        shareUrl: `/r/${fixtureJobId}`,
        error: null,
      }),
    });
  });
  await page.route(`**/api/analyses/${fixtureJobId}/result`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureResult),
    });
  });

  await page.goto("/");
  await page.getByLabel("GitHub 사용자명").fill("pinion05");
  await page.getByRole("button", { name: "생존율 분석" }).click();

  await expect(page).toHaveURL(new RegExp(`/analysis/${fixtureJobId}$`));
  await expect(
    page.getByRole("heading", { name: "@pinion05의 코드 생존 기록" }),
  ).toBeVisible();
  const metrics = page.locator(".metrics-grid");
  await expect(metrics.getByText("78.0%", { exact: true })).toHaveCount(2);
  await expect(metrics.getByText("91.0%", { exact: true })).toBeVisible();
  await expect(metrics.getByText("71.0%", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pull request별 근거" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /#42 Keep useful code alive/ }),
  ).toBeVisible();
  await expect(page.getByText("발견 범위 완전")).toBeVisible();

  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/dashboard.png", fullPage: true });
});

test("renders a useful error for an expired analysis URL", async ({ page }) => {
  await page.route(
    "**/api/analyses/22222222-2222-4222-8222-222222222222/status",
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "분석을 찾을 수 없습니다" } }),
      }),
  );
  await page.goto("/analysis/22222222-2222-4222-8222-222222222222");
  await expect(
    page.getByRole("heading", { name: "분석을 완료하지 못했습니다" }),
  ).toBeVisible();
  await expect(page.getByText("분석을 찾을 수 없습니다")).toBeVisible();
});
