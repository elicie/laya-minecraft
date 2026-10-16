import type {ActionServices} from './services';
import {ConditionWait} from './services';
import {observedGroundStand} from './observed-ground-walk';
import {position,vector,walkingFeet} from './observations';
import {HOSTILES} from './combat-policy';

/** A body can still overlap the one-block-higher doorway foundation while its
 * centre is outside. Step off that specific observed support onto the registered
 * lower full outside cell. No jump, digging, placement or unobserved fall. */
export async function settleWarehouseThreshold(s:ActionServices):Promise<boolean>{
 const b=s.bot,base=s.rules.baseShelter;if(!base||base.world!==s.rules.world||base.dimension!==s.rules.dimension)return false;
 const p=b.entity.position,feet=walkingFeet(b),target=vector(base.outside).offset(.5,0,.5),half=(b.entity.width??.6)/2;
 if(feet.x!==base.outside.x||feet.z!==base.outside.z||feet.y!==base.outside.y+1||Math.abs(p.y-feet.y)>.05||!b.entity.onGround||Math.hypot(p.x-target.x,p.z-target.z)>.6)return false;
 if(base.door.y!==feet.y||Math.hypot(base.door.x-base.outside.x,base.door.z-base.outside.z)!==1||base.blocks.some(q=>b.blockAt(vector(q.position))?.name!==q.name)||!observedGroundStand(b,base.outside))return false;
 const support=b.blockAt(vector(base.door).offset(0,-1,0));
 if(!support?.shapes.some(q=>q[0]===0&&q[1]===0&&q[2]===0&&q[3]===1&&q[4]===1&&q[5]===1)||p.x+half<=base.door.x||p.x-half>=base.door.x+1||p.z+half<=base.door.z||p.z-half>=base.door.z+1)return false;
 const clear=()=>!Object.values(b.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(b.entity.position)<12);
 if(!clear())return false;
 const saved=s.checkpoint.baseThresholdSettle as {attempts?:number}|undefined,attempts=Number(saved?.attempts??0);if(attempts>=2)throw new ConditionWait('창고 문턱에서 제한한 실제 착지 시도를 보존하고 발판 변화를 기다립니다.',s.checkpoint);
 s.checkpoint.baseThresholdSettle={from:position(p),target:position(target),attempts:attempts+1,phase:'moving'};b.pathfinder.setGoal(null);b.clearControlStates();
 try{
  for(let tick=0;tick<30;tick++){
   s.check();const q=b.entity.position;if(!clear()||!observedGroundStand(b,base.outside)||q.y<target.y-.1||q.y>target.y+1.1||Math.hypot(q.x-target.x,q.z-target.z)>.8)throw new ConditionWait('창고 문턱의 실제 지지·위협·착지 범위가 바뀌었습니다.',s.checkpoint);
   if(Math.abs(q.y-target.y)<.05&&b.entity.onGround&&Math.hypot(q.x-target.x,q.z-target.z)<.15){b.clearControlStates();await s.pause(150);if(observedGroundStand(b,b.entity.position)&&Math.abs(b.entity.position.y-target.y)<.05){s.checkpoint.baseThresholdSettle={...s.checkpoint.baseThresholdSettle,phase:'complete',actual:position(b.entity.position)};return true;}}
   const distance=Math.hypot(q.x-target.x,q.z-target.z);if(distance<.08)b.setControlState('forward',false);else{await b.lookAt(target.offset(0,1.62,0),true);b.setControlState('forward',true);}await s.pause(50);
  }
  throw new ConditionWait('창고 문턱에서 실제 낮은 발판 착지를 확인해야 합니다.',s.checkpoint);
 }finally{b.clearControlStates();}
}
