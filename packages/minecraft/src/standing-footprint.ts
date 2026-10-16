import type { Bot } from 'mineflayer';
import type { Position } from '../../contracts/src';
import { goals } from 'mineflayer-pathfinder';
import { HOSTILES } from './combat-policy';
import { observedGroundStand } from './observed-ground-walk';
import { position, vector, walkingFeet } from './observations';
import { ConditionWait, type ActionServices } from './services';

/** Move only within the current full supported cell to release a corner that
 * caught a continuous public walk. No jump, world edit or new step is allowed. */
export async function centerSupportedCell(bot:Bot,s:ActionServices,stand?: (p:Position)=>boolean):Promise<boolean>{
  s.check();let start=vector(bot.entity.position);const feet=walkingFeet(bot),target=feet.offset(.5,0,.5);
  const footing=stand??((p:Position)=>observedGroundStand(bot,p));
  const clear=()=>stand?stand(bot.entity.position):!Object.values(bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(bot.entity.position)<20);
  const valid=()=>bot.entity.onGround===true&&Math.abs(bot.entity.position.y-feet.y)<.05&&walkingFeet(bot).equals(feet)&&footing(feet)&&clear();
  s.checkpoint.footprintCenterCheck={actual:position(start),onGround:bot.entity.onGround??null,physicsEnabled:bot.physicsEnabled??null,controls:Object.fromEntries(Object.entries(bot.controlState??{})),stand:footing(feet),clear:clear(),observedAt:Date.now()};
  if(typeof bot.lookAt!=='function'||typeof bot.setControlState!=='function'||!valid()||start.distanceTo(target)<.12)return false;
  bot.pathfinder.setGoal(null);bot.clearControlStates();await s.pause(150);s.check();if(!valid())return false;start=vector(bot.entity.position);
  await s.pause(100);if(!valid()||vector(bot.entity.position).distanceTo(start)>.02)return false;
  s.checkpoint.footprintCenter={from:position(start),target:position(target),phase:'moving',observedAt:Date.now()};
  bot.pathfinder.setGoal(null);bot.clearControlStates();
  try{
    for(let tick=0;tick<16;tick++){
      s.check();if(!valid())break;
      if(vector(bot.entity.position).distanceTo(target)<.07){bot.clearControlStates();await s.pause(100);if(valid()&&vector(bot.entity.position).distanceTo(target)<.12){s.checkpoint.footprintCenter={...s.checkpoint.footprintCenter,actual:position(bot.entity.position),phase:'complete'};return true;}continue;}
      await bot.lookAt(target.offset(0,1.62,0),true);bot.setControlState('sneak',true);bot.setControlState('forward',true);await s.pause(50);
    }
  }finally{bot.clearControlStates();}
  s.checkpoint.footprintCenter={...s.checkpoint.footprintCenter,phase:'waiting'};return false;
}

/** Center-cell quantization can miss the adjacent full block that the real
 * player's collision box is standing on. Settle only onto that same support. */
export async function settleStandingFootprint(bot:Bot,s:ActionServices,onAttempt:()=>void):Promise<boolean>{
  s.check();const actual=vector(bot.entity.position),feet=walkingFeet(bot),half=(bot.entity.width??.6)/2;
  const pending=s.checkpoint.footprintSettle;if(pending&&typeof pending==='object'&&!Array.isArray(pending)&&pending.phase==='moving')return false;
  const clear=()=>!Object.values(bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(bot.entity.position)<20);
  if(bot.entity.onGround!==true||Math.abs(actual.y-feet.y)>.05||bot.health<=s.rules.combat.retreatHealth||bot.food<=6||!clear()||observedGroundStand(bot,feet))return false;
  const candidates=[];
  for(let x=Math.floor(actual.x-half);x<=Math.floor(actual.x+half);x++)for(let z=Math.floor(actual.z-half);z<=Math.floor(actual.z+half);z++){
    if(actual.x+half<=x||actual.x-half>=x+1||actual.z+half<=z||actual.z-half>=z+1)continue;
    const p=feet.clone();p.x=x;p.z=z;
    if(bot.blockAt(p)?.boundingBox!=='empty'||bot.blockAt(p.offset(0,1,0))?.boundingBox!=='empty')return false;
    const ground=bot.blockAt(p.offset(0,-1,0));
    if(ground?.shapes.some(shape=>shape[0]===0&&shape[1]===0&&shape[2]===0&&shape[3]===1&&shape[4]===1&&shape[5]===1)&&observedGroundStand(bot,p))candidates.push(p);
  }
  if(!candidates.length||!bot.pathfinder||bot.pathfinder.movements?.canDig!==false||bot.pathfinder.movements.allow1by1towers!==false)return false;
  await s.pause(100);s.check();if(bot.entity.onGround!==true||vector(bot.entity.position).distanceTo(actual)>.02||!clear())return false;
  for(const target of candidates){
    const route=bot.pathfinder.getPathTo(bot.pathfinder.movements,new goals.GoalNear(target.x,target.y,target.z,0),100);
    if(route.status!=='success'||route.path.length!==1)continue;
    const step=route.path[0]!;
    if(step.toBreak?.length||step.toPlace?.length||step.parkour||!vector(step).floored().equals(target)||step.y!==feet.y||!observedGroundStand(bot,target))continue;
    onAttempt();s.checkpoint.footprintSettle={from:position(actual),support:position(target.offset(0,-1,0)),target:position(target),phase:'moving',observedAt:Date.now()};
    try{
      const stand=(p:{x:number;y:number;z:number})=>observedGroundStand(bot,p)&&clear();
      if(!await s.walkVerified?.([position(target)],stand))await s.near(target.offset(.5,0,.5),0);
      await s.pause(100);s.check();const landed=vector(bot.entity.position);
      if(bot.entity.onGround===true&&Math.abs(landed.y-target.y)<.05&&walkingFeet(bot).equals(target)&&stand(target)){
        await s.pause(100);s.check();if(vector(bot.entity.position).distanceTo(landed)<.08&&stand(target)){
          s.checkpoint.footprintSettle={...s.checkpoint.footprintSettle,actual:position(bot.entity.position),phase:'complete'};return true;
        }
      }
    }catch(error){s.check();if(!(error instanceof ConditionWait))throw error;}
    s.checkpoint.footprintSettle={...s.checkpoint.footprintSettle,phase:'waiting'};return false;
  }
  return false;
}
