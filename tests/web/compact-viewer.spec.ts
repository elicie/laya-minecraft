import { test, expect, type WebSocketRoute, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "canvas";
import type {
  ViewerMessage,
  ViewerMaterial,
} from "../../packages/minecraft/src/viewer-protocol";
const root = resolve("public/compact-viewer");
const air: ViewerMaterial = {
  stateId: 0,
  name: "air",
  shape: "empty",
  opaque: false,
  transparent: true,
  color: 0,
};
const stone: ViewerMaterial = {
  stateId: 1,
  name: "stone",
  shape: "cube",
  opaque: true,
  transparent: false,
  color: 0x777777,
  faces: Object.fromEntries(
    ["up", "down", "north", "south", "east", "west"].map((name) => [
      name,
      { u: 0, v: 0, su: 1, sv: 1 },
    ]),
  ),
};
function section(revision: number, ground: boolean) {
  const bytes = Buffer.alloc(8192);
  if (ground) for (let i = 0; i < 256; i++) bytes.writeUInt16LE(1, i * 2);
  return {
    type: "section" as const,
    id: "0,0,0",
    revision,
    size: 16 as const,
    origin: { x: 0, y: 0, z: 0 },
    palette: [air, stone],
    voxels: bytes.toString("base64"),
  };
}
const camera = {
  type: "camera" as const,
  position: { x: 8, y: 2.6, z: 8 },
  yaw: 0,
  pitch: -0.5,
};
type Telemetry = {
  status: string;
  triangles: number;
  renderedFrames: number;
  renderedFramesTotal: number;
  entityCount: number;
  movingEntities: number;
  pixelRatio: number;
  renderedSections: number;
  pending: number;
  streamId: string;
};
async function telemetry(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { layaViewerTelemetry: Telemetry })
        .layaViewerTelemetry,
  );
}
async function fixture(page: Page, failWorker = false, reconnectTerrain = true) {
  const errors: string[] = [],
    sockets: WebSocketRoute[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const atlas = createCanvas(16, 16),
    ctx = atlas.getContext("2d");
  ctx.fillStyle = "#8a795e";
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = "#9c8c71";
  ctx.fillRect(0, 0, 8, 8);
  await page.route("**/viewer/Fixture/**", async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (!file)
      return route.fulfill({
        contentType: "text/html",
        body: readFileSync(resolve(root, "index.html")),
      });
    if (file === "atlas.png")
      return route.fulfill({
        contentType: "image/png",
        body: atlas.toBuffer("image/png"),
      });
    if (failWorker && file === "worker.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: 'throw new Error("Fixture mesher unavailable")',
      });
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    const path =
      file === "three.module.js"
        ? resolve("node_modules/three/build/three.module.js")
        : resolve(root, file);
    return route.fulfill({ contentType: type, body: readFileSync(path) });
  });
  await page.routeWebSocket("**/viewer/Fixture/stream", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        streamId: "fixture-world",
        version: "1.21.1",
        dimension: "overworld",
        minY: -64,
        maxY: 320,
        viewDistance: 2,
        sectionIds: ["0,0,0"],
        atlasUrl: "/viewer/Fixture/atlas.png",
        atlasVersion: "fixture",
        approximate: false,
      }),
    );
    socket.send(JSON.stringify(camera));
    if (sockets.length > 1 && reconnectTerrain) socket.send(JSON.stringify(section(1, true)));
  });
  await page.goto("/viewer/Fixture/");
  await expect.poll(() => sockets.length).toBe(1);
  return {
    errors,
    sockets,
    send: (value: ViewerMessage | Record<string, unknown>) =>
      sockets.at(-1)!.send(JSON.stringify(value)),
  };
}
test("compact renderer waits for actual terrain, draws real geometry, idles and keeps its scene on reconnect", async ({
  page,
}, testInfo) => {
  const { errors, sockets, send } = await fixture(page);
  send(section(1, false));
  await expect
    .poll(async () => (await telemetry(page))?.renderedSections)
    .toBe(0);
  send({
    type: "entities",
    entities: [
      {
        id: "friend",
        name: "ObservedFriend",
        position: { x: 8, y: 1, z: 5 },
        width: 0.6,
        height: 1.8,
        yaw: 0,
        kind: "player",
      },
    ],
  });
  await page.waitForTimeout(250);
  expect((await telemetry(page)).status).toBe("loading");
  expect((await telemetry(page)).triangles).toBe(0);
  send(section(2, true));
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  const visible = await telemetry(page);
  expect(visible.triangles).toBeGreaterThan(0);
  expect(visible.pixelRatio).toBeLessThanOrEqual(1);
  const oldTriangles = visible.triangles;
  send({
    type: "delta",
    id: "0,0,0",
    revision: 3,
    position: { x: 8, y: 0, z: 5 },
    material: air,
  });
  await expect
    .poll(async () => (await telemetry(page))?.triangles)
    .not.toBe(oldTriangles);
  const canvas = (await page.locator("canvas").first().elementHandle())!;
  const shot = await page.screenshot({
    path: testInfo.outputPath("observed-terrain.png"),
  });
  const image = await loadImage(shot),
    copy = createCanvas(image.width, image.height),
    context = copy.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let terrainPixels = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (
      pixels[i]! > 70 &&
      pixels[i]! < 175 &&
      pixels[i + 1]! > 60 &&
      pixels[i + 1]! < 170 &&
      pixels[i + 2]! < 150
    )
      terrainPixels++;
  expect(terrainPixels).toBeGreaterThan(1000);
  const idle = await telemetry(page);
  await page.waitForTimeout(1150);
  send(camera);
  await page.waitForTimeout(100);
  expect((await telemetry(page)).renderedFrames).toBeLessThanOrEqual(
    idle.renderedFrames + 1,
  );
  await sockets[0]!.close({ code: 1012, reason: "fixture reconnect" });
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("disconnected");
  await expect.poll(() => sockets.length).toBe(2);
  // A lower-revision full replay is authoritative on the same stream; the scene remains owned.
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  expect(
    await canvas.evaluate(
      (node) => node.isConnected && node === document.querySelector("canvas"),
    ),
  ).toBe(true);
  expect((await telemetry(page)).renderedSections).toBe(1);
  send({ type: "remove", id: "0,0,0" });
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("loading");
  expect((await telemetry(page)).triangles).toBe(0);
  expect(errors).toEqual([]);
});
test("camera and section generations update actual terrain and protocol failures remain explicit", async ({
  page,
}) => {
  const { errors, send } = await fixture(page,false,false);
  send(section(1, true));
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  await page.waitForTimeout(5100);
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("loading");
  send(camera);
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  send({ type: "reset", streamId: "replacement", dimension: "the_nether" });
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("loading");
  expect((await telemetry(page)).renderedSections).toBe(0);
  send(camera);
  send(section(2, true));
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  expect((await telemetry(page)).streamId).toBe("replacement");
  const canvas = (await page.locator("canvas").first().elementHandle())!;
  send({ ...camera, position: { x: 88, y: 2.6, z: 8 } });
  await expect
    .poll(async () => (await telemetry(page))?.renderedSections)
    .toBe(0);
  send({ ...section(3, true), id: "5,0,0", origin: { x: 80, y: 0, z: 0 } });
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  expect((await telemetry(page)).renderedSections).toBe(1);
  expect(await canvas.evaluate((node) => node.isConnected)).toBe(true);
  send({
    ...section(4, true),
    id: "5,0,0",
    origin: { x: 80, y: 0, z: 0 },
    voxels: "invalid",
  });
  await expect.poll(async () => (await telemetry(page))?.status).toBe("error");
  expect(await page.locator("#notice").textContent()).toMatch(/구역|문자|지형/);
  await page.waitForTimeout(700);
  expect((await telemetry(page))?.status).toBe('error');
  send({type:'reset',streamId:'verified-after-error',dimension:'the_nether'});
  send({...camera,position:{x:88,y:2.6,z:8}});
  send({...section(5,true),id:'5,0,0',origin:{x:80,y:0,z:0}});
  await expect.poll(async()=>(await telemetry(page))?.status).toBe('terrain-ready');
  expect((await telemetry(page)).streamId).toBe('verified-after-error');
  expect(errors).toEqual([]);
});

