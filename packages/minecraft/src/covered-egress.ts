import type {Bot} from 'mineflayer';
import type {Position} from '../../contracts/src';
import {HOSTILES,rangedThreat} from './combat-policy';
import {recoveryThreatsClear} from './combat-retreat';
import {observedGroundTerrainStand} from './observed-ground-walk';
import {vector,walkingFeet,position} from './observations';
import {alternateSafeWalk,walkCorner} from './safe-walk';

/** Escape along existing solid terrain behind actual cover, never toward a
 * close melee enemy. The shaft cap will be removed, so it cannot prove cover.
 * Check feet, torso and the last jump's head height independently. */
export function coveredEgressPoint(bot:Bot,feet:Position,removed:Position):boolean{
 if(!bot.world||typeof bot.world.raycast!=='function')return false;
 const p=vector(feet);
 return Object.values(bot.entities).every(e=>{
  if(!HOSTILES.has(e.name??''))return true;
  const distance=e.position.distanceTo(p.offset(.5,0,.5));
  if(distance>=20)return true;
  if(!rangedThreat(e.name??'')||distance<4||distance<12&&e.name!=='pillager')return false;
  return [.2,1,2].every(height=>{
   const eye=vector(e.position).offset(0,Math.min(e.height??1.8,1.6),0),delta=p.offset(.5,height,.5).minus(eye),length=delta.norm();
   if(length<=.1)return false;
   const hit=bot.world.raycast(eye,delta.scaled(1/length),length-.1) as unknown as {position?:Position;x?:number;y?:number;z?:number}|null;
   const q=hit?.position??hit;
   return !!q&&Number.isFinite(q.x)&&Number.isFinite(q.y)&&Number.isFinite(q.z)&&!vector(q as Position).floored().equals(vector(removed))&&bot.blockAt(vector(q as Position))?.boundingBox==='block';
  });
 });
}

export function coveredEgressRouteValid(bot:Bot,origin:Position,path:Position[]):boolean{
 if(!path.length||path.length>64||!coveredEgressPoint(bot,origin,vector(origin).offset(0,-1,0)))return false;
 const removed=vector(origin).offset(0,-1,0),stand=(p:Position)=>observedGroundTerrainStand(bot,p)&&coveredEgressPoint(bot,p,removed);
 let previous=walkingFeet(bot,origin);
 for(const value of path){
  const p=walkingFeet(bot,value);
  if(Math.hypot(p.x-origin.x,p.z-origin.z)>24||Math.abs(p.y-origin.y)>6||Math.abs(p.y-previous.y)>1||Math.hypot(p.x-previous.x,p.z-previous.z)>1.5||!stand(p)||p.x!==previous.x&&p.z!==previous.z&&!walkCorner(previous,p,stand))return false;
  previous=p;
 }
 return recoveryThreatsClear(bot,previous.offset(.5,0,.5));
}

export function planCoveredEgress(bot:Bot,origin:Position):Position[]|undefined{
 const start=walkingFeet(bot,origin),removed=start.offset(0,-1,0);
 const stand=(p:Position)=>observedGroundTerrainStand(bot,p)&&coveredEgressPoint(bot,p,removed);
 if(!stand(start)||typeof bot.pathfinder?.movements?.getNeighbors!=='function')return;
 const targets:Position[]=[],seen=new Set<string>();
 for(const radius of [8,12,16,20,24])for(let angle=0;angle<32;angle++)for(const dy of [0,1,-1,2,-2,3,-3,4,-4,5,-5,6,-6]){
  const p=start.offset(Math.round(Math.cos(angle*Math.PI/16)*radius),dy,Math.round(Math.sin(angle*Math.PI/16)*radius)),key=p.toString();
  if(Math.hypot(p.x-start.x,p.z-start.z)>24||seen.has(key)||!stand(p)||!recoveryThreatsClear(bot,p.offset(.5,0,.5)))continue;
  seen.add(key);targets.push(position(p));break;
 }
 if(!targets.length)return;
 const path=alternateSafeWalk(bot,targets,{start,within:p=>Math.hypot(p.x-start.x,p.z-start.z)<=24&&Math.abs(p.y-start.y)<=6,stand,maxNodes:8192,timeLimitMs:500,maxDrop:1});
 return path&&coveredEgressRouteValid(bot,start,path)?path:undefined;
}
