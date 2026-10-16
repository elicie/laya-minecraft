import {PositionSchema,type BotReport,type Task} from '../../contracts/src';
/** Keep an outbound/returning actor pinned. An idle collector already home
 * may yield to newly available food work without discarding its checkpoint. */
export function idleResourceTaskCanYield(task:Task,report:BotReport|undefined,hasActor:boolean):boolean{
 if(hasActor||task.kind!=='collect'||task.state!=='condition-wait')return false;
 const trip=task.checkpoint.resourceTrip;if(trip&&typeof trip==='object'&&!Array.isArray(trip))return trip.phase==='complete';
 if(trip!==undefined||!task.checkpoint.waitingFor)return false;
 const home=PositionSchema.safeParse(task.params.returnTo),at=report?.position;
 return home.success&&!!at&&Math.hypot(at.x-home.data.x,at.y-home.data.y,at.z-home.data.z)<=3;
}
