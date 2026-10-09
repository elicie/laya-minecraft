import test from "node:test";
import assert from "node:assert/strict";
import {
  finitePosition,
  isReportStale,
  mergeReceipt,
  percent,
  safeViewerUrl,
} from "../apps/web/src/lib/display";

test("web marks a missing or 10-second-old report stale without treating zero timestamps as current", () => {
  assert.equal(isReportStale(undefined, 10_000), true);
  assert.equal(isReportStale(1_000, 10_999), false);
  assert.equal(isReportStale(1_000, 11_000), true);
  assert.equal(isReportStale(Number.NaN, 11_000), true);
});

test("web only embeds the selected bot viewer under its own local route", () => {
  assert.equal(safeViewerUrl("/viewer/hunter", "hunter"), "/viewer/hunter/");
  assert.equal(safeViewerUrl("/viewer/hunter/", "hunter"), "/viewer/hunter/");
  for (const url of [
    "https://example.com/",
    "//example.com/",
    "/viewer/hunter-other/",
    "/viewer/hunter/../other",
    "/viewer/hunter/\\evil",
  ]) {
    assert.equal(safeViewerUrl(url, "hunter"), undefined);
  }
  assert.equal(safeViewerUrl("/viewer/farmer/", "hunter"), undefined);
});

test("a late accepted response cannot overwrite actual applied state", () => {
  const applied = { state: "applied", updatedAt: 100 };
  assert.equal(
    mergeReceipt(applied, { state: "accepted", updatedAt: 101 }),
    applied,
  );
  assert.equal(
    mergeReceipt(applied, { state: "failed", updatedAt: 90 }),
    applied,
  );
  assert.equal(mergeReceipt(undefined, applied), applied);
});

test("map and progress tolerate invalid geometry and overshoot", () => {
  assert.equal(finitePosition({ x: 0, y: 64, z: 0 }), true);
  assert.equal(finitePosition({ x: Number.NaN, y: 64, z: 0 }), false);
  assert.equal(finitePosition({ x: 0, y: 64 }), false);
  assert.equal(percent(42, 32), 100);
  assert.equal(percent(10, 0), undefined);
});
