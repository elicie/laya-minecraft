import type {Block} from 'prismarine-block';

/** The observed open wooden door leaves the player's centered body clear. */
export function openDoorClearance(block:Block|null):boolean{
  return !!block&&block.name.endsWith('_door')&&block.name!=='iron_door'&&block.getProperties().open===true&&!!block.shapes?.length&&block.shapes.every(s=>s[3]!<=.2||s[0]!>=.8||s[5]!<=.2||s[2]!>=.8);
}
