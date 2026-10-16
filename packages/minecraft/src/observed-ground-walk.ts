import type { Bot } from 'mineflayer';
import { goals, Movements } from 'mineflayer-pathfinder';
import { isBuildSiteGround, type Position } from '../../contracts/src';
import { BUILD_MATERIALS } from '../../contracts/src/blueprint-catalog';
import { position, vector, walkingFeet } from './observations';
import { resourceClearance } from './resource-recovery';
import { alternateSafeWalk, walkCorner } from './safe-walk';
import { HOSTILES } from './combat-policy';
import { openDoorClearance } from './open-door';

const existingFloors=new Set<string>([...BUILD_MATERIALS,'crafting_table','furnace']);
const hazards=new Set(['water','lava','fire','soul_fire','magma_block','cactus','campfire','soul_campfire','powder_snow','sweet_berry_bush']);
const walkOnlyPlants=new Set(['dandelion','poppy','blue_orchid','allium','azure_bluet','red_tulip','orange_tulip','white_tulip','pink_tulip','oxeye_daisy','cornflower','lily_of_the_valley','sunflower','lilac','rose_bush','peony','wildflowers','pink_petals']);
const clearance=(b:ReturnType<Bot['blockAt']>)=>resourceClearance(b)||openDoorClearance(b)||!!b&&b.boundingBox==='empty'&&walkOnlyPlants.has(b.name);

/** A loaded, solid natural support permits a verified walk along an edge.
 * This never licenses an unobserved step, a large drop, digging or placement. */
export function observedGroundTerrainStand(bot: Bot, feet: Position, onReject?: (p:Position,reason:string)=>void,allowAdjacentWater=false): boolean {
  const p=walkingFeet(bot,feet);
  for(const q of [p,p.offset(0,1,0)])if(!clearance(bot.blockAt(q))){onReject?.(position(q),`몸 공간 ${bot.blockAt(q)?.name??'unloaded'}`);return false;}
  const support=p.offset(0,-1,0),block=bot.blockAt(support);
  const fullFloor=block&&(existingFloors.has(block.name)||block.name.endsWith('_ore'))&&block.shapes?.some(s=>s[0]===0&&s[1]===0&&s[2]===0&&s[3]===1&&s[4]===1&&s[5]===1);
  let shoreFloor=false;
  if(allowAdjacentWater&&block&&['sand','red_sand','farmland'].includes(block.name)){
    for(let depth=1;depth<=4;depth++){const below=bot.blockAt(support.offset(0,-depth,0));if(!below||below.boundingBox!=='block'||hazards.has(below.name))break;if(!['sand','red_sand'].includes(below.name)){shoreFloor=isBuildSiteGround(below.name)||existingFloors.has(below.name);break;}}
  }
  if(!block||block.boundingBox!=='block'||!isBuildSiteGround(block.name)&&!fullFloor&&!shoreFloor){
    onReject?.(position(support),`실제 지지 발판 ${block?.name??'unloaded'}`);return false;
  }
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [0,-1]){const name=bot.blockAt(p.offset(dx!,dy,dz!))?.name??'';if(hazards.has(name)&&!(allowAdjacentWater&&name==='water'))return false;}
  return true;
}

export function observedGroundStand(bot: Bot, feet: Position, onReject?: (p:Position,reason:string)=>void,allowAdjacentWater=false): boolean {
  const p=walkingFeet(bot,feet);
  return observedGroundTerrainStand(bot,p,onReject,allowAdjacentWater)&&!Object.values(bot.entities??{}).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(p.offset(.5,0,.5))<12);
}

