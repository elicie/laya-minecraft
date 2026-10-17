/** Project-owned read-only viewer protocol. No game commands cross this socket. */
export const VIEWER_PROTOCOL_VERSION = 1 as const;
export type ViewerPosition = { x: number; y: number; z: number };
export type ViewerFace = 'east' | 'west' | 'up' | 'down' | 'south' | 'north';
export interface ViewerUv { u: number; v: number; su: number; sv: number; }
export interface ViewerMaterial {
  stateId: number; name: string; opaque: boolean; transparent: boolean; color: number;
  shape: 'empty' | 'cube' | 'cross' | 'slab' | 'boxes';
  /** Local collision/visual bounds [x0,y0,z0,x1,y1,z1], each coordinate 0..1. */
  boxes?: number[][];
  faces?: Partial<Record<ViewerFace, ViewerUv>>;
  properties?: Record<string, string | number | boolean>;
  /** True when public collision bounds/color approximate an unsupported visual model. */
  fallback?: boolean;
}
export interface ViewerSection {
  type: 'section'; id: string; revision: number; origin: ViewerPosition; size: 16;
  /** Uint16LE palette indices, base64 encoded. Index = x + 16*(z + 16*y). */
  voxels: string; palette: ViewerMaterial[];
}
export type ViewerMessage =
  | { type: 'hello'; protocolVersion: 1; streamId: string; version: string; dimension: string; minY: number; maxY: number; viewDistance: number; sectionIds: string[]; atlasUrl?: string; atlasVersion?: string; approximate: boolean }
  | { type: 'camera'; position: ViewerPosition; yaw: number; pitch: number }
  | { type: 'entities'; entities: { id: string; name: string; position: ViewerPosition; width: number; height: number; yaw: number; kind: 'player' | 'mob' | 'object' }[] }
  | ViewerSection
  | { type: 'delta'; id: string; revision: number; position: ViewerPosition; material: ViewerMaterial }
  | { type: 'remove'; id: string }
  | { type: 'reset'; streamId: string; dimension: string }
  | { type: 'status'; queued: number; sections: number; reason: string };
