import type { Bot } from 'mineflayer';
import type { Move } from 'mineflayer-pathfinder';
import type { Position } from '../../contracts/src';
import { position, vector, walkingFeet } from './observations';

/** A diagonal needs an actual cardinal foothold for the player's width. */
export function walkCorner(from:Position,to:Position,stand:(p:Position)=>boolean):Position|undefined {
  return [{x:from.x,y:from.y,z:to.z},{x:to.x,y:from.y,z:from.z},{x:from.x,y:to.y,z:to.z},{x:to.x,y:to.y,z:from.z}].find(p=>Math.abs(p.y-to.y)<=1&&stand(p));
}

/** Bounded search of public movement candidates; all accepted cells need proof. */
export function alternateSafeWalk(bot: Bot, target: Position | Position[], options: { within(p: Position): boolean; stand(p: Position): boolean; radius?: number;start?:Position;maxNodes?:number;timeLimitMs?:number;maxDrop?:1|2 }): Position[] | undefined {
  const movements = bot.pathfinder.movements;
  if (typeof movements.getNeighbors !== 'function') return;
  const key = (p: Position) => `${p.x},${p.y},${p.z}`, destinations=(Array.isArray(target)?target:[target]).map(vector), start = walkingFeet(bot,options.start??bot.entity.position), deadline = Date.now() + (options.timeLimitMs??150);
  const initial: Move = { ...position(start), remainingBlocks: 0, cost: 0, toBreak: [], toPlace: [], parkour: false, hash: key(start) };
  if(!destinations.length)return;
  const heuristic=(p:Position)=>{const feet=walkingFeet(bot,p);let distance=Infinity;for(const q of destinations)distance=Math.min(distance,feet.distanceTo(q));return distance;};
  type Entry={move:Move;path:Position[];cost:number;score:number;order:number};
  const queue:Entry[]=[],best=new Map([[key(start),0]]),safe=new Map<string,boolean>();let order=0;
  const less=(a:Entry,b:Entry)=>a.score<b.score||a.score===b.score&&a.order<b.order;
  const push=(move:Move,path:Position[],cost:number)=>{let i=queue.length;const item={move,path,cost,score:cost+heuristic(move),order:order++};queue.push(item);while(i){const p=(i-1)>>1;if(!less(item,queue[p]!))break;queue[i]=queue[p]!;i=p;}queue[i]=item;};
  const pop=()=>{const first=queue[0]!,last=queue.pop()!;if(queue.length){let i=0;while(i*2+1<queue.length){let child=i*2+1;if(child+1<queue.length&&less(queue[child+1]!,queue[child]!))child++;if(!less(queue[child]!,last))break;queue[i]=queue[child]!;i=child;}queue[i]=last;}return first;};
  push(initial,[],0);
  const safeStand=(p:Position)=>{const k=key(p);if(!safe.has(k))safe.set(k,options.stand(p));return safe.get(k)!;};
  for (let visited = 0; queue.length && visited < (options.maxNodes??4096) && Date.now() < deadline; visited++) {
    const current = pop();
    const from=walkingFeet(bot,current.move);
    if (current.cost !== best.get(key(from))) continue;
    if (current.score-current.cost <= (options.radius ?? 0)) return current.path;
    if (current.path.length >= 256) continue;
    for (const move of movements.getNeighbors(current.move)) {
      const p = position(walkingFeet(bot,move)), k = key(p), cost = current.cost + Math.max(1, move.cost);
      if (!Number.isFinite(cost) || !options.within(p) || move.toBreak?.length || move.toPlace?.length || move.parkour || p.y-from.y>1 || from.y-p.y>(options.maxDrop??1) || Math.hypot(p.x - from.x, p.z - from.z) > 1.5 || cost >= (best.get(k) ?? Infinity)) continue;
      if (!safeStand(p)) continue;
      if(p.x!==from.x&&p.z!==from.z&&!walkCorner(from,p,q=>options.within(q)&&safeStand(q)))continue;
      best.set(k, cost); push(move,[...current.path,p],cost);
    }
  }
}
