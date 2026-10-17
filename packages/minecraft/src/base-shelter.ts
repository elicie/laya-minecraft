import {BaseShelterSchema,isBuildSiteAir,type Position} from '../../contracts/src';
import {HOSTILES} from './combat-policy';
import {duskOrNight} from './night-burrow';
import {observedGroundStand} from './observed-ground-walk';
import {position,vector,walkingFeet} from './observations';
import {ConditionWait,type ActionServices} from './services';
import {openDoorClearance} from './open-door';
import {crossOpenDoor} from './door-passage';
import {centerSupportedCell} from './standing-footprint';
import {settleWarehouseThreshold} from './base-threshold';
import {withWarehouseDoor} from './warehouse-door-lease';
import {localNightExitClear} from './night-work';

export function warehouseInterior(s:ActionServices,p:Position=s.bot.entity.position):boolean{
 const base=s.rules.baseShelter;if(!base||base.world!==s.rules.world||base.dimension!==s.rules.dimension)return false;
 const minX=Math.min(...base.blocks.map(b=>b.position.x)),maxX=Math.max(...base.blocks.map(b=>b.position.x)),minZ=Math.min(...base.blocks.map(b=>b.position.z)),maxZ=Math.max(...base.blocks.map(b=>b.position.z));
 return Math.floor(p.y)===base.inside.y&&p.x>=minX+1&&p.x<maxX&&p.z>=minZ+1&&p.z<maxZ;
}

