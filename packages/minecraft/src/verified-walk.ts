import type { Bot } from 'mineflayer';
import { goals, Movements } from 'mineflayer-pathfinder';
import type { Position } from '../../contracts/src';
import { position, vector, walkingFeet } from './observations';
import { checkAbort, ConditionWait } from './services';

/** Public movement configuration limits a continuous walk to observed safe cells. */
export async function walkVerified(bot: Bot, path: Position[], signal: AbortSignal, stand: (p: Position) => boolean, near: (p: Position, signal: AbortSignal) => Promise<void>,maxDrop:1|2=1): Promise<boolean> {
  if (!path.length) return true;
  if (!bot.registry || typeof bot.pathfinder.setMovements !== 'function' || !bot.pathfinder.movements.blocksToAvoid || typeof bot.pathfinder.movements.exclusionStep !== 'function') return false;
  checkAbort(signal);
  const key=(p: Position)=>`${p.x},${p.y},${p.z}`, start=position(walkingFeet(bot)), cells=new Map<string,Position>();
  for(const p of path){ if(!stand(p))throw new ConditionWait('검증한 보행 구간의 실제 지형이나 위협이 바뀌었습니다.');cells.set(key(p),p); }
  // The library checks head clearance and diagonal corner cells as well as feet.
  for(const p of path)for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){const q={x:p.x+dx!,y:p.y,z:p.z+dz!};if(stand(q))cells.set(key(q),q);}
  const allowed=new Set<string>();for(const p of [start,...cells.values()])for(const dy of [0,1,2])allowed.add(key({x:p.x,y:p.y+dy,z:p.z}));
  const original=bot.pathfinder.movements,movements=new Movements(bot);
  movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];movements.allowSprinting=true;
  movements.blocksToAvoid=new Set([...movements.blocksToAvoid,...original.blocksToAvoid]);
  movements.exclusionAreasStep=[block=>allowed.has(key(block.position))?original.exclusionStep(block):100];
  const target=path.at(-1)!,tolerance=bot.blockAt(vector(target).offset(0,-1,0))?.name==='farmland'?.1:0, planned=bot.pathfinder.getPathTo(movements,new goals.GoalNear(target.x,target.y,target.z,tolerance),200);
  if(planned.status!=='success'||planned.path.length>256)return false;
  let previous=vector(start);const route:Position[]=[];
  for(const move of planned.path){const p=position(walkingFeet(bot,move));if(!cells.has(key(p))||move.toBreak?.length||move.toPlace?.length||move.parkour||p.y-previous.y>1||previous.y-p.y>maxDrop||Math.hypot(p.x-previous.x,p.z-previous.z)>1.5||!stand(p))return false;
    if(p.x!==previous.x&&p.z!==previous.z&&(!stand({x:previous.x,y:p.y,z:p.z})||!stand({x:p.x,y:p.y,z:previous.z})))return false;
    previous=vector(p);route.push(p);}
  if(!previous.equals(vector(target)))return false;
  const controller=new AbortController();let changed=false,index=0;
  const parentAbort=()=>controller.abort();signal.addEventListener('abort',parentAbort,{once:true});
  const guard=()=>{
    const actual=walkingFeet(bot);
    for(let i=index;i<route.length;i++)if(actual.equals(vector(route[i]!)))index=i+1;
    if(route.slice(index).some(p=>!stand(p))){changed=true;controller.abort();}
  };
  bot.on('physicsTick',guard);
  try{
    bot.pathfinder.setMovements(movements);guard();checkAbort(signal);
    await near(position(vector(target).offset(.5,0,.5)),controller.signal);checkAbort(signal);
    if(bot.entity.position.distanceTo(vector(target).offset(.5,0,.5))>1.5||!stand(position(walkingFeet(bot))))throw new ConditionWait('실제 보행 도착과 안전한 지면을 다시 확인해야 합니다.');
    return true;
  }catch(error){checkAbort(signal);if(changed)throw new ConditionWait('보행 중 실제 지형이나 위협이 바뀌어 이동을 중단했습니다.');throw error;}
  finally{bot.off('physicsTick',guard);signal.removeEventListener('abort',parentAbort);bot.pathfinder.setGoal(null);bot.pathfinder.setMovements(original);}
}
