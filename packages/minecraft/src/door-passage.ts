import type {Position} from '../../contracts/src';
import {vector,walkingFeet} from './observations';
import {observedGroundStand} from './observed-ground-walk';
import {ConditionWait,type ActionServices} from './services';
import {openDoorClearance} from './open-door';

/** A two-cell, observed door passage using public player controls only. */
export async function crossOpenDoor(s:ActionServices,door:Position,target:Position,enabled:()=>boolean,clear:()=>boolean):Promise<void>{
  const b=s.bot,start=walkingFeet(b),block=b.blockAt(vector(door));
  if(!openDoorClearance(block)||!observedGroundStand(b,target)||Math.hypot(target.x-start.x,target.z-start.z)>2.1||Math.abs(target.y-start.y)>1)throw new ConditionWait('문 통과의 실제 열린 충돌 형태와 양쪽 발판이 필요합니다.',s.checkpoint);
  const acrossZ=target.z!==start.z,shapes=block!.shapes;
  const low=Math.min(...shapes.map(a=>a[acrossZ?0:2]!)),high=Math.max(...shapes.map(a=>a[acrossZ?3:5]!));
  if(!(high<=.2||low>=.8))throw new ConditionWait('열린 문의 실제 충돌 면이 통과 방향을 가로막습니다.',s.checkpoint);
  const lateral=high<=.2?(high+1)/2:low/2,via=vector(door).offset(acrossZ?lateral:.5,0,acrossZ?.5:lateral),destination=vector(target).offset(.5,0,.5);
  b.pathfinder.setGoal(null);b.clearControlStates();
  try{
    for(const aim of [via,destination]){
      let arrived=false;
      for(let tick=0;tick<100;tick++){
        s.check();if(!enabled()||!clear()||!openDoorClearance(b.blockAt(vector(door)))||!openDoorClearance(b.blockAt(vector(door).offset(0,1,0)))||!observedGroundStand(b,target))throw new ConditionWait('문 통과 중 실제 개폐·발판·권한·위협 상태가 바뀌었습니다.',s.checkpoint);
        const p=b.entity.position;if(Math.hypot(p.x-start.x-.5,p.z-start.z-.5)>3||p.y<Math.min(start.y,target.y)-.15||p.y>Math.max(start.y,target.y)+1.4)throw new ConditionWait('검증한 짧은 출입문 통과 구간을 벗어났습니다.',s.checkpoint);
        const horizontal=Math.hypot(p.x-aim.x,p.z-aim.z);
        if(horizontal<.13&&Math.abs(p.y-aim.y)<.1&&b.entity.onGround){b.clearControlStates();await s.pause(100);arrived=true;break;}
        if(horizontal<.1)b.setControlState('forward',false);else{await b.lookAt(aim.offset(0,1.62,0),true);b.setControlState('forward',true);}
        b.setControlState('jump',b.entity.onGround===true&&aim.y-p.y>.2);await s.pause(50);
      }
      if(!arrived)throw new ConditionWait('제한한 문 통과 시간 안에 실제 도착·착지를 확인하지 못했습니다.',s.checkpoint);
    }
  }finally{b.clearControlStates();}
}
