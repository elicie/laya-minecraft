export type ItemIconKind = 'item' | 'block' | 'fallback';
export interface ItemIconEntry { x: number; y: number; kind: ItemIconKind; label: string; }
export interface InventoryIconManifest {
  schemaVersion: 1;
  minecraftVersion: string;
  source: string;
  sourcePackageVersion: string;
  tileSize: number;
  width: number;
  height: number;
  fallback: ItemIconEntry;
  items: Record<string, ItemIconEntry>;
}
export interface ItemIcon extends ItemIconEntry { src: string; size: number; atlasWidth: number; atlasHeight: number; }
