import {z} from 'zod';
import {PositionSchema,isBuildSiteGround,type Position} from '../../contracts/src';
import {ConditionWait,type ActionServices} from './services';
import {position,vector,walkingFeet} from './observations';
import {resourceClearance} from './resource-recovery';
import {recoveryThreatsClear} from './combat-retreat';
import {centerSupportedCell} from './standing-footprint';
import {observedGroundRoute,observedGroundStand} from './observed-ground-walk';
import {walkTripSteps} from './resource-trip';
import {coveredEgressPoint,coveredEgressRouteValid,planCoveredEgress} from './covered-egress';
import {observedGroundTerrainStand} from './observed-ground-walk';
import {HOSTILES} from './combat-policy';
import {walkCorner} from './safe-walk';

const schema=z.object({outside:PositionSchema,phase:z.enum(['digging','closed','opening','climbing','escaping','done']),dug:z.number().int().min(0).max(3),pendingCut:z.number().int().min(1).max(3).optional(),initialDirt:z.number().int().nonnegative().default(0),exitAttempts:z.number().int().min(0).max(6).default(0)});
const egressSchema=z.object({origin:PositionSchema.optional(),path:z.array(PositionSchema).min(1).max(64),walked:z.number().int().min(0).max(64).default(0)});
const soil=new Set(['dirt','grass_block']);

/** Last-resort shelter in three observed soil cells, using only their drops.
 * The original support is restored from inside by three public jump/placements.
 * No ore, falling support, protected block or unobserved floor is excavated. */
