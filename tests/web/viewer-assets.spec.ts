import { test, expect } from "@playwright/test";
import { createViewerAssets } from "../../apps/server/src/viewer-assets";

test("the web server serves shared viewer assets without a running controller", async ({
  request,
}) => {
  const assets = await createViewerAssets();
  const response = await request.head(`${assets.basePath}/worker.js`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("javascript");
  expect(response.headers()["cache-control"]).toContain("immutable");
  const etag = response.headers().etag;
  expect(etag).toBeTruthy();

  const cached = await request.head(`${assets.basePath}/worker.js`, {
    headers: { "If-None-Match": etag! },
  });
  expect(cached.status()).toBe(304);
  expect((await cached.body()).length).toBe(0);
});