test("worker failure is explicit and cannot claim observed terrain ready", async ({
  page,
}) => {
  const { send } = await fixture(page, true);
  send(section(1, true));
  await expect.poll(async () => (await telemetry(page))?.status).toBe("error");
  await expect(page.locator("#notice")).toContainText(
    "지형을 처리하지 못했습니다",
  );
  expect((await telemetry(page)).status).not.toBe("terrain-ready");
});

test("observed entity targets interpolate across draws and duplicate reports or teleports do not keep drawing", async ({
  page,
}) => {
  const { send, errors } = await fixture(page);
  send(section(1, true));
  await expect
    .poll(async () => (await telemetry(page))?.status)
    .toBe("terrain-ready");
  const entity = {
    id: "friend",
    name: "ObservedFriend",
    position: { x: 6, y: 1, z: 5 },
    width: 0.6,
    height: 1.8,
    yaw: 0,
    kind: "player",
  };
  send({ type: "entities", entities: [entity] });
  await expect.poll(async () => (await telemetry(page))?.entityCount).toBe(1);
  const before = (await telemetry(page)).renderedFramesTotal;
  entity.position.x = 10;
  send({ type: "entities", entities: [entity] });
  await expect
    .poll(async () => (await telemetry(page))?.renderedFramesTotal)
    .toBeGreaterThan(before + 3);
  await expect
    .poll(async () => (await telemetry(page))?.movingEntities)
    .toBe(0);
  const settled = (await telemetry(page)).renderedFramesTotal;
  send(camera);
  for (let i = 0; i < 12; i++) {
    send({ type: "entities", entities: [entity] });
    await page.waitForTimeout(100);
  }
  expect((await telemetry(page)).renderedFramesTotal).toBe(settled);
  entity.position.x = 60;
  send({ type: "entities", entities: [entity] });
  await expect
    .poll(async () => (await telemetry(page))?.renderedFramesTotal)
    .toBeGreaterThan(settled);
  expect((await telemetry(page)).renderedFramesTotal).toBeLessThanOrEqual(
    settled + 2,
  );
  expect((await telemetry(page)).movingEntities).toBe(0);
  send({ type: "reset", streamId: "next-life", dimension: "overworld" });
  await expect.poll(async () => (await telemetry(page))?.entityCount).toBe(0);
  expect(errors).toEqual([]);
});