export async function restInSoilShaft(s:ActionServices,protectedPosition:(p:Position)=>boolean,enabled:()=>boolean,night:()=>boolean):Promise<boolean>{
 s.checkpoint.nightSoilShaftSearchVersion=2;
 const b=s.bot,parsed=schema.safeParse(s.checkpoint.nightSoilShaft);
 let state=parsed.success&&parsed.data.phase!=='done'?parsed.data:undefined;
 const fullNatural=(p:Position)=>{const q=b.blockAt(vector(p));return !!q&&isBuildSiteGround(q.name)&&!['sand','red_sand','gravel'].includes(q.name)&&q.shapes?.some(a=>a[0]===0&&a[1]===0&&a[2]===0&&a[3]===1&&a[4]===1&&a[5]===1);};
 const shell=(p:Position)=>[vector(p).offset(0,-4,0),...[-1,-2,-3].flatMap(dy=>[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>vector(p).offset(dx!,dy,dz!)))];
 if(!state){
  if(!enabled()||b.time?.doDaylightCycle!==true||!night()||b.health<=s.rules.combat.retreatHealth||!recoveryThreatsClear(b,b.entity.position))return false;
  for(let tick=0;tick<20&&b.entity.onGround!==true;tick++){s.check();await s.pause(50);}
  if(b.entity.onGround!==true)return false;
  const origin=walkingFeet(b),suitable=(p:Position)=>{
   const q=vector(p),cuts=[1,2,3].map(d=>q.offset(0,-d,0));
   return resourceClearance(b.blockAt(q))&&resourceClearance(b.blockAt(q.offset(0,1,0)))&&cuts.every(c=>!protectedPosition(c)&&soil.has(b.blockAt(c)?.name??'')&&fullNatural(c))&&shell(q).every(c=>!protectedPosition(c)&&fullNatural(c))&&recoveryThreatsClear(b,q)&&!Object.values(b.entities).some(e=>e.id!==b.entity.id&&(e.type==='player'||!!e.username)&&e.position.distanceTo(q.offset(.5,0,.5))<3);
  };
  let p=origin;
  if(!suitable(p)){
   const candidates=[];
   for(let dx=-8;dx<=8;dx++)for(let dz=-8;dz<=8;dz++)for(let dy=-4;dy<=4;dy++){const q=origin.offset(dx,dy,dz);if(Math.hypot(dx,dz)<=8&&suitable(q)&&observedGroundStand(b,q))candidates.push(q);}
   candidates.sort((a,c)=>a.distanceTo(origin)-c.distanceTo(origin));
   s.checkpoint.nightSoilShaftSearch={origin:position(origin),candidates:candidates.slice(0,12).map(position),observedAt:Date.now()};
   let arrived=false;
   for(const target of candidates.slice(0,12)){
    s.check();const path=observedGroundRoute(b,target,16),stand=(q:Position)=>observedGroundStand(b,q)&&recoveryThreatsClear(b,q);if(!path||path.some(q=>!stand(q)))continue;
    s.progress('야간 수직 은신처 접근','현재 흙층이 얕아 주변에서 관측한 세 칸 깊이의 흙 지면으로 이동합니다.');
    try{if(!await s.walkVerified?.(path,stand))await walkTripSteps(s,path);}
    catch(error){s.check();if(!(error instanceof ConditionWait))throw error;s.checkpoint.nightSoilShaftAccessWait=error.message;return false;}
    p=walkingFeet(b);arrived=p.equals(target)&&suitable(p);break;
   }
   if(!arrived)return false;
  }
  await centerSupportedCell(b,s);s.check();
  if(walkingFeet(b).distanceTo(p)>0||!night()||!suitable(p))return false;
  state={outside:position(p),phase:'digging',dug:0,initialDirt:b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0),exitAttempts:0};
 }
 s.checkpoint.nightSoilShaft=state;s.checkpoint.nightBurrowPending=true;
 const origin=vector(state.outside),cuts=[1,2,3].map(d=>origin.offset(0,-d,0)),cap=cuts[0]!;
 const roofIntact=()=>soil.has(b.blockAt(cap)?.name??'')&&fullNatural(cap);
 s.checkpoint.resourcePositions=[...cuts,...shell(origin)].map(position);
 const save=()=>{s.checkpoint.nightSoilShaft=state!;s.observations.push(s.observeInventory());};
 const wait=(reason:string):never=>{save();throw new ConditionWait(reason,s.checkpoint);};
 const insideColumn=()=>Math.floor(b.entity.position.x)===origin.x&&Math.floor(b.entity.position.z)===origin.z;
 const pauseUntil=async(test:()=>boolean,reason:string)=>{for(let tick=0;tick<60&&!test();tick++){s.check();await s.pause(50);}if(!test())wait(reason);};
 const escape=egressSchema.safeParse(s.checkpoint.nightSoilEgress);
 const matchingEscape=escape.success&&(escape.data.origin?vector(escape.data.origin).equals(origin):vector(escape.data.path[0]!).distanceTo(origin)<=1.5);
 let egress=escape.success&&matchingEscape?{...escape.data,origin:position(origin)}:undefined;
 if(escape.success&&!matchingEscape){
  const history=Array.isArray(s.checkpoint.nightSoilEgressHistory)?s.checkpoint.nightSoilEgressHistory:[];
  s.checkpoint.nightSoilEgressHistory=[...history,{...escape.data,observedAt:Date.now()}].slice(-8);
  delete s.checkpoint.nightSoilEgress;delete s.checkpoint.nightSoilEgressSearch;
 }
 const exitSafe=()=>recoveryThreatsClear(b,origin)||!!egress&&coveredEgressRouteValid(b,origin,egress.path);
 // Dusk starts shelter preparation early; it must not forbid a short covered
 // evacuation from an occupied exit while the world still reports daylight.
 const exitDark=()=>egress?b.time?.isDay!==true:night();
 const leaveCovered=async()=>{
  if(!egress||!enabled()||exitDark()||cuts.some(p=>!soil.has(b.blockAt(p)?.name??'')||!fullNatural(p)))wait('엄폐 탈출 전에 원래 흙 세 칸의 복원과 실제 낮·권한을 확인해야 합니다.');
  const stand=(p:Position)=>observedGroundTerrainStand(b,p)&&coveredEgressPoint(b,p,cap);
  for(let index=egress!.walked;index<egress!.path.length;index++){
   s.check();const target=egress!.path[index]!,current=walkingFeet(b);
   if(current.equals(vector(target))){egress!.walked=index+1;s.checkpoint.nightSoilEgress=egress!;continue;}
   if(!enabled()||exitDark()||!stand(current)||!stand(target)||Math.abs(current.y-target.y)>1||Math.hypot(current.x-target.x,current.z-target.z)>1.5)wait('엄폐 우회로의 현재 지면과 적 시야가 바뀌어 진행을 보존합니다.');
   const points:Position[]=[];
   if(current.x!==target.x&&current.z!==target.z){
    const corner=walkCorner(current,target,stand);if(!corner)wait('엄폐 우회 모서리의 실제 중간 지면을 확인해야 합니다.');points.push(corner!);
   }
   points.push(target);s.progress('은신처 엄폐 탈출','실제 흙벽 뒤에서 확인한 지면을 따라 적과 거리를 확보합니다.');
   for(const point of points)if(!await s.walkVerified?.([point],stand))wait('확인한 엄폐 우회로의 실제 보행을 완료해야 합니다.');
   egress!.walked=index+1;s.checkpoint.nightSoilEgress=egress!;save();
  }
  if(!recoveryThreatsClear(b,b.entity.position))wait('엄폐 우회로 끝의 실제 안전을 다시 확인해야 합니다.');
  state!.phase='done';s.checkpoint.nightBurrowPending=false;save();s.progress('은신처 엄폐 탈출 완료','원래 흙을 복원하고 실제 엄폐 우회로를 걸어 안전한 지면에 도착했습니다.');
 };
 if(state.phase==='escaping'){await leaveCovered();return true;}
 if(shell(origin).some(p=>protectedPosition(p)||!fullNatural(p))||cuts.some(protectedPosition)||!insideColumn())wait('수직 은신처의 실제 위치·지지체·옆벽과 보호 구역을 확인해야 합니다.');
 b.pathfinder.setGoal(null);b.clearControlStates();
 if(['opening','climbing'].includes(state.phase)&&enabled()&&exitDark()&&Math.abs(b.entity.position.y-(origin.y-3))<.1&&resourceClearance(b.blockAt(cap))&&b.inventory.items().some(i=>i.name==='dirt'&&i.count>0)){
  // If daylight ended before the first jump, use the recovered cap to close
  // the same room again. Do not wait all night under an already opened hole.
  try{await s.place(position(cap),'dirt','dirt');}
  catch(error){if(roofIntact()){state.phase='closed';save();}throw error;}
  if(roofIntact()){state.phase='closed';save();}
 }
 if(state.phase==='digging'){
  for(let depth=state.dug+1;depth<=3;depth++){
   s.check();if(!enabled()||!recoveryThreatsClear(b,b.entity.position))wait('임시 은신처 굴착 전에 실제 권한과 주변 위협을 확인해야 합니다.');
   const p=cuts[depth-1]!,block=b.blockAt(p);
   if(soil.has(block?.name??'')){
    if(!block||!b.canSeeBlock(block)||!b.canDigBlock(block))wait('직접 보이고 채굴 가능한 자연 흙만 은신처로 굴착합니다.');
    state.pendingCut=depth;save();s.progress('야간 수직 은신처 굴착',`관측한 자연 흙 ${depth}/3칸을 파고 실제 착지를 확인합니다.`);await b.dig(block!);
   }else if(!resourceClearance(block)||state.pendingCut!==depth)wait('보존한 은신처 굴착 위치의 실제 흙 상태가 바뀌었습니다.');
   await pauseUntil(()=>insideColumn()&&Math.abs(b.entity.position.y-p.y)<.06&&b.entity.onGround===true,'은신처의 한 칸 굴착 후 실제 착지를 확인해야 합니다.');
   state.dug=depth;delete state.pendingCut;save();
  }
  if(!roofIntact()){
   await pauseUntil(()=>b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0)>=state!.initialDirt+3,'굴착한 세 칸의 실제 흙 드롭을 모두 회수해야 입구를 막을 수 있습니다.');
   await s.pause(250);
   try{await s.place(position(cap),'dirt','dirt');}
   catch(error){if(roofIntact()){state.phase='closed';save();}throw error;}
  }
  state.phase='closed';save();
 }
 if(state.phase==='closed'){
  if(Math.abs(b.entity.position.y-(origin.y-3))>.1||!roofIntact()||!resourceClearance(b.blockAt(cuts[2]!))||!resourceClearance(b.blockAt(cuts[1]!)))wait('막은 은신처 입구와 실제 내부 위치를 확인해야 합니다.');
  s.progress('야간 수직 은신처 대기','자연 흙의 옆벽과 막은 입구 아래에서 실제 낮과 안전한 출구를 기다립니다.');
  while(exitDark()||!enabled()||!exitSafe()){
   s.check();if(!roofIntact()||shell(origin).some(p=>!fullNatural(p)))wait('막은 은신처 구조가 바뀌었습니다.');
   if(b.time?.isDay===true&&enabled()&&!recoveryThreatsClear(b,origin)){
    const fingerprint=JSON.stringify(Object.values(b.entities).filter(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(origin)<32).map(e=>[e.id,e.name,Math.floor(e.position.x),Math.floor(e.position.y),Math.floor(e.position.z)]).sort());
    if(s.checkpoint.nightSoilEgressSearch!==fingerprint){
     s.checkpoint.nightSoilEgressSearch=fingerprint;const path=planCoveredEgress(b,origin);
     if(path){egress={origin:position(origin),path,walked:0};s.checkpoint.nightSoilEgress=egress;save();continue;}
    }
   }
   await s.pause(1000);
  }
  state.phase='opening';save();
 }
 if(state.phase==='opening'){
  if(!enabled()||exitDark()||!exitSafe())wait('입구를 열기 전에 실제 낮과 엄폐 탈출 경로의 안전을 다시 확인해야 합니다.');
  const roof=b.blockAt(cap);if(roof&&soil.has(roof.name)){if(!b.canSeeBlock(roof)||!b.canDigBlock(roof))wait('자체 입구 흙의 실제 채굴 거리를 확인해야 합니다.');await b.dig(roof!);}else if(!resourceClearance(roof))wait('은신처 입구에 다른 블록이 있습니다.');
  await pauseUntil(()=>b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0)>=Math.round(origin.y-b.entity.position.y),'복원에 필요한 자체 흙 드롭을 실제로 회수해야 합니다.');
  state.phase='climbing';save();
 }
 if(state.phase==='climbing'){
  try{
   while(b.entity.position.y<origin.y-.1){
    s.check();if(!enabled()||exitDark()||!exitSafe())wait('은신처 복원 전에 낮과 실제 안전한 출구를 확인해야 합니다.');
    if(state.exitAttempts>=6)wait('은신처 복원의 실제 점프 시도를 보존하고 발판 변화를 기다립니다.');
    const feet=walkingFeet(b),support=b.blockAt(feet.offset(0,-1,0)),item=b.inventory.items().find(i=>i.name==='dirt');
    if(!insideColumn()||!support||!fullNatural(support.position)||!item||!resourceClearance(b.blockAt(feet))||!resourceClearance(b.blockAt(feet.offset(0,1,0))))wait('복원 점프의 실제 지지체·몸 공간과 소지 흙을 확인해야 합니다.');
    await b.equip(item!,'hand');await b.lookAt(feet.offset(.5,-.01,.5),true);state.exitAttempts++;save();
    s.progress('야간 수직 은신처 복원','실제 점프 중 발밑에 자체 흙을 놓아 원래 지면으로 나옵니다.');
    b.setControlState('jump',true);
    try{await pauseUntil(()=>b.entity.position.y>=feet.y+1.04,'은신처 복원 점프의 실제 높이를 확인해야 합니다.');await b.placeBlock(support!,vector({x:0,y:1,z:0}));}
    finally{b.setControlState('jump',false);}
    await pauseUntil(()=>b.entity.onGround===true&&Math.abs(b.entity.position.y-(feet.y+1))<.06&&b.blockAt(feet)?.name==='dirt','복원한 흙 위의 실제 착지를 확인해야 합니다.');save();
   }
  }finally{b.setControlState('jump',false);}
  if(!insideColumn()||cuts.some(p=>!soil.has(b.blockAt(p)?.name??'')||!fullNatural(p)))wait('자체 굴착한 세 칸의 실제 복원을 확인해야 합니다.');
  if(egress){state.phase='escaping';save();await leaveCovered();}
  else{state.phase='done';s.checkpoint.nightBurrowPending=false;save();s.progress('야간 수직 은신처 종료','실제 지면으로 나와 자체 굴착한 세 칸을 모두 흙으로 복원했습니다.');}
 }
 return true;
}
