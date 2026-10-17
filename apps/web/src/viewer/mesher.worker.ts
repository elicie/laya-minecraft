import { buildMesh, type MeshSection } from "./mesh";
import type {
  ViewerMaterial,
  ViewerPosition,
} from "../../../../packages/minecraft/src/viewer-protocol";
export type MeshRequest =
  | { type: "reset"; streamId: string }
  | {
      type: "section";
      streamId: string;
      section: Omit<MeshSection, "voxels"> & { voxels: ArrayBuffer };
    }
  | {
      type: "delta";
      streamId: string;
      id: string;
      revision: number;
      position: ViewerPosition;
      material: ViewerMaterial;
    }
  | { type: "remove"; streamId: string; id: string }
  | { type: "mesh"; streamId: string; id: string; revision: number };
const sections = new Map<string, MeshSection>();
let streamId = "";
const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<MeshRequest>) => void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
worker.onmessage = ({ data }) => {
  if (data.type === "reset") {
    streamId = data.streamId;
    sections.clear();
    return;
  }
  if (data.streamId !== streamId) return;
  if (data.type === "section") {
    sections.set(data.section.id, {
      ...data.section,
      voxels: new Uint16Array(data.section.voxels),
    });
    return;
  }
  if (data.type === "remove") {
    sections.delete(data.id);
    return;
  }
  const section = sections.get(data.id);
  if (!section) return;
  if (data.type === "delta") {
    if (data.revision <= section.revision) return;
    let material = section.palette.findIndex(
      (m) => m.stateId === data.material.stateId,
    );
    if (material < 0) {
      material = section.palette.length;
      section.palette.push(data.material);
    }
    const { x, y, z } = data.position;
    section.voxels[x + 16 * (z + 16 * y)] = material;
    section.revision = data.revision;
    return;
  }
  if (data.revision !== section.revision) return;
  try {
    const result = buildMesh(section, sections);
    worker.postMessage(
      {
        type: "mesh",
        streamId,
        id: section.id,
        revision: section.revision,
        ...result,
      },
      [
        result.positions.buffer,
        result.normals.buffer,
        result.uvs.buffer,
        result.colors.buffer,
        result.opaque.buffer,
        result.transparent.buffer,
        result.untextured.buffer,
      ],
    );
  } catch (error) {
    worker.postMessage({
      type: "error",
      streamId,
      id: section.id,
      revision: section.revision,
      reason:
        error instanceof Error ? error.message : "지형을 그리지 못했습니다.",
    });
  }
};
