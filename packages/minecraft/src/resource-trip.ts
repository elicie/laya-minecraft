import { z } from 'zod';
import { PositionSchema, type JsonObject, type Position } from '../../contracts/src';
import { ConditionWait, type ActionServices } from './services';
import { observationBase, position, vector, walkingFeet } from './observations';
import { safeResourceRoute, safeResourceStand } from './resource-recovery';
import { HOSTILES } from './combat-policy';
import { observedGroundRoute, observedGroundStand } from './observed-ground-walk';
import { centerSupportedCell, settleStandingFootprint } from './standing-footprint';
import { walkCorner } from './safe-walk';
import {settleWarehouseThreshold} from './base-threshold';

const cell = PositionSchema.refine(p => Object.values(p).every(Number.isInteger));
const schema = z.object({ item: z.string(), minimum: z.number().int().positive(), home: cell, trail: z.array(cell).min(1).max(512), phase: z.enum(['outbound','returning','complete']), deathId: z.string().optional(), returns: z.number().int().nonnegative().default(0), failure: z.string().max(2000).optional(), completedAt: z.number().int().nonnegative().optional() });
const approachSchema=z.object({id:z.string(),origin:cell,target:cell,moves:z.number().int().min(0).max(256),elapsedMs:z.number().nonnegative(),legs:z.array(z.object({from:cell,to:cell,steps:z.number().int().positive(),observedAt:z.number()})).max(256),maxMoves:z.number().int().min(12).max(256).optional(),maxElapsedMs:z.number().int().min(60000).max(900000).optional()});
export type ResourceTrip = z.infer<typeof schema>;
export function resourceTrip(checkpoint: JsonObject): ResourceTrip | undefined { const parsed = schema.safeParse(checkpoint.resourceTrip); return parsed.success ? parsed.data : undefined; }
function save(s: ActionServices, trip: ResourceTrip) { s.checkpoint.resourceTrip = trip as unknown as JsonObject; }
function clear(s: ActionServices, p: Position) { return !Object.values(s.bot.entities).some(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(vector(p)) < 12); }
function archiveInterruptedLife(s:ActionServices,trip:ResourceTrip,nextDeathId:string){
  const prior=Array.isArray(s.checkpoint.resourceTripInterruptedLives)?s.checkpoint.resourceTripInterruptedLives:[];
  s.checkpoint.resourceTripInterruptedLives=[...prior,{...structuredClone(trip),nextDeathId,observedAt:Date.now()}].slice(-4);
}
function repairMissingHome(s:ActionServices,trip:ResourceTrip):void {
  const original=trip.home,body=s.bot.blockAt(vector(original)),head=s.bot.blockAt(vector(original).offset(0,1,0)),support=s.bot.blockAt(vector(original).offset(0,-1,0));
  // Unknown chunks and nearby enemies do not authorize moving a work point.
  // A changed, actually observed support/body column does; the building's
  // pinned origin and full completion conditions are never changed here.
  if(!body||!head||!support||support.boundingBox==='block'&&body.boundingBox==='empty'&&head.boundingBox==='empty')return;
  const area=s.checkpoint.buildProtection as {origin?:Position;width?:number;depth?:number}|undefined;
  const candidates:Position[]=[];
  for(let dx=-6;dx<=6;dx++)for(let dz=-6;dz<=6;dz++)for(const dy of [0,1,-1,2,-2]){
    if(Math.hypot(dx,dz)>6||!dx&&!dy&&!dz)continue;
    const p={x:original.x+dx,y:original.y+dy,z:original.z+dz};
    if(area?.origin&&typeof area.width==='number'&&typeof area.depth==='number'&&p.x>=area.origin.x&&p.x<area.origin.x+area.width&&p.z>=area.origin.z&&p.z<area.origin.z+area.depth)continue;
    if(safeResourceStand(s.bot,p,()=>false)&&clear(s,p))candidates.push(p);
  }
  candidates.sort((a,b)=>Math.abs(a.y-original.y)-Math.abs(b.y-original.y)||vector(a).distanceTo(vector(original))-vector(b).distanceTo(vector(original)));
  s.checkpoint.resourceTripHomeSearch={origin:{...original},candidates:candidates.slice(0,12),observedAt:Date.now()};
  for(const target of candidates.slice(0,12)){
    if((safeResourceRoute(s.bot,target)??observedGroundRoute(s.bot,target,128))===undefined)continue;
    const saved=Array.isArray(s.checkpoint.resourceTripHomeRelocations)?s.checkpoint.resourceTripHomeRelocations:[];
    s.checkpoint.resourceTripHomeRelocations=[...saved,{from:{...original},to:{...target},observedAt:Date.now(),reason:'기존 귀환 발판의 실제 지지 블록이나 몸 공간이 바뀌었습니다.'}].slice(-8);
    trip.home=target;
    if(trip.trail[0]&&vector(trip.trail[0]).equals(vector(original)))trip.trail[0]={...target};
    save(s,trip);return;
  }
}
async function stableFeet(s: ActionServices, verifiedReturn=false): Promise<Position> {
  const stand=(p:Position)=>safeResourceStand(s.bot,p,()=>false)||verifiedReturn&&observedGroundStand(s.bot,p);
  for (let i=0;i<20;i++) {
    s.check(); const actual=vector(s.bot.entity.position), feet=walkingFeet(s.bot);
    if(i===0&&!stand(feet)&&await settleStandingFootprint(s.bot,s,()=>{s.checkpoint.resourceFootprintAdjustments=Number(s.checkpoint.resourceFootprintAdjustments??0)+1;}))continue;
    if (Math.abs(actual.y-feet.y)<0.1 && stand(feet) && clear(s,feet)) {
      await s.pause(50); const fresh=vector(s.bot.entity.position);
      if (fresh.distanceTo(actual)<0.08 && Math.abs(fresh.y-feet.y)<0.1 && stand(feet) && clear(s,feet)) return position(feet);
    } else await s.pause(50);
  }
  const feet=walkingFeet(s.bot);
  s.checkpoint.resourceFootingObservation={actual:position(s.bot.entity.position),feet:position(feet),observedAt:Date.now(),
    columns:[[0,0],[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({position:position(feet.offset(dx!,0,dz!)),blocks:[-2,-1,0,1].map(dy=>{const b=s.bot.blockAt(feet.offset(dx!,dy,dz!));return{name:b?.name??'unloaded',boundingBox:b?.boundingBox??'unknown'};})})),
    threats:Object.values(s.bot.entities).filter(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(feet)<20).map(e=>({name:e.name??'unknown',position:position(e.position)}))};
  const positions=[[0,0],[1,0],[-1,0],[0,1],[0,-1]].flatMap(([dx,dz])=>[-2,-1,0,1].map(dy=>position(feet.offset(dx!,dy,dz!))));
  s.checkpoint.resourceFootingWaitVersion=1;s.checkpoint.waitingFor={kind:'blocks',causeCode:'BUILD_ACCESS',positions,watchPosition:true,watchSafety:true};
  s.observations.push({...observationBase(s.rules.world,s.rules.dimension),kind:'blocks',data:{blocks:positions.flatMap(p=>{const b=s.bot.blockAt(vector(p));return b?[{position:p,name:b.name}]:[];})}});
  throw new ConditionWait('원정의 실제 지지 발판·착지와 주변 위협을 확인해야 합니다.',s.checkpoint);
}
export async function walkTripSteps(s:ActionServices,path:Position[],near:(p:Position)=>Promise<void>=p=>s.near(p,0),afterStep?:()=>Promise<void>):Promise<void>{
  const stand=(p:Position)=>(safeResourceStand(s.bot,p,()=>false)||observedGroundStand(s.bot,p))&&clear(s,p);
  let direction:string|undefined;
  for(const step of path){
    s.check();if(!stand(step))throw new ConditionWait('복귀 중 실제 지형이나 위협이 바뀌었습니다.',s.checkpoint);
    const current=walkingFeet(s.bot);
    const nextDirection=`${Math.sign(step.x-current.x)},${Math.sign(step.z-current.z)}`;
    if(direction!==nextDirection)await centerSupportedCell(s.bot,s);
    if(current.x!==step.x&&current.z!==step.z){
      const corner=walkCorner(current,step,stand);
      if(!corner)throw new ConditionWait('모서리에서 몸이 통과할 실제 중간 발판을 확인해야 합니다.',s.checkpoint);
      await near(position(vector(corner).offset(.5,0,.5)));await stableFeet(s,true);await centerSupportedCell(s.bot,s);await afterStep?.();
    }
    const before=walkingFeet(s.bot);await near(position(vector(step).offset(.5,0,.5)));await stableFeet(s,true);await afterStep?.();
    direction=`${Math.sign(step.x-before.x)},${Math.sign(step.z-before.z)}`;
  }
}
async function walkTripPath(s:ActionServices,path:Position[],beforeSegment?:()=>void,afterSegment?:(from:Position,to:Position,steps:number)=>void,stepsOnly=false,segmentSize:8|24=24):Promise<void>{
  const stand=(p:Position)=>(safeResourceStand(s.bot,p,()=>false)||observedGroundStand(s.bot,p))&&clear(s,p);
  for(let offset=0;offset<path.length;offset+=segmentSize){
    beforeSegment?.();const segment=path.slice(offset,offset+segmentSize),from=position(walkingFeet(s.bot));
    if(stepsOnly||!await s.walkVerified?.(segment,stand))await walkTripSteps(s,segment);
    const arrived=await stableFeet(s,true);afterSegment?.(from,arrived,segment.length);
  }
}

/** A new body can be beyond the server's view distance. Walk only fully
 * observed short legs toward the saved work point, then inspect its new chunk. */
async function approachUnloadedHome(s:ActionServices,trip:Pick<ResourceTrip,'home'|'returns'>,lifeId:string):Promise<void>{
  // Seeing only the destination column does not prove the intervening route.
  // Get close enough to reobserve its surroundings when direct proof failed.
  const loaded=()=>vector(s.bot.entity.position).distanceTo(vector(trip.home))<=32&&[vector(trip.home),vector(trip.home).offset(0,-1,0),vector(trip.home).offset(0,1,0)].every(p=>!!s.bot.blockAt(p));
  if(loaded())return;
  const id=`${lifeId}:${trip.returns}`,parsed=approachSchema.safeParse(s.checkpoint.resourceTripApproach);
  const state:z.infer<typeof approachSchema>=parsed.success&&parsed.data.id===id?parsed.data:{id,origin:position(walkingFeet(s.bot)),target:{...trip.home},moves:0,elapsedMs:0,legs:[]};
  // Pin the allowance to the first observed displacement, including legacy
  // records. Restarts retain both the original distance and all spent work.
  const distance=vector(state.origin).distanceTo(vector(state.target));
  state.maxMoves??=Math.max(12,Math.min(256,Math.ceil(distance/16)+6));
  state.maxElapsedMs??=Math.max(60000,Math.min(900000,Math.ceil(distance/2)*1000+60000));
  s.checkpoint.resourceTripApproach=state as unknown as JsonObject;
  const started=Date.now(),budget=()=>{s.check();if(state.moves>=state.maxMoves!||state.elapsedMs+Date.now()-started>=state.maxElapsedMs!)throw new ConditionWait('작업 지점 재관측의 남은 실제 이동 예산과 지형을 확인해야 합니다.',s.checkpoint);};
  const sector=(p:Position)=>`${Math.floor(p.x/8)},${Math.floor(p.y/4)},${Math.floor(p.z/8)}`;
  try{
    while(!loaded()){
      budget();await stableFeet(s,true);const current=walkingFeet(s.bot),distance=vector(trip.home).distanceTo(current),visited=new Set([state.origin,...state.legs.map(l=>l.to)].map(sector)),candidates:Position[]=[];
      for(const radius of [24,16,8])for(let angle=0;angle<16;angle++)for(const dy of [0,1,-1,2,-2,3,-3,4,-4,5,-5,6,-6,7,-7,8,-8]){
        const p=current.offset(Math.round(Math.cos(angle*Math.PI/8)*radius),dy,Math.round(Math.sin(angle*Math.PI/8)*radius));
        if(visited.has(sector(p))||p.distanceTo(vector(trip.home))>distance+4||!(safeResourceStand(s.bot,p,()=>false)||observedGroundStand(s.bot,p))||!clear(s,p))continue;
        candidates.push(position(p));break;
      }
      candidates.sort((a,b)=>vector(a).distanceTo(vector(trip.home))-vector(b).distanceTo(vector(trip.home)));
      let moved=false;
      for(const target of candidates.slice(0,16)){
        budget();const within=(p:Position)=>Math.hypot(p.x-current.x,p.z-current.z)<=32&&Math.abs(p.y-current.y)<=16;
        const path=safeResourceRoute(s.bot,target,{within,clear:p=>clear(s,p)})??observedGroundRoute(s.bot,target,32);
        if(!path?.length)continue;
        s.progress('귀환 경로 관측','작업 지점 방향의 실제 지면으로 이동하며 아직 보이지 않는 귀환 구간을 확인합니다.');
        await walkTripPath(s,path,budget,(from,to,steps)=>{state.moves++;state.legs.push({from,to,steps,observedAt:Date.now()});s.progress('귀환 경로 관측',`안전하게 도착한 ${state.moves}개 구간을 보존하고 작업 지점 관측을 이어갑니다.`);});
        moved=true;await s.pause(150);break;
      }
      if(!moved)throw new ConditionWait('아직 보이지 않는 작업 지점 방향에서 실제로 걸을 수 있는 다음 지면을 확인해야 합니다.',s.checkpoint);
    }
  }finally{state.elapsedMs+=Math.max(0,Date.now()-started);}
}

/** A registered base is a destination, not an invented previously walked trail. */
export async function approachKnownBase(s:ActionServices,home:Position):Promise<void>{
  const target=position(vector(home).floored());
  await approachUnloadedHome(s,{home:target,returns:0},`warehouse:${s.rules.world}:${s.rules.dimension}:${target.x},${target.y},${target.z}`);
}
export async function beginResourceTrip(s: ActionServices, item: string, minimum: number, destination?: Position): Promise<ResourceTrip> {
  const saved=resourceTrip(s.checkpoint);
  if(saved&&saved.phase!=='complete'&&(saved.item!==item||saved.minimum!==minimum))throw new ConditionWait('미완료 원정의 복귀와 재료 요청을 먼저 확인해야 합니다.',s.checkpoint);
  s.checkpoint.resourceDepartureVersion=1;
  await settleWarehouseThreshold(s);
  try { await stableFeet(s,s.checkpoint.materialExpedition===true&&s.bot.health>s.rules.combat.retreatHealth&&s.bot.food>6); }
  catch(error) {
    s.check();
    if(!(error instanceof ConditionWait)||!observedGroundStand(s.bot,s.bot.entity.position)||s.bot.health<=s.rules.combat.retreatHealth||s.bot.food<=6)throw error;
    const from=position(walkingFeet(s.bot)),candidates:Position[]=[];
    for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(const dy of [0,1,-1]){
      const p={x:from.x+dx,y:from.y+dy,z:from.z+dz};
      if(Math.hypot(dx,dz)>3||!safeResourceStand(s.bot,p,()=>false)||!clear(s,p))continue;
      candidates.push(p);
    }
    candidates.sort((a,b)=>vector(a).distanceTo(vector(from))-vector(b).distanceTo(vector(from)));
    let settled=false;
    for(const target of candidates.slice(0,12)){
      const route=observedGroundRoute(s.bot,target,6);if(!route)continue;
      s.progress('원정 출발', '기존 발판에서 가까운 안전한 지면으로 이동한 뒤 재료 원정을 시작합니다.');
      const stand=(p:Position)=>observedGroundStand(s.bot,p)&&clear(s,p);
      if(!await s.walkVerified?.(route,stand))for(const step of route){s.check();if(!stand(step))throw error;await s.near(vector(step).offset(.5,0,.5),0);}
      await stableFeet(s);
      s.checkpoint.resourceDeparture={from,to:position(walkingFeet(s.bot)),observedAt:Date.now()};settled=true;break;
    }
    if(!settled)throw error;
  }
  const home = walkingFeet(s.bot,destination ?? s.bot.entity.position);
  if(saved?.phase==='complete'&&walkingFeet(s.bot).distanceTo(vector(saved.home))<=1.5)recenterAfterReturn(s,saved.home);
  const deathId=typeof s.checkpoint.confirmedRecoveryDeathId==='string'?s.checkpoint.confirmedRecoveryDeathId:undefined;
  if (saved && saved.phase!=='complete') {
    if (saved.deathId!==deathId && deathId) {
      if ((safeResourceRoute(s.bot,saved.home,{clear:()=>true})??observedGroundRoute(s.bot,saved.home,48))===undefined) throw new ConditionWait('새 생존 위치와 기존 작업 지점의 지형 연결을 먼저 확인해야 합니다.',s.checkpoint);
      archiveInterruptedLife(s,saved,deathId);
      saved.trail=[saved.home]; saved.deathId=deathId; saved.phase='outbound'; delete saved.failure; delete saved.completedAt;
      save(s,saved); await recordResourceTripPosition(s,true); return resourceTrip(s.checkpoint)!;
    }
    return saved;
  }
  if (!(safeResourceStand(s.bot,home,()=>false)||observedGroundStand(s.bot,home)) || (safeResourceRoute(s.bot,home,{clear:()=>true})??observedGroundRoute(s.bot,home,128))===undefined) throw new ConditionWait('재료를 구한 뒤 돌아올 실제 작업 발판과 지형 연결이 필요합니다.',s.checkpoint);
  const trip: ResourceTrip={item,minimum,home:position(home),trail:[position(home)],phase:'outbound',...(deathId?{deathId}:{}),returns:saved?.returns??0};
  save(s,trip); await recordResourceTripPosition(s,true); return resourceTrip(s.checkpoint)!;
}
export async function recordResourceTripPosition(s: ActionServices, verifiedWalk=false): Promise<void> {
  const trip=resourceTrip(s.checkpoint); if (!trip || trip.phase!=='outbound') return;
  const actual=await stableFeet(s,verifiedWalk), previous=trip.trail.at(-1)!;
  if (vector(actual).equals(vector(previous))) return;
  if ((safeResourceRoute(s.bot,previous,{clear:()=>true})??(verifiedWalk?observedGroundRoute(s.bot,previous,48):undefined))===undefined){trip.phase='returning';trip.failure='실제 이동한 위치에서 이전 복귀 발판까지 안전한 연결이 필요합니다.';save(s,trip);throw new ConditionWait(trip.failure,s.checkpoint);}
  const revisited=trip.trail.findIndex(p=>vector(p).equals(vector(actual)));
  if (revisited>=0) trip.trail=trip.trail.slice(0,revisited+1);
  else if (Math.hypot(actual.x-previous.x,actual.z-previous.z)<8 && Math.abs(actual.y-previous.y)<3) return;
  else { if (trip.trail.length>=512) throw new ConditionWait('복귀 경로 512구간 기록을 보존하고 원정을 중단합니다.',s.checkpoint); trip.trail.push(actual); }
  save(s,trip);
}
function recenterAfterReturn(s: ActionServices, home: Position) {
  const records=s.checkpoint.resourceRecovery;
  if (!records || typeof records!=='object' || Array.isArray(records)) return;
  for (const value of Object.values(records)) {
    if (!value || typeof value!=='object' || Array.isArray(value)) continue;
    const journey=value.resourceJourney;
    if (journey && typeof journey==='object' && !Array.isArray(journey)) {
      const old=PositionSchema.safeParse(journey.center);
      if (old.success && journey.status!=='paused' && typeof value.reason==='string' && value.reason.includes('마지막 도착 위치와 현재 위치 사이의 안전한 연결')) {
        if(vector(old.data).distanceTo(vector(home))>3){journey.displacements=[...(Array.isArray(journey.displacements)?journey.displacements:[]),{from:old.data,to:{...home}}].slice(-16);journey.displacementCount=Number(journey.displacementCount??0)+1;}
        journey.status='searching';value.status='searching';value.reason='실제 원정 경로로 복귀한 작업 지점에서 탐색을 이어갑니다.';
      }
      journey.center={...home}; journey.pending=false;
      const visited=Array.isArray(journey.visited)?journey.visited:[],last=PositionSchema.safeParse(visited.at(-1));
      if(!last.success||!vector(last.data).equals(vector(home)))journey.visited=[...visited,{...home}].slice(-512);
    }
  }
}
export async function returnFromResourceTrip(s: ActionServices, stepsOnly=false): Promise<void> {
  const trip=resourceTrip(s.checkpoint); if (!trip) return;
  // Older checkpoints may have discarded the source trail before a shortcut
  // actually moved. Restore that recorded trail, preserving all spent budgets.
  const shortcuts=Array.isArray(s.checkpoint.resourceTripShortcuts)?s.checkpoint.resourceTripShortcuts:[],failure=s.checkpoint.returnMovementFailure as JsonObject|undefined;
  if(failure)for(let i=shortcuts.length-1;i>=0;i--){
    const entry=shortcuts[i] as JsonObject,target=PositionSchema.safeParse(entry.target),from=PositionSchema.safeParse(entry.from),skipped=PositionSchema.array().safeParse(entry.skippedWaypoints);
    if(entry.arrivalVerified===true||!target.success||!from.success||!skipped.success||!trip.trail.at(-1)||!vector(trip.trail.at(-1)!).equals(vector(target.data))||vector(s.bot.entity.position).distanceTo(vector(from.data))>3||Number(failure.observedAt)<Number(entry.observedAt))continue;
    trip.trail.push(...skipped.data);const history=Array.isArray(s.checkpoint.resourceTripShortcutRepairs)?s.checkpoint.resourceTripShortcutRepairs:[];
    s.checkpoint.resourceTripShortcutRepairs=[...history,{target:target.data,restoredWaypoints:skipped.data.length,observedAt:Date.now()}].slice(-4);save(s,trip);
  }
  s.checkpoint.resourceReturnVersion=1;
  s.checkpoint.resourceTripReconcileVersion=1;
  trip.phase='returning'; save(s,trip);
  try {
  const deathId=typeof s.checkpoint.confirmedRecoveryDeathId==='string'?s.checkpoint.confirmedRecoveryDeathId:undefined;
  const previousLife=deathId&&trip.deathId!==deathId?structuredClone(trip):undefined;
  if(previousLife){s.checkpoint.resourceTripReconcile={deathId:deathId!,home:trip.home};if(observedGroundRoute(s.bot,trip.home,128)===undefined)await approachUnloadedHome(s,trip,deathId!);}
  repairMissingHome(s,trip);
  if(deathId&&trip.deathId!==deathId){
    if((safeResourceRoute(s.bot,trip.home)??observedGroundRoute(s.bot,trip.home,128,(p,reason)=>{s.checkpoint.resourceTripReconcileFailure={position:p,reason,observedAt:Date.now()};}))===undefined){s.checkpoint.resourceTripReconcile={deathId,home:trip.home};throw new ConditionWait('새 생존 위치에서 기존 작업 지점까지 실제 지면 연결을 먼저 확인해야 합니다.',s.checkpoint);}
    archiveInterruptedLife(s,previousLife??trip,deathId);trip.trail=[{...trip.home}];trip.deathId=deathId;delete s.checkpoint.resourceTripReconcile;delete s.checkpoint.resourceTripReconcileFailure;save(s,trip);
  }
  if(!previousLife&&walkingFeet(s.bot).distanceTo(vector(trip.trail.at(-1)??trip.home))>48&&(safeResourceRoute(s.bot,trip.trail.at(-1)??trip.home)??observedGroundRoute(s.bot,trip.trail.at(-1)??trip.home,128))===undefined){
    const from=position(walkingFeet(s.bot)),prior=structuredClone(trip);
    s.checkpoint.resourceTripReconcile={deathId:deathId??'displaced',home:trip.home,from,cause:'same-life-displacement'};
    if(observedGroundRoute(s.bot,trip.home,128)===undefined)await approachUnloadedHome(s,trip,`displaced:${deathId??'unknown'}`);
    repairMissingHome(s,trip);
    if((safeResourceRoute(s.bot,trip.home)??observedGroundRoute(s.bot,trip.home,128))===undefined)throw new ConditionWait('식량 확보·퇴각 이후 현재 몸에서 작업 지점까지 실제 복귀 연결을 확인해야 합니다.',s.checkpoint);
    const saved=Array.isArray(s.checkpoint.resourceTripDisplacements)?s.checkpoint.resourceTripDisplacements:[];
    s.checkpoint.resourceTripDisplacements=[...saved,{from,reconnectedAt:position(walkingFeet(s.bot)),home:{...trip.home},previousTrip:prior,observedAt:Date.now()}].slice(-4);
    trip.trail=[{...trip.home}];delete s.checkpoint.resourceTripReconcile;save(s,trip);
  }
  while (trip.trail.length) {
    s.check(); let destination=trip.trail.at(-1)!;
    await stableFeet(s,true);
    // Saved stands can lose their supports during our later mining. A fully
    // observed connection to an earlier waypoint supersedes those stands;
    // their old coordinates are history, not required physical destinations.
    const last=trip.trail.length-1,current=walkingFeet(s.bot);
    const candidates=[...trip.trail.keys()].filter(i=>vector(trip.trail[i]!).distanceTo(current)<=128&&(observedGroundStand(s.bot,trip.trail[i]!)||safeResourceStand(s.bot,trip.trail[i]!,()=>false))).sort((a,b)=>vector(trip.trail[a]!).distanceTo(current)-vector(trip.trail[b]!).distanceTo(current)).slice(0,12);
    let path:Position[]|undefined,selected=last;
    for(const index of candidates){
      const target=trip.trail[index]!;
      if(!observedGroundStand(s.bot,target)&&!safeResourceStand(s.bot,target,()=>false))continue;
      const rejected:{position:Position;reason:string}[]=[];
      const route=safeResourceRoute(s.bot,target)??observedGroundRoute(s.bot,target,128,(p,reason)=>{if(rejected.length<8)rejected.push({position:p,reason});});
      const m=s.bot.pathfinder.movements;
      s.checkpoint.resourceReturnRouteProof={from:position(current),target:{...target},found:route!==undefined,steps:route?.length??0,rejected,observedAt:Date.now(),movement:{canDig:m.canDig,allow1by1towers:m.allow1by1towers,maxDropDown:m.maxDropDown,exclusions:m.exclusionAreasStep?.length??0}};
      if(!route)continue;
      path=route;destination=target;selected=index;
      break;
    }
    if (!path) throw new ConditionWait('기록한 복귀 구간의 실제 지면·경로와 위협을 다시 확인해야 합니다.',s.checkpoint);
    s.progress('재료 복귀',`검증한 발판을 따라 ${trip.failure?'미완료 원정에서':'재료 원정을 마치고'} 작업 지점으로 돌아갑니다. 남은 복귀 구간 ${trip.trail.length}.`);
    await walkTripPath(s,path,undefined,undefined,stepsOnly,8);
    const actual=await stableFeet(s,true);
    if (!vector(actual).equals(vector(destination))) throw new ConditionWait('복귀 발판의 실제 도착을 확인해야 합니다.',s.checkpoint);
    if(selected<last){const history=Array.isArray(s.checkpoint.resourceTripShortcuts)?s.checkpoint.resourceTripShortcuts:[];
      s.checkpoint.resourceTripShortcuts=[...history,{from:position(current),target:{...destination},skippedWaypoints:trip.trail.slice(selected+1),observedAt:Date.now(),arrivalVerified:true}].slice(-4);trip.trail=trip.trail.slice(0,selected+1);save(s,trip);}
    if (trip.trail.length===1) break;
    trip.trail.pop(); save(s,trip);
  }
  trip.phase='complete'; trip.returns++; trip.completedAt=Date.now(); save(s,trip); recenterAfterReturn(s,trip.home);
  s.observations.push(s.observeInventory(),{...observationBase(s.rules.world,s.rules.dimension),kind:'position',data:{position:position(s.bot.entity.position)}});
  s.progress('재료 복귀',`${trip.item} 원정 후 작업 지점의 실제 안전한 도착을 확인했습니다.`);
  }catch(error){
    s.check();if(!(error instanceof ConditionWait))throw error;
    if(!stepsOnly&&error.message.startsWith('20초 동안 목표 위치')){
      s.checkpoint.returnMovementFailure={actual:position(s.bot.entity.position),onGround:s.bot.entity.onGround??null,controls:Object.fromEntries(Object.entries(s.bot.controlState??{})),observedAt:Date.now()};
      s.bot.pathfinder.setGoal?.(null);s.bot.clearControlStates?.();await s.pause(150);
      await settleStandingFootprint(s.bot,s,()=>{});await centerSupportedCell(s.bot,s);
      return returnFromResourceTrip(s,true);
    }
    const reconciling=s.checkpoint.resourceTripReconcile as JsonObject|undefined;
    const points=[position(walkingFeet(s.bot)),reconciling?.deathId===s.checkpoint.confirmedRecoveryDeathId?trip.home:trip.trail.at(-1)??trip.home],cells=new Map<string,Position>();
    for(const p of points)for(const [dx,dz]of [[0,0],[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [-2,-1,0,1]){const q={x:p.x+dx!,y:p.y+dy,z:p.z+dz!};cells.set(`${q.x},${q.y},${q.z}`,q);}
    s.checkpoint.waitingFor={kind:'blocks',causeCode:'BUILD_ACCESS',positions:[...cells.values()],watchPosition:true,watchSafety:true};
    s.observations.push({...observationBase(s.rules.world,s.rules.dimension),kind:'blocks',data:{blocks:[...cells.values()].flatMap(p=>{const b=s.bot.blockAt(vector(p));return b?[{position:p,name:b.name}]:[];})}});
    throw new ConditionWait(error.message,s.checkpoint);
  }
}

/** A tool made at home can return to the same resource through verified travel. */
export async function resumeResourceTrip(s: ActionServices, trail: readonly Position[]): Promise<void> {
  for (const waypoint of trail) {
    s.check(); const path=safeResourceRoute(s.bot,waypoint);
    if (!path) throw new ConditionWait('도구 준비 후 원래 자원까지 기록한 실제 경로를 다시 확인해야 합니다.',s.checkpoint);
    for (const step of path) { await s.near(vector(step).offset(0.5,0,0.5),0); }
    await stableFeet(s); await recordResourceTripPosition(s);
  }
  recenterAfterReturn(s,position(walkingFeet(s.bot)));
}
