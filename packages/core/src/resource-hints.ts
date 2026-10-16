import { PositionSchema, itemCount, type FleetCheckpoint, type JsonObject } from '../../contracts/src';

/** Past collection guides exploration; it is not current stock or proof that
 * the source, terrain or route still exists. */
export function collectionHints(state: FleetCheckpoint, now: number): JsonObject[] {
  const hints: JsonObject[] = [], seen = new Set<string>();
  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  for (const attempt of [...state.attempts].reverse()) {
    const task=tasks.get(attempt.taskId), result=attempt.result;
    if(task?.kind!=='collect'||!result||!attempt.finishedAt||now<attempt.finishedAt||now-attempt.finishedAt>86400000)continue;
    const item=task.params.item,p=PositionSchema.safeParse(result.checkpoint.lastResourcePosition);
    if(typeof item!=='string'||!p.success||![p.data.x,p.data.y,p.data.z].every(Number.isInteger))continue;
    const counts=result.observations.filter(o=>o.world===state.rules.world&&o.dimension===state.rules.dimension&&o.kind==='inventory').map(o=>o.kind==='inventory'?itemCount(o.data.items,item):0);
    const complete=task.state==='completed'&&attempt.state==='completed'&&result.outcome==='completed';
    const verifiedPartial=attempt.state==='interrupted'&&result.outcome==='condition-wait'&&counts.length>1&&Math.max(...counts)>counts[0]!;
    if(!complete&&!verifiedPartial)continue;
    if(!result.observations.some(o=>o.world===state.rules.world&&o.dimension===state.rules.dimension&&o.kind==='inventory'&&itemCount(o.data.items,item)>0))continue;
    const key=`${item}:${Math.floor(p.data.x/16)},${Math.floor(p.data.z/16)}`;
    if(seen.has(key))continue;seen.add(key);
    hints.push({item,position:p.data,world:state.rules.world,dimension:state.rules.dimension,observedAt:attempt.finishedAt,taskId:task.id});
    if(hints.length>=32)break;
  }
  return hints;
}
