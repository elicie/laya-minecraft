import { test, expect } from "@playwright/test";
import { FleetController } from "../../packages/core/src";

test("production panel shows unknown stock and limited model approval honestly and refreshes real stock", async ({
  page,
}) => {
  const snapshot = new FleetController({
    send() {},
    rules: { autonomyEnabled: false },
  }).getSnapshot();
  let bread: number | null = null;
  const operations = () => ({
    observedAt: Date.now(),
    stock: {
      observedAt: bread === null ? null : Date.now(),
      stale: bread === null,
      bread,
      wheat: 2,
      seeds: 9,
      wood: 1,
      breadTarget: 8,
      seedTarget: 12,
    },
    farm: {
      id: "observed-farm",
      planned: 12,
      planted: 8,
      watered: 8,
      ripe: 1,
      observedAt: Date.now(),
      stale: false,
    },
    bots: [],
    decisions: [
      {
        time: Date.now(),
        source: "code",
        reason: "현재 허용한 작업 순서를 사용합니다.",
      },
    ],
    model: {
      status: "ready",
      name: "evaluated-v6",
      profile: "canonical-base-v1",
      checkedAt: Date.now(),
    },
    training: [
      {
        id: "trained-v6",
        state: "qualified",
        step: 80,
        totalSteps: 80,
        trainRows: 640,
        correct: 25,
        total: 25,
        illegal: 0,
        broadApproved: false,
        profile: "canonical-base-v1",
        note: "검증 관측 24개와 운영 shadow 1개입니다.",
      },
    ],
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/operations"))
      return route.fulfill({ json: operations() });
    if (url.pathname.endsWith("/stream"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      });
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "생산·학습 현황 보기" }).click();
  const panel = page.getByRole("region", { name: "식량·농장·모델·학습" });
  await expect(
    panel.getByText("빵 미관측 / 목표 8개", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("확장 질문 평가 미통과", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByText("범위 제한 승인")).toBeVisible();
  await expect(
    panel.getByText("검증 관측 24개와 운영 shadow 1개입니다."),
  ).toBeVisible();
  bread = 4;
  await expect(panel.getByText("빵 4 / 목표 8개", { exact: true })).toBeVisible(
    { timeout: 10000 },
  );
  await expect(
    panel.getByText("현재 허용한 작업 순서를 사용합니다."),
  ).toBeVisible();
});