/** Reuse a registered, reobserved building. Doors use public activateBlock. */
export async function restInWarehouse(s:ActionServices,enabled:()=>boolean,eat?:()=>Promise<void>,mode:'night'|'enter'|'exit'='night'):Promise<boolean>{
  const parsed=BaseShelterSchema.safeParse(s.rules.baseShelter),b=s.bot,pending=mode==='night'&&s.checkpoint.nightBasePending===true;
  if(!parsed.success||!s.rules.warehouse||parsed.data.warehouseId!==s.rules.warehouse.id||parsed.data.world!==s.rules.world||parsed.data.dimension!==s.rules.dimension)return false;
  const base=parsed.data,night=()=>duskOrNight(b),clear=(p:Position,radius=12)=>!Object.values(b.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(vector(p).offset(.5,0,.5))<radius);
  if(!pending&&(!enabled()||mode==='night'&&(b.time?.doDaylightCycle!==true||!night())||b.entity.position.distanceTo(vector(base.outside))>(mode==='night'?48:128)||!clear(b.entity.position)))return false;
  const min={x:Math.min(...base.blocks.map(q=>q.position.x)),y:Math.min(...base.blocks.map(q=>q.position.y)),z:Math.min(...base.blocks.map(q=>q.position.z))};
  const max={x:Math.max(...base.blocks.map(q=>q.position.x)),y:Math.max(...base.blocks.map(q=>q.position.y)),z:Math.max(...base.blocks.map(q=>q.position.z))};
  const actual=(p:Position)=>b.blockAt(vector(p)),key=(p:Position)=>`${p.x},${p.y},${p.z}`,planned=new Map(base.blocks.map(q=>[key(q.position),q.name]));
  const full=(p:Position)=>actual(p)?.shapes.some(a=>a[0]===0&&a[1]===0&&a[2]===0&&a[3]===1&&a[4]===1&&a[5]===1);
  const roomStand=(p:Position)=>[p,{...p,y:p.y+1}].every(q=>{const block=actual(q);return !!block&&(isBuildSiteAir(block.name)||block.boundingBox==='empty'&&block.name==='wall_torch'||openDoorClearance(block));})&&full({...p,y:p.y-1})&&!Object.values(b.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.x>min.x&&e.position.x<max.x+1&&e.position.z>min.z&&e.position.z<max.z+1&&e.position.y>=min.y&&e.position.y<=max.y);
  const verified=()=>{
    if(base.blocks.some(q=>actual(q.position)?.name!==q.name))return false;
    for(let x=min.x;x<=max.x;x++)for(let z=min.z;z<=max.z;z++){
      if(!full({x,y:min.y,z})||!full({x,y:max.y,z}))return false;
      if(x!==min.x&&x!==max.x&&z!==min.z&&z!==max.z)continue;
      for(let y=min.y+1;y<max.y;y++){const p={x,y,z},name=planned.get(key(p));if(!name||isBuildSiteAir(name)||actual(p)?.name!==name)return false;}
    }
    return roomStand(base.inside)&&actual(base.door)?.name.endsWith('_door')&&actual(base.door)?.name!=='iron_door';
  };
  const inside=()=>{const p=walkingFeet(b);return p.y===base.inside.y&&p.x>min.x&&p.x<max.x&&p.z>min.z&&p.z<max.z&&roomStand(p);};
  if(!verified()){
    if(pending){
      const phase=String((s.checkpoint.nightBase as {phase?:string}|undefined)?.phase??'entering');
      if(phase==='entering'&&!warehouseInterior(s)&&b.entity.position.distanceTo(vector(base.door))>8){
        s.checkpoint.nightBaseApproachFailure={reason:'먼 거점의 구조를 현재 위치에서 검증할 수 없습니다.',position:position(b.entity.position),observedAt:Date.now()};
        s.checkpoint.nightBasePending=false;delete s.checkpoint.nightBase;return false;
      }
      throw new ConditionWait('등록한 야간 거점의 실제 기초·벽·지붕과 출입구를 다시 확인해야 합니다.',s.checkpoint);
    }
    return false;
  }
  const stable=async()=>{for(let i=0;i<20&&b.entity.onGround!==true;i++){s.check();await s.pause(50);}if(b.entity.onGround!==true||!observedGroundStand(b,b.entity.position))throw new ConditionWait('거점 출입 전 실제 안정 착지를 확인해야 합니다.',s.checkpoint);};
  const door=async(open:boolean)=>{
    s.check();if(!enabled())throw new ConditionWait('출입문 사용 권한을 다시 확인해야 합니다.',s.checkpoint);
    const block=actual(base.door);if(!block||!block.name.endsWith('_door')||block.name==='iron_door'||!verified())throw new ConditionWait('실제 목재 출입문과 거점 상태를 확인해야 합니다.',s.checkpoint);
    if(block.getProperties().open===open)return;
    const upper=actual({...base.door,y:base.door.y+1}),target=[block,upper].find(q=>q&&q.name===block.name&&b.entity.position.offset(0,1.62,0).distanceTo(vector(q.position).offset(.5,.5,.5))<=4.5&&b.canSeeBlock(q));
    if(!target)throw new ConditionWait('출입문이 직접 보이고 실제 상호작용 거리 안에 있어야 합니다.',s.checkpoint);
    await b.activateBlock(target);
    for(let i=0;i<20&&actual(base.door)?.getProperties().open!==open;i++){s.check();await s.pause(50);}
    if(actual(base.door)?.getProperties().open!==open)throw new ConditionWait('목재 출입문의 실제 개폐 결과를 확인해야 합니다.',s.checkpoint);
  };
  const approachOutside=async()=>{
    const prior=s.checkpoint.dryGroundApproach;s.checkpoint.dryGroundApproach=true;
    try{await settleWarehouseThreshold(s);await s.near(vector(base.outside).offset(.5,0,.5),0);await stable();await centerSupportedCell(b,s);await stable();}
    finally{if(prior===undefined)delete s.checkpoint.dryGroundApproach;else s.checkpoint.dryGroundApproach=prior;}
  };
  s.checkpoint.safeDetourRequired=true;
  if(mode!=='night'){
    if(mode==='enter'){
      if(!inside()){
        await approachOutside();
        if(!clear(b.entity.position)||!clear(base.inside))throw new ConditionWait('창고 출입 전에 실제 주변 위협 이탈이 필요합니다.',s.checkpoint);
        await withWarehouseDoor(s,async()=>{await door(true);await crossOpenDoor(s,base.door,base.inside,enabled,()=>clear(b.entity.position));await stable();await door(false);});
      }
      if(!inside())throw new ConditionWait('창고 내부의 실제 도착을 확인해야 합니다.',s.checkpoint);
      await withWarehouseDoor(s,()=>door(false));
    }else if(inside()){
      if(b.time?.doDaylightCycle===true&&night()&&!(s.checkpoint.nightLocalWork===true&&localNightExitClear(b,s.rules))||!clear(base.outside,12))throw new ConditionWait('안전한 창고 출구와 허용된 근거리 작업을 확인한 뒤 재개합니다.',s.checkpoint);
      await s.near(vector(base.inside).offset(.5,0,.5),0);await stable();
      await withWarehouseDoor(s,async()=>{await door(true);await crossOpenDoor(s,base.door,base.outside,enabled,()=>clear(b.entity.position,12));await stable();await centerSupportedCell(b,s);await door(false);await stable();});
    }else{await approachOutside();}
    s.checkpoint.basePassage={warehouseId:base.warehouseId,mode,position:position(b.entity.position),completedAt:Date.now()};return true;
  }
  s.checkpoint.nightBasePending=true;
  let phase=String((s.checkpoint.nightBase as {phase?:string}|undefined)?.phase??'entering');
  const setPhase=(value:string)=>{phase=value;s.checkpoint.nightBase={warehouseId:base.warehouseId,phase:value,door:base.door,inside:base.inside,outside:base.outside};};
  if(phase==='done'){setPhase('entering');}
  if(phase==='entering'){
    s.progress('창고 거점 복귀','등록한 창고의 실제 기초·벽·지붕과 안전한 출입 경로를 확인합니다.');
    if(!inside()){
      try{await approachOutside();}
      catch(error){
        s.check();
        // No door passage has begun. A failed distant approach must leave
        // nearby shelter available instead of pinning an exposed worker here.
        if(!(error instanceof ConditionWait)||inside()||actual(base.door)?.getProperties().open!==false||b.entity.position.distanceTo(vector(base.door))<=4)throw error;
        s.checkpoint.nightBaseApproachFailure={reason:error.message,position:position(b.entity.position),observedAt:Date.now()};
        setPhase('done');s.checkpoint.nightBasePending=false;return false;
      }
      if(!clear(b.entity.position)||!clear(base.inside))throw new ConditionWait('거점 출입 전에 실제 주변 위협 이탈이 필요합니다.',s.checkpoint);
      await withWarehouseDoor(s,async()=>{await door(true);await crossOpenDoor(s,base.door,base.inside,enabled,()=>clear(b.entity.position));await stable();await door(false);});
    }
    if(!inside())throw new ConditionWait('등록한 창고 내부의 실제 도착을 확인해야 합니다.',s.checkpoint);
    await withWarehouseDoor(s,()=>door(false));setPhase('closed');s.observations.push(s.observeInventory());
  }
  if(phase==='closed'){
    if(!inside())throw new ConditionWait('보존한 야간 거점의 실제 내부 위치를 다시 확인해야 합니다.',s.checkpoint);
    s.progress('창고 야간 대피','완공한 창고 안에서 출입문을 닫고 실제 낮과 안전한 출구를 기다립니다.');
    while(night()||!enabled()||!clear(base.outside,12)){
      s.check();if(!verified())throw new ConditionWait('야간 거점의 벽·지붕 상태가 바뀌었습니다.',s.checkpoint);
      if(actual(base.door)?.getProperties().open!==false)await withWarehouseDoor(s,()=>door(false));
      if(b.food<18&&enabled())try{await eat?.();}catch(error){s.check();if(!(error instanceof ConditionWait))throw error;s.checkpoint.nightBaseFoodWait=error.message;}s.progress('창고 야간 대피','완공한 창고 안에서 출입문을 닫고 실제 낮과 안전한 출구를 기다립니다.');await s.pause(1000);
    }
    setPhase('opening');
  }
  if(phase==='opening'){
    while(night()||!enabled()||!clear(base.outside,12)){s.check();await s.pause(1000);}
    if(inside())await s.near(vector(base.inside).offset(.5,0,.5),0);await stable();
    await withWarehouseDoor(s,async()=>{if(inside()){await door(true);await crossOpenDoor(s,base.door,base.outside,enabled,()=>clear(b.entity.position,12));await stable();await centerSupportedCell(b,s);}else if(vector(walkingFeet(b)).distanceTo(vector(base.outside))>1)throw new ConditionWait('보존한 거점 출구의 실제 도착을 확인해야 합니다.',s.checkpoint);await door(false);await stable();});
    setPhase('done');s.checkpoint.nightBasePending=false;s.observations.push(s.observeInventory());
    s.progress('창고 야간 대피 종료','실제 낮에 안전한 출구로 나와 출입문을 닫고 보존한 작업을 재개합니다.');
  }
  return true;
}
