import { isBuildSiteGround, type Position } from '../../contracts/src';
import { BUILD_MATERIALS } from '../../contracts/src/blueprint-catalog';
import { HOSTILES } from './combat-policy';
import { observedGroundRoute, observedGroundStand } from './observed-ground-walk';
import { position, vector, walkingFeet } from './observations';
import { walkTripSteps } from './resource-trip';
import { ConditionWait, type ActionServices } from './services';

/** Use existing loaded cover. This never digs, places or changes a door. */
export async function restUnderCover(s:ActionServices):Promise<boolean>{
  const origin=walkingFeet(s.bot),materials=new Set<string>(BUILD_MATERIALS);
  const clear=(p:Position)=>!Object.values(s.bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(vector(p))<20);
  const roof=(p:Position)=>{
    for(let dy=2;dy<=4;dy++)if([-1,0,1].every(dx=>[-1,0,1].every(dz=>{
      const b=s.bot.blockAt(vector(p).offset(dx,dy,dz));return b&&b.boundingBox==='block'&&(isBuildSiteGround(b.name)||materials.has(b.name))&&b.shapes?.some(q=>q[0]===0&&q[1]===0&&q[2]===0&&q[3]===1&&q[4]===1&&q[5]===1);
    })))return {...p,y:p.y+dy};
  };
  const candidates:Position[]=[];
  for(let dx=-16;dx<=16;dx++)for(let dz=-16;dz<=16;dz++)for(let dy=-8;dy<=2;dy++){
    if(Math.hypot(dx,dz)>16)continue;const p=origin.offset(dx,dy,dz);
    if(s.bot.blockAt(p)?.boundingBox!=='empty'||s.bot.blockAt(p.offset(0,1,0))?.boundingBox!=='empty'||!roof(p)||!observedGroundStand(s.bot,p)||!clear(p))continue;
    candidates.push(position(p));
  }
  candidates.sort((a,b)=>vector(a).distanceTo(origin)-vector(b).distanceTo(origin));
  s.checkpoint.nightShelterSearch={origin:position(origin),candidates:candidates.slice(0,8),observedAt:Date.now()};
  for(const p of candidates.slice(0,8)){
    s.check();const path=observedGroundRoute(s.bot,p,32);if(!path||path.some(q=>!clear(q)))continue;
    try{
      s.progress('야간 대기 위치','기존 지붕과 실제 보행 경로가 확인된 가까운 곳으로 이동합니다.');
      if(!await s.walkVerified?.(path,q=>observedGroundStand(s.bot,q)&&clear(q)))await walkTripSteps(s,path);
      const actual=walkingFeet(s.bot),cover=roof(actual);
      if(!actual.equals(vector(p))||!cover||!observedGroundStand(s.bot,actual)||!clear(actual))continue;
      s.checkpoint.nightShelter={position:position(actual),roof:cover,observedAt:Date.now()};return true;
    }catch(error){s.check();if(!(error instanceof ConditionWait))throw error;}
  }
  return false;
}
