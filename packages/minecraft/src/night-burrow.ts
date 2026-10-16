import {z} from 'zod';
import {PositionSchema,isBuildSiteGround,type Position} from '../../contracts/src';
import {HOSTILES} from './combat-policy';
import {observedGroundRoute,observedGroundStand} from './observed-ground-walk';
import {resourceClearance,safeResourceStand} from './resource-recovery';
import {position,vector,walkingFeet} from './observations';
import {walkTripSteps} from './resource-trip';
import {ConditionWait,type ActionServices} from './services';
import {restInSoilShaft} from './night-soil-shaft';

const soil=new Set(['dirt','grass_block']);
const schema=z.object({outside:PositionSchema,direction:PositionSchema,phase:z.enum(['digging','closed','opening','restoring','done'])});
export function duskOrNight(bot:Pick<ActionServices['bot'],'time'>):boolean{
  const time=bot.time?.timeOfDay;return bot.time?.isDay===false||typeof time==='number'&&time>=9000&&time<23000;
}

/** A four-block recess in known natural soil. All world edits use public APIs. */
export async function restInNightBurrow(s:ActionServices,protectedPosition:(p:Position)=>boolean,enabled:()=>boolean):Promise<boolean>{
  const b=s.bot,night=()=>duskOrNight(b);
  if(s.checkpoint.nightSoilShaft&&typeof s.checkpoint.nightSoilShaft==='object'&&!Array.isArray(s.checkpoint.nightSoilShaft)&&s.checkpoint.nightSoilShaft.phase!=='done')return restInSoilShaft(s,protectedPosition,enabled,night);
  const clear=(p:Position,radius=20)=>!Object.values(b.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(vector(p))<radius);
  const fullSoil=(p:Position)=>{const q=b.blockAt(vector(p));return !!q&&soil.has(q.name)&&q.boundingBox==='block'&&q.shapes.some(a=>a[0]===0&&a[1]===0&&a[2]===0&&a[3]===1&&a[4]===1&&a[5]===1);};
  const fullNatural=(p:Position)=>{const q=b.blockAt(vector(p));return !!q&&isBuildSiteGround(q.name)&&!['sand','red_sand','gravel'].includes(q.name)&&q.boundingBox==='block'&&q.shapes.some(a=>a[0]===0&&a[1]===0&&a[2]===0&&a[3]===1&&a[4]===1&&a[5]===1);};
  const shape=(outside:Position,direction:Position)=>{
    const p=vector(outside),d=vector(direction),front=p.plus(d),inside=p.plus(d.scaled(2)),side={x:-d.z,y:0,z:d.x};
    const cut=[front.offset(0,1,0),front,inside.offset(0,1,0),inside];
    const shell=[front.offset(0,-1,0),inside.offset(0,-1,0),front.offset(0,2,0),inside.offset(0,2,0),inside.plus(d),inside.plus(d).offset(0,1,0),...[-1,1].flatMap(n=>[inside.offset(side.x*n,0,side.z*n),inside.offset(side.x*n,1,side.z*n)])];
    return {front,inside,cut,shell};
  };
  let saved=schema.safeParse(s.checkpoint.nightBurrow),plan=saved.success&&saved.data.phase!=='done'?saved.data:undefined;
  if(plan?.phase==='digging'&&vector(b.entity.position).distanceTo(vector(plan.outside))>6&&shape(plan.outside,plan.direction).cut.every(fullSoil)){
    const previous=Array.isArray(s.checkpoint.nightBurrowAbandoned)?s.checkpoint.nightBurrowAbandoned:[];
    s.checkpoint.nightBurrowAbandoned=[...previous,{...plan,actual:position(b.entity.position),observedAt:Date.now(),reason:'위험 대응으로 이동했고 아직 굴착한 칸이 없습니다.'}].slice(-8);
    delete s.checkpoint.nightBurrow;delete s.checkpoint.nightBurrowInitialDirt;s.checkpoint.nightBurrowPending=false;plan=undefined;
  }
  if(!plan){
    if(!enabled()||b.time?.doDaylightCycle!==true||!night())return false;
    if(!clear(b.entity.position))return restInSoilShaft(s,protectedPosition,enabled,night);
    const origin=walkingFeet(b),region=`${Math.floor(origin.x/16)},${Math.floor(origin.z/16)}`,checked=Array.isArray(s.checkpoint.nightBurrowChecked)?s.checkpoint.nightBurrowChecked.filter((v):v is string=>typeof v==='string'):[];
    if(checked.includes(region))return restInSoilShaft(s,protectedPosition,enabled,night);
    s.checkpoint.nightBurrowChecked=[...checked,region].slice(-64);
    const candidates:{outside:Position;direction:Position}[]=[];
    for(let dx=-12;dx<=12;dx++)for(let dz=-12;dz<=12;dz++)for(let dy=-4;dy<=4;dy++){
      if(Math.hypot(dx,dz)>12)continue;const p=origin.offset(dx,dy,dz);
      if(!safeResourceStand(b,p,()=>false)||!clear(p))continue;
      for(const d of [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1}]){
        const q=shape(p,d);if(q.cut.some(x=>protectedPosition(x)||!fullSoil(x))||q.shell.some(x=>protectedPosition(x)||!fullNatural(x)))continue;
        candidates.push({outside:position(p),direction:d});
      }
    }
    candidates.sort((a,c)=>vector(a.outside).distanceTo(origin)-vector(c.outside).distanceTo(origin));
    s.checkpoint.nightBurrowSearch={origin:position(origin),candidates:candidates.slice(0,12),observedAt:Date.now()};
    for(const candidate of candidates.slice(0,12)){
      const path=observedGroundRoute(b,candidate.outside,24);if(!path||path.some(p=>!clear(p)))continue;
      if(!await s.walkVerified?.(path,p=>observedGroundStand(b,p)&&clear(p)))await walkTripSteps(s,path);
      if(vector(b.entity.position).distanceTo(vector(candidate.outside).offset(.5,0,.5))>1.5)continue;
      plan={...candidate,phase:'digging'};s.checkpoint.nightBurrow=plan;s.checkpoint.nightBurrowInitialDirt=b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0);s.checkpoint.nightBurrowPending=true;break;
    }
    if(!plan)return restInSoilShaft(s,protectedPosition,enabled,night);
  }
  s.checkpoint.nightBurrowPending=true;const q=shape(plan.outside,plan.direction),setPhase=(phase:typeof plan.phase)=>{plan!.phase=phase;s.checkpoint.nightBurrow=plan!;};
  s.checkpoint.resourcePositions=[position(vector(plan.outside)),...q.cut.map(position),...q.shell.map(position)];
  const expectedDirt=Number(s.checkpoint.nightBurrowInitialDirt??0)+4;
  if([...q.cut,...q.shell].some(protectedPosition)||q.shell.some(p=>!fullNatural(p)))throw new ConditionWait('임시 굴의 보호 구역·지지체·지붕과 옆벽을 실제로 다시 확인해야 합니다.',s.checkpoint);
  const observe=()=>s.observations.push(s.observeInventory());
  if(plan.phase==='digging'){
    while(!enabled()){s.check();await s.pause(1000);}
    if(!clear(plan.outside))throw new ConditionWait('굴을 파기 전 실제 주변 위협을 확인해야 합니다.',s.checkpoint);
    await s.near(vector(plan.outside).offset(.5,0,.5),0);
    for(let i=0;i<q.cut.length;i++){
      s.check();while(!enabled()){s.check();await s.pause(1000);}if(!clear(b.entity.position))throw new ConditionWait('임시 굴 굴착 중 위협이 바뀌었습니다.',s.checkpoint);
      const p=q.cut[i]!,actual=b.blockAt(p);if(!actual)throw new ConditionWait('굴착할 자연 흙을 다시 관측해야 합니다.',s.checkpoint);
      if(!resourceClearance(actual)){
        if(!soil.has(actual.name)||!b.canSeeBlock(actual)||!b.canDigBlock(actual))throw new ConditionWait('직접 보이고 닿는 자연 흙만 굴착할 수 있습니다.',s.checkpoint);
        s.progress('야간 은신처 준비','기존 흙 언덕 안의 몸·머리 공간 네 칸을 확인하며 팝니다.');await b.dig(actual);await s.pause(100);observe();
      }
      if(i===1)await s.near(q.front.offset(.5,0,.5),0);
    }
    await s.near(q.inside.offset(.5,0,.5),0);await s.pause(150);
    await s.recoverDrops?.(q.inside,'dirt',expectedDirt);await s.recoverDrops?.(q.front,'dirt',expectedDirt);
    await s.near(q.inside.offset(.5,0,.5),0);await s.pause(150);
    if(b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0)<2)await s.recoverDrops?.(q.front,'dirt',2);
    if(b.inventory.items().filter(i=>i.name==='dirt').reduce((n,i)=>n+i.count,0)<2)throw new ConditionWait('입구 두 칸을 막을 실제 흙 아이템을 확보해야 합니다.',s.checkpoint);
    for(const p of [q.front,q.front.offset(0,1,0)])if(b.blockAt(p)?.name!=='dirt')await s.place(p,'dirt','dirt');
    setPhase('closed');observe();
  }
  if(plan.phase==='closed'){
    s.progress('야간 은신처 대기','자연 흙의 지붕과 옆벽, 막은 입구 안에서 실제 해가 뜨기를 기다립니다.');
    while(night()||!enabled()||!clear(plan.outside,12)){
      s.check();
      const flesh=b.inventory.items().find(i=>i.name==='rotten_flesh');
      if(flesh&&b.food<18){await b.equip(flesh,'hand');await b.consume();observe();}
      await s.pause(1000);
    }
    setPhase('opening');
  }
  if(plan.phase==='opening'){
    while(night()||!enabled()||!clear(plan.outside,12)){s.check();await s.pause(1000);}
    for(const p of [q.front.offset(0,1,0),q.front]){
      s.check();const actual=b.blockAt(p);if(actual?.name==='dirt'){if(!b.canSeeBlock(actual)||!b.canDigBlock(actual))throw new ConditionWait('아침에 직접 관측한 자체 입구 흙만 제거합니다.',s.checkpoint);await b.dig(actual);await s.pause(100);}
      else if(!resourceClearance(actual))throw new ConditionWait('임시 굴 입구가 바뀌어 밖으로 나갈 수 없습니다.',s.checkpoint);
    }
    await s.recoverDrops?.(q.front,'dirt',expectedDirt);await s.near(vector(plan.outside).offset(.5,0,.5),0);await s.pause(150);setPhase('restoring');observe();
  }
  if(plan.phase==='restoring'){
    for(const p of [...q.cut].reverse()){s.check();if(b.blockAt(p)?.name==='dirt')continue;if(!resourceClearance(b.blockAt(p)))throw new ConditionWait('자체 굴착 칸에 다른 블록이 있어 복원하지 않습니다.',s.checkpoint);await s.place(p,'dirt','dirt');}
    setPhase('done');s.checkpoint.nightBurrowPending=false;observe();
    s.progress('야간 은신처 종료','실제 낮과 안전한 출구를 확인했고 팠던 네 칸을 흙으로 메웠습니다.');
  }
  return true;
}
