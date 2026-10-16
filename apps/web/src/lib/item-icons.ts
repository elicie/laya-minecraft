import generated from './inventory-atlas.json';
import type { InventoryIconManifest, ItemIcon } from './item-icons.types';
export type { InventoryIconManifest, ItemIcon, ItemIconKind } from './item-icons.types';

const atlas: InventoryIconManifest = generated as InventoryIconManifest;
export const INVENTORY_ATLAS_SOURCE = '/inventory-atlas.png';

/** Local, prebuilt assets only; this never requests a viewer or remote metadata. */
export function getItemIcon(name: string | undefined | null): ItemIcon {
  const entry = name && Object.hasOwn(atlas.items, name) ? atlas.items[name]! : { ...atlas.fallback, label: name || atlas.fallback.label };
  return { ...entry, src: INVENTORY_ATLAS_SOURCE, size: atlas.tileSize, atlasWidth: atlas.width, atlasHeight: atlas.height };
}

export function itemIconStyle(name: string | undefined | null, size = 32) {
  const icon = getItemIcon(name), scale = size / icon.size;
  return { width: size, height: size, backgroundImage: `url(${icon.src})`, backgroundRepeat: 'no-repeat',
    backgroundSize: `${icon.atlasWidth * scale}px ${icon.atlasHeight * scale}px`,
    backgroundPosition: `${-icon.x * scale}px ${-icon.y * scale}px`, imageRendering: 'pixelated' as const };
}