export function observedGroundRoute(bot: Bot, destination: Position, radius=128,onReject?: (p:Position,reason:string)=>void,allowAdjacentWater=false,blocked?:(p:Position)=>boolean): Position[]|undefined {
  const start=walkingFeet(bot),target=walkingFeet(bot,destination),pf=bot.pathfinder;
  const within=(p:Position)=>Math.hypot(p.x-start.x,p.z-start.z)<=radius&&Math.abs(p.y-start.y)<=16;
  const stand=(p:Position)=>!blocked?.(p)&&observedGroundStand(bot,p,onReject,allowAdjacentWater);
  if(!stand(start)||!within(target)||!stand(target)
    ||!pf||typeof pf.getPathTo!=='function'||pf.movements?.canDig!==false||pf.movements.allow1by1towers!==false)return;
  const alternate=()=>alternateSafeWalk(bot,target,{within,stand,maxDrop:allowAdjacentWater?2:1,...(allowAdjacentWater?{timeLimitMs:500,maxNodes:16384}:{})});
  // One synchronous planning pass repeatedly asks about the same foot/head
  // columns. Cache only that pass; route validation and execution reobserve.
  const observed=new Map<string,boolean>();
  const planningStand=(p:Position)=>{const key=`${p.x},${p.y},${p.z}`;if(!observed.has(key))observed.set(key,stand(p));return observed.get(key)!;};
  let movements=pf.movements;
  if(bot.registry&&typeof movements.exclusionStep==='function'&&movements.blocksToAvoid){
    const original=movements,next=new Movements(bot);
    next.canDig=false;next.allow1by1towers=false;next.allowParkour=false;next.maxDropDown=2;next.infiniteLiquidDropdownDistance=false;next.scafoldingBlocks=[];
    next.blocksToAvoid=new Set([...next.blocksToAvoid,...original.blocksToAvoid]);
    next.exclusionAreasStep=[block=>[0,-1,-2].some(dy=>planningStand(block.position.offset(0,dy,0)))?original.exclusionStep(block):100];
    movements=next;
  }
  const tolerance=bot.blockAt(target.offset(0,-1,0))?.name==='farmland'?.1:0;
  const result=pf.getPathTo(movements,new goals.GoalNear(target.x,target.y,target.z,tolerance),200);
  if(result.status!=='success'||result.path.length>256){onReject?.(position(target),`공개 경로 ${result.status} (${result.path.length}칸)`);return alternate();}
  let previous=start;const path:Position[]=[];
  for(const move of result.path){
    const p=walkingFeet(bot,move);
    if(!within(p)||move.toBreak?.length||move.toPlace?.length||move.parkour||p.y-previous.y>1||previous.y-p.y>(allowAdjacentWater?2:1)
      ||Math.hypot(p.x-previous.x,p.z-previous.z)>1.5||!stand(p))return alternate();
    if(p.x!==previous.x&&p.z!==previous.z&&!walkCorner(previous,p,q=>within(q)&&stand(q)))return alternate();
    previous=p;path.push(position(p));
  }
  return previous.equals(target)?path:alternate();
}

/** Choose a real standing cell within a public GoalNear tolerance. The goal
 * itself can be occupied by a new floor or fixture; the route cannot. */
export function observedGroundApproach(bot:Bot,destination:Position,tolerance=0,allowAdjacentWater=false,blocked?:(p:Position)=>boolean):Position[]|undefined {
  if(tolerance===0)return observedGroundRoute(bot,destination,128,undefined,allowAdjacentWater,blocked);
  if(tolerance<0||tolerance>4)return;
  const target=walkingFeet(bot,destination),current=walkingFeet(bot),candidates:Position[]=[];
  for(let x=-Math.ceil(tolerance);x<=Math.ceil(tolerance);x++)for(let y=-Math.ceil(tolerance);y<=Math.ceil(tolerance);y++)for(let z=-Math.ceil(tolerance);z<=Math.ceil(tolerance);z++){
    const p=target.offset(x,y,z);
    if(p.distanceTo(target)<=tolerance&&!blocked?.(p)&&observedGroundStand(bot,p,undefined,allowAdjacentWater))candidates.push(position(p));
  }
  candidates.sort((a,b)=>vector(a).distanceTo(current)-vector(b).distanceTo(current));
  for(const p of candidates.slice(0,12)){const route=observedGroundRoute(bot,p,128,undefined,allowAdjacentWater,blocked);if(route)return route;}
}
