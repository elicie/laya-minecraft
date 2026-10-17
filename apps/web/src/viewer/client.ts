import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Color,
  Fog,
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  TextureLoader,
  NearestFilter,
  DoubleSide,
  BoxGeometry,
  CanvasTexture,
  Sprite,
  SpriteMaterial,
  type Texture,
} from "three";
import type {
  ViewerMessage,
  ViewerMaterial,
  ViewerPosition,
} from "../../../../packages/minecraft/src/viewer-protocol";
import { decodeVoxels, sectionId, type MeshData } from "./mesh";
import type { MeshRequest } from "./mesher.worker";
import { smoothObservedPosition } from "./motion";
import "./viewer.css";

function startViewer() {
  const root = document.querySelector<HTMLElement>("#world")!,
    notice = document.querySelector<HTMLElement>("#notice")!;
  const details = document.querySelector<HTMLElement>("#details")!,
    scene = new Scene();
  scene.background = new Color(0xaed6e1);
  scene.fog = new Fog(0xaed6e1, 40, 75);
  const camera = new PerspectiveCamera(75, 1, 0.08, 96),
    renderer = new WebGLRenderer({
      antialias: false,
      powerPreference: "low-power",
    });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1));
  renderer.setClearColor(0xaed6e1);
  root.append(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "관측한 마인크래프트 지형");
  const opaque = new MeshBasicMaterial({ vertexColors: true, alphaTest: 0.1 }),
    transparent = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: DoubleSide,
    }),
    plain = new MeshBasicMaterial({ vertexColors: true });
  const materials = [opaque, transparent, plain];
  const entityScene = new Scene(),
    entityBox = new BoxGeometry(1, 1, 1);
  const entityMaterials = {
    player: new MeshBasicMaterial({
      color: 0x7ddeca,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    }),
    mob: new MeshBasicMaterial({
      color: 0xf3b170,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    }),
    object: new MeshBasicMaterial({
      color: 0xc7cce5,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
    }),
  };
  interface EntityInput {
    id: string;
    name: string;
    position: ViewerPosition;
    width: number;
    height: number;
    yaw: number;
    kind: "player" | "mob" | "object";
  }
  interface EntityView {
    mesh: Mesh;
    label: Sprite;
    input: EntityInput;
    display: ViewerPosition;
  }
  const entities = new Map<string, EntityView>();
  function placeEntity(entity: EntityView) {
    const p = entity.display;
    entity.mesh.position.set(
      p.x - origin.x,
      p.y + entity.input.height / 2 - origin.y,
      p.z - origin.z,
    );
    entity.label.position.set(
      p.x - origin.x,
      p.y + entity.input.height + 0.25 - origin.y,
      p.z - origin.z,
    );
  }
  function removeEntity(id: string) {
    const entity = entities.get(id);
    if (!entity) return;
    entityScene.remove(entity.mesh, entity.label);
    entity.label.material.map?.dispose();
    entity.label.material.dispose();
    entities.delete(id);
  }
  function updateEntities(input: EntityInput[]) {
    const seen = new Set<string>();
    let changed = false;
    for (const value of input.slice(0, 80)) {
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        !position(value.position) ||
        !finite(value.width) ||
        !finite(value.height) ||
        value.width <= 0 ||
        value.width > 16 ||
        value.height <= 0 ||
        value.height > 32 ||
        !["player", "mob", "object"].includes(value.kind)
      )
        continue;
      seen.add(value.id);
      let old = entities.get(value.id);
      if (
        old &&
        old.input.name === value.name &&
        old.input.kind === value.kind &&
        old.input.width === value.width &&
        old.input.height === value.height &&
        old.input.position.x === value.position.x &&
        old.input.position.y === value.position.y &&
        old.input.position.z === value.position.z
      )
        continue;
      changed = true;
      if (!old) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 48;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#12202abb";
        context.fillRect(0, 0, 256, 48);
        context.fillStyle = "#e9f3f4";
        context.font = "22px sans-serif";
        context.textAlign = "center";
        context.fillText(value.name.slice(0, 28), 128, 31, 244);
        const texture = new CanvasTexture(canvas),
          label = new Sprite(
            new SpriteMaterial({
              map: texture,
              depthTest: true,
              depthWrite: false,
            }),
          ),
          mesh = new Mesh(entityBox, entityMaterials[value.kind]);
        label.scale.set(1.8, 0.34, 1);
        old = { mesh, label, input: value, display: { ...value.position } };
        entities.set(value.id, old);
        entityScene.add(mesh, label);
      }
      old.input = value;
      old.mesh.scale.set(value.width, value.height, value.width);
      smoothObservedPosition(old.display, value.position, 0);
      placeEntity(old);
    }
    for (const id of entities.keys())
      if (!seen.has(id)) {
        removeEntity(id);
        changed = true;
      }
    needsRender ||= changed;
  }
  renderer.autoClear = false;
  interface SectionState {
    id: string;
    revision: number;
    origin: ViewerPosition;
    mesh?: Mesh;
    meshedRevision?: number;
    fallback?: number;
  }
  interface MeshResult extends MeshData {
    type: "mesh";
    streamId: string;
    id: string;
    revision: number;
  }
  const sections = new Map<string, SectionState>(),
    dirty = new Set<string>(),
    uploads: MeshResult[] = [];
  const worker = new Worker(new URL("./mesher.worker.ts", import.meta.url), {
    type: "module",
  });
  let inFlight: { id: string; revision: number } | null = null,
    streamId = "",
    dimension = "",
    viewDistance = 2,
    atlas: Texture | undefined,
    atlasReady = false,
    hasCamera = false,
    connected = false,
    disposed = false,
    ready = false,
    needsRender = true,
    workerFailed = false;
  let socket: WebSocket | undefined,
    reconnect: ReturnType<typeof setTimeout> | undefined,
    retry = 0,
    animation = 0,
    drawAt = 0,
    lastTelemetry = 0,
    lastCameraAt = 0;
  let cameraTarget = { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    displayCamera = structuredClone(cameraTarget),
    origin = { x: 0, y: 0, z: 0 },
    lastFrameAt = 0,
    terrainTriangles = 0,
    renderedFramesTotal = 0,
    movingEntities = 0;
  const drawTimes: number[] = [],
    drawCosts: number[] = [],
    started = performance.now();
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const position = (value: unknown): value is ViewerPosition =>
    !!value &&
    typeof value === "object" &&
    ["x", "y", "z"].every(
      (key) =>
        finite((value as Record<string, unknown>)[key]) &&
        Math.abs((value as Record<string, number>)[key]!) <= 30_000_000,
    );
  const safeAsset = (path: string) => {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin)
      throw new Error("지형 텍스처의 주소를 확인할 수 없습니다.");
    return url.href;
  };
  const send = (value: MeshRequest) =>
    worker.postMessage(
      value,
      value.type === "section" ? [value.section.voxels] : [],
    );
  function telemetry(
    status: "loading" | "terrain-ready" | "disconnected" | "error",
    reason: string,
  ) {
    ready = status === "terrain-ready";
    notice.textContent = reason;
    notice.hidden = ready;
    const now = performance.now(),
      recent = drawTimes.filter((time) => time >= now - 5000),
      costs = drawCosts.slice(-120).sort((a, b) => a - b);
    const payload = {
      type: "laya-viewer",
      protocolVersion: 1,
      status,
      reason,
      streamId,
      dimension,
      sections: sections.size,
      renderedSections: [...sections.values()].filter((section) => section.mesh)
        .length,
      triangles: terrainTriangles,
      textureReady: atlasReady,
      cameraReady: hasCamera,
      pixelRatio: renderer.getPixelRatio(),
      pending: dirty.size + uploads.length + (inFlight ? 1 : 0),
      elapsedMs: now - started,
      renderedFrames: recent.length,
      renderedFramesTotal,
      entityCount: entities.size,
      movingEntities,
      frameCostP95Ms: costs[Math.floor(costs.length * 0.95)] ?? 0,
    };
    window.parent.postMessage(payload, location.origin);
    window.dispatchEvent(
      new CustomEvent("laya-viewer-status", { detail: payload }),
    );
    (
      window as unknown as { layaViewerTelemetry: typeof payload }
    ).layaViewerTelemetry = payload;
  }
  function clearWorld(nextStreamId: string, nextDimension: string) {
    for (const section of sections.values())
      if (section.mesh) {
        scene.remove(section.mesh);
        section.mesh.geometry.dispose();
      }
    sections.clear();
    for (const id of entities.keys()) removeEntity(id);
    movingEntities = 0;
    dirty.clear();
    uploads.length = 0;
    inFlight = null;
    hasCamera = false;
    ready = false;
    streamId = nextStreamId;
    dimension = nextDimension;
    send({ type: "reset", streamId });
    needsRender = true;
  }
  function distance(section: SectionState) {
    const p = cameraTarget.position;
    return (
      (section.origin.x + 8 - p.x) ** 2 +
      (section.origin.y + 8 - p.y) ** 2 +
      (section.origin.z + 8 - p.z) ** 2
    );
  }
  function removeSection(id: string) {
    const section = sections.get(id);
    if (!section) return;
    if (section.mesh) {
      scene.remove(section.mesh);
      section.mesh.geometry.dispose();
    }
    sections.delete(id);
    dirty.delete(id);
    send({ type: "remove", streamId, id });
    neighbors(section);
    needsRender = true;
  }
  function touch(id: string) {
    if (sections.has(id)) dirty.add(id);
  }
  function neighbors(section: SectionState) {
    const p = section.origin;
    for (const offset of [
      [16, 0, 0],
      [-16, 0, 0],
      [0, 16, 0],
      [0, -16, 0],
      [0, 0, 16],
      [0, 0, -16],
    ])
      touch(sectionId(p.x + offset[0]!, p.y + offset[1]!, p.z + offset[2]!));
  }
  function validMaterial(value: unknown): value is ViewerMaterial {
    if (!value || typeof value !== "object") return false;
    const m = value as ViewerMaterial;
    return (
      Number.isInteger(m.stateId) &&
      m.stateId >= 0 &&
      typeof m.name === "string" &&
      m.name.length < 128 &&
      ["empty", "cube", "cross", "slab", "boxes"].includes(m.shape) &&
      typeof m.opaque === "boolean" &&
      typeof m.transparent === "boolean" &&
      Number.isInteger(m.color) &&
      m.color >= 0 &&
      m.color <= 0xffffff &&
      (!m.boxes ||
        (m.boxes.length <= 32 &&
          m.boxes.every(
            (b) =>
              b.length === 6 &&
              b.every((v) => finite(v) && v >= 0 && v <= 1) &&
              b.slice(0, 3).every((v, i) => v <= b[i + 3]!),
          ))) &&
      (!m.faces ||
        Object.values(m.faces).every(
          (uv) =>
            uv &&
            [uv.u, uv.v, uv.su, uv.sv].every(
              (v) => finite(v) && Math.abs(v) <= 1,
            ),
        ))
    );
  }
  function receive(value: unknown) {
    if (!value || typeof value !== "object")
      throw new Error("지형 현황을 확인할 수 없습니다.");
    const message = value as ViewerMessage;
    if (message.type === "hello") {
      if (
        message.protocolVersion !== 1 ||
        typeof message.streamId !== "string" ||
        typeof message.dimension !== "string" ||
        !Number.isInteger(message.viewDistance) ||
        message.viewDistance < 1 ||
        message.viewDistance > 3 ||
        !Array.isArray(message.sectionIds) ||
        message.sectionIds.length > 256 ||
        !message.sectionIds.every(
          (id) => typeof id === "string" && /^-?\d+,-?\d+,-?\d+$/.test(id),
        )
      )
        throw new Error("지원하는 관전 연결이 아닙니다.");
      if (streamId !== message.streamId || dimension !== message.dimension)
        clearWorld(message.streamId, message.dimension);
      const allowed = new Set(message.sectionIds);
      for (const section of sections.values()) {
        if (!allowed.has(section.id)) removeSection(section.id);
        else section.revision = -1; // The replayed full section is authoritative, even after server cache eviction.
      }
      viewDistance = message.viewDistance;
      connected = true;
      retry = 0;
      atlasReady = !message.atlasUrl;
      hasCamera = false;
      details.textContent = `${message.version} · 관측한 근처 지형 · 인물·생물은 위치 표시${message.approximate ? " · 일부 블록 단순 표시" : ""}`;
      telemetry("loading", "카메라와 가까운 지형을 확인하고 있습니다.");
      if (message.atlasUrl) {
        const expected = streamId;
        new TextureLoader().load(
          safeAsset(message.atlasUrl),
          (texture) => {
            if (disposed || expected !== streamId) {
              texture.dispose();
              return;
            }
            atlas?.dispose();
            atlas = texture;
            texture.flipY = false;
            texture.magFilter = NearestFilter;
            texture.minFilter = NearestFilter;
            texture.generateMipmaps = false;
            opaque.map = texture;
            transparent.map = texture;
            opaque.needsUpdate = true;
            transparent.needsUpdate = true;
            atlasReady = true;
            needsRender = true;
          },
          undefined,
          () => {
            if (!disposed && expected === streamId)
              telemetry(
                "error",
                "지형 텍스처를 불러오지 못했습니다. 관전을 멈춘 뒤 다시 연결해 주세요.",
              );
          },
        );
      }
      return;
    }
    if (!streamId) return;
    if (message.type === "camera") {
      if (
        !position(message.position) ||
        !finite(message.yaw) ||
        !finite(message.pitch)
      )
        throw new Error("카메라 위치를 확인할 수 없습니다.");
      const changed =
        !hasCamera ||
        Object.keys(message.position).some(
          (key) =>
            Math.abs(
              message.position[key as keyof ViewerPosition] -
                cameraTarget.position[key as keyof ViewerPosition],
            ) > 0.001,
        ) ||
        Math.abs(message.yaw - cameraTarget.yaw) > 0.001 ||
        Math.abs(message.pitch - cameraTarget.pitch) > 0.001;
      if (!hasCamera) displayCamera = structuredClone(message);
      cameraTarget = message;
      hasCamera = true;
      lastCameraAt = performance.now();
      // Public camera data uses the observed player's eye position (feet + 1.62).
      const cx = Math.floor(message.position.x / 16),
        cy = Math.floor((message.position.y - 1.62) / 16),
        cz = Math.floor(message.position.z / 16);
      for (const section of sections.values()) {
        if (
          Math.abs(section.origin.x / 16 - cx) > viewDistance ||
          Math.abs(section.origin.z / 16 - cz) > viewDistance ||
          Math.abs(section.origin.y / 16 - cy) > 1
        )
          removeSection(section.id);
      }
      needsRender ||= changed || !ready;
      return;
    }
    if (message.type === "entities") {
      const values = message.entities;
      if (!Array.isArray(values))
        throw new Error("주변 인물의 관측을 확인할 수 없습니다.");
      updateEntities(values);
      return;
    }
    if (message.type === "section") {
      if (
        typeof message.id !== "string" ||
        !position(message.origin) ||
        Object.values(message.origin).some((n) => !Number.isInteger(n / 16)) ||
        message.id !==
          sectionId(message.origin.x, message.origin.y, message.origin.z) ||
        message.size !== 16 ||
        !Number.isInteger(message.revision) ||
        message.revision < 0 ||
        !Array.isArray(message.palette) ||
        !message.palette.length ||
        message.palette.length > 4096 ||
        !message.palette.every(validMaterial) ||
        typeof message.voxels !== "string" ||
        message.voxels.length > 12000
      )
        throw new Error("지형 구역의 내용을 확인할 수 없습니다.");
      const old = sections.get(message.id);
      if (old && old.revision >= message.revision) return;
      if (!old && sections.size >= 256)
        throw new Error("표시할 지형 구역이 한도를 넘었습니다.");
      const voxels = decodeVoxels(message.voxels);
      if (voxels.some((index) => index >= message.palette.length))
        throw new Error("지형 블록 목록을 확인할 수 없습니다.");
      const section = {
        ...old,
        id: message.id,
        revision: message.revision,
        origin: message.origin,
      };
      sections.set(section.id, section);
      send({
        type: "section",
        streamId,
        section: {
          id: section.id,
          revision: section.revision,
          origin: section.origin,
          palette: message.palette,
          voxels: voxels.buffer as ArrayBuffer,
        },
      });
      touch(section.id);
      neighbors(section);
      return;
    }
    if (message.type === "delta") {
      const section = sections.get(message.id);
      if (!section || message.revision <= section.revision) return;
      if (
        !position(message.position) ||
        Object.values(message.position).some(
          (v) => !Number.isInteger(v) || v < 0 || v > 15,
        ) ||
        !Number.isInteger(message.revision) ||
        !validMaterial(message.material)
      )
        throw new Error("변경된 지형을 확인할 수 없습니다.");
      section.revision = message.revision;
      send({ ...message, streamId });
      touch(section.id);
      neighbors(section);
      return;
    }
    if (message.type === "remove") {
      const section = sections.get(message.id);
      if (section) {
        if (section.mesh) {
          scene.remove(section.mesh);
          section.mesh.geometry.dispose();
        }
        sections.delete(section.id);
        dirty.delete(section.id);
        send({ ...message, streamId });
        neighbors(section);
        needsRender = true;
      }
      return;
    }
    if (message.type === "reset") {
      clearWorld(message.streamId, message.dimension);
      telemetry("loading", "다른 월드의 실제 지형을 확인하고 있습니다.");
      return;
    }
  }
  worker.onmessage = ({
    data,
  }: MessageEvent<
    | MeshResult
    | {
        type: "error";
        streamId: string;
        id: string;
        revision: number;
        reason: string;
      }
  >) => {
    if (data.streamId !== streamId) return;
    if (inFlight?.id === data.id) inFlight = null;
    const section = sections.get(data.id);
    if (!section || section.revision !== data.revision) {
      if (section) touch(section.id);
      return;
    }
    if (data.type === "error") {
      telemetry("error", data.reason);
      return;
    }
    uploads.push(data);
    needsRender = true;
  };
  worker.onerror = () => {
    workerFailed = true;
    telemetry(
      "error",
      "지형을 처리하지 못했습니다. 관전을 멈춘 뒤 다시 연결해 주세요.",
    );
  };
  function upload(result: MeshResult) {
    const section = sections.get(result.id);
    if (!section || section.revision !== result.revision) return;
    if (section.mesh) {
      scene.remove(section.mesh);
      section.mesh.geometry.dispose();
      section.mesh = undefined;
    }
    if (result.positions.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(result.positions, 3),
      );
      geometry.setAttribute("normal", new BufferAttribute(result.normals, 3));
      geometry.setAttribute("uv", new BufferAttribute(result.uvs, 2));
      geometry.setAttribute("color", new BufferAttribute(result.colors, 3));
      const indices = new Uint32Array(
        result.opaque.length +
          result.transparent.length +
          result.untextured.length,
      );
      indices.set(result.opaque);
      indices.set(result.transparent, result.opaque.length);
      indices.set(
        result.untextured,
        result.opaque.length + result.transparent.length,
      );
      geometry.setIndex(new BufferAttribute(indices, 1));
      geometry.addGroup(0, result.opaque.length, 0);
      geometry.addGroup(result.opaque.length, result.transparent.length, 1);
      geometry.addGroup(
        result.opaque.length + result.transparent.length,
        result.untextured.length,
        2,
      );
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, materials);
      mesh.position.set(
        section.origin.x - origin.x,
        section.origin.y - origin.y,
        section.origin.z - origin.z,
      );
      section.mesh = mesh;
      scene.add(mesh);
    }
    section.meshedRevision = result.revision;
    section.fallback = result.fallbackBlocks;
  }
  function connect() {
    if (disposed) return;
    const url = new URL("stream", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 4_000_000)
          throw new Error("지형 응답이 너무 큽니다.");
        receive(JSON.parse(event.data));
      } catch (error) {
        telemetry(
          "error",
          error instanceof Error
            ? error.message
            : "지형을 확인하지 못했습니다.",
        );
      }
    };
    socket.onclose = () => {
      connected = false;
      telemetry("disconnected", "관전 연결을 다시 확인하고 있습니다.");
      reconnect = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
    socket.onerror = () => socket?.close();
  }
  const resize = new ResizeObserver(() => {
    const width = root.clientWidth,
      height = root.clientHeight;
    if (width && height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      needsRender = true;
    }
  });
  resize.observe(root);
  function frame(time: number) {
    if (disposed) return;
    animation = requestAnimationFrame(frame);
    const uploadStarted = performance.now();
    uploads.sort(
      (a, b) =>
        distance(
          sections.get(a.id) ??
            ({ origin: cameraTarget.position } as SectionState),
        ) -
        distance(
          sections.get(b.id) ??
            ({ origin: cameraTarget.position } as SectionState),
        ),
    );
    while (uploads.length && performance.now() - uploadStarted < 4)
      upload(uploads.shift()!);
    if (!workerFailed && !inFlight && hasCamera && dirty.size) {
      const next = [...dirty]
        .map((id) => sections.get(id))
        .filter((s): s is SectionState => !!s)
        .sort((a, b) => distance(a) - distance(b))[0];
      if (next) {
        dirty.delete(next.id);
        inFlight = { id: next.id, revision: next.revision };
        send({ type: "mesh", streamId, ...inFlight });
      }
    }
    if (ready && performance.now() - lastCameraAt >= 5000)
      telemetry("loading", "카메라 보고를 다시 확인하고 있습니다.");
    if (!hasCamera || document.visibilityState === "hidden") return;
    const dt = Math.min(100, time - (lastFrameAt || time));
    lastFrameAt = time;
    const alpha = 1 - Math.exp(-dt / 50);
    let moving = false;
    for (const axis of ["x", "y", "z"] as const) {
      const delta = cameraTarget.position[axis] - displayCamera.position[axis];
      if (Math.abs(delta) > 0.001) {
        displayCamera.position[axis] += delta * alpha;
        moving = true;
      } else displayCamera.position[axis] = cameraTarget.position[axis];
    }
    for (const axis of ["yaw", "pitch"] as const) {
      const delta = Math.atan2(
        Math.sin(cameraTarget[axis] - displayCamera[axis]),
        Math.cos(cameraTarget[axis] - displayCamera[axis]),
      );
      if (Math.abs(delta) > 0.001) {
        displayCamera[axis] += delta * alpha;
        moving = true;
      } else displayCamera[axis] = cameraTarget[axis];
    }
    movingEntities = 0;
    for (const entity of entities.values()) {
      if (smoothObservedPosition(entity.display, entity.input.position, dt))
        movingEntities++;
      placeEntity(entity);
    }
    needsRender ||= moving || movingEntities > 0;
    if (!needsRender || time - drawAt < 1000 / 60 - 0.5) {
      if (ready && time - lastTelemetry > 1000) {
        telemetry("terrain-ready", "관측한 지형을 표시하고 있습니다.");
        lastTelemetry = time;
      }
      return;
    }
    const startedDraw = performance.now(),
      p = displayCamera.position;
    if (
      Math.max(
        Math.abs(p.x - origin.x),
        Math.abs(p.y - origin.y),
        Math.abs(p.z - origin.z),
      ) > 128
    ) {
      origin = {
        x: Math.floor(p.x / 16) * 16,
        y: Math.floor(p.y / 16) * 16,
        z: Math.floor(p.z / 16) * 16,
      };
      for (const section of sections.values())
        section.mesh?.position.set(
          section.origin.x - origin.x,
          section.origin.y - origin.y,
          section.origin.z - origin.z,
        );
      for (const entity of entities.values()) placeEntity(entity);
    }
    camera.position.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
    camera.rotation.set(displayCamera.pitch, displayCamera.yaw, 0, "ZYX");
    renderer.clear();
    renderer.render(scene, camera);
    terrainTriangles = renderer.info.render.triangles;
    renderer.render(entityScene, camera);
    drawAt = time;
    needsRender = uploads.length > 0;
    renderedFramesTotal++;
    drawTimes.push(time);
    drawCosts.push(performance.now() - startedDraw);
    while (drawTimes.length && drawTimes[0]! < time - 5000) drawTimes.shift();
    if (drawCosts.length > 120) drawCosts.shift();
    const containing = sections.get(sectionId(p.x, p.y, p.z)),
      actualTerrain =
        !!containing &&
        containing.meshedRevision === containing.revision &&
        !workerFailed &&
        terrainTriangles > 0 &&
        atlasReady &&
        connected &&
        time - lastCameraAt < 5000;
    if (actualTerrain && (!ready || time - lastTelemetry > 1000)) {
      telemetry("terrain-ready", "관측한 지형을 표시하고 있습니다.");
      lastTelemetry = time;
    } else if (!actualTerrain && ready)
      telemetry(
        connected ? "loading" : "disconnected",
        "카메라와 지형을 다시 확인하고 있습니다.",
      );
  }
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    telemetry("error", "화면 연결을 복원하고 있습니다.");
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    needsRender = true;
    telemetry("loading", "지형을 다시 그리고 있습니다.");
  });
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      cancelAnimationFrame(animation);
      clearTimeout(reconnect);
      socket?.close();
      worker.terminate();
      resize.disconnect();
      for (const section of sections.values()) section.mesh?.geometry.dispose();
      materials.forEach((material) => material.dispose());
      for (const id of entities.keys()) removeEntity(id);
      entityBox.dispose();
      Object.values(entityMaterials).forEach((material) => material.dispose());
      atlas?.dispose();
      renderer.dispose();
    },
    { once: true },
  );
  telemetry("loading", "관측한 지형을 불러오고 있습니다.");
  connect();
  animation = requestAnimationFrame(frame);
}
try {
  startViewer();
} catch (error) {
  const reason =
    error instanceof Error
      ? `3D 화면을 준비하지 못했습니다: ${error.message}`
      : "3D 화면을 준비하지 못했습니다.";
  const notice = document.querySelector<HTMLElement>("#notice");
  if (notice) {
    notice.hidden = false;
    notice.textContent = reason;
  }
  window.parent.postMessage(
    { type: "laya-viewer", protocolVersion: 1, status: "error", reason },
    location.origin,
  );
}
