import {randomUUID} from 'node:crypto';
import type {Bot} from 'mineflayer';
import type {ObservationInput,Rules} from '../../contracts/src';
import {vector} from './observations';

/** Read registered, loaded crop cells without walking to or interacting with them. */
export function passiveFarmObservation(bot:Bot,rules:Rules,now=Date.now()):ObservationInput|undefined{
 const farm=rules.baseAutonomy;if(!farm)return;
 const water=bot.blockAt(vector(farm.origin)),rows=farm.positions.map(p=>({p,soil:bot.blockAt(vector(p)),crop:bot.blockAt(vector(p).offset(0,1,0))}));
 if(!water||rows.some(r=>!r.soil||!r.crop))return;
 let planted=0,watered=0,ripe=0;
 for(const {p,soil,crop}of rows){
  if(soil!.name==='farmland'&&water.name==='water'&&p.y===farm.origin.y&&Math.max(Math.abs(p.x-farm.origin.x),Math.abs(p.z-farm.origin.z))<=4)watered++;
  if(crop!.name!=='wheat')continue;
  const age=typeof crop!.getProperties==='function'?Number(crop!.getProperties().age):NaN;if(!Number.isInteger(age)||age<0||age>7)return;
  planted++;if(age===7)ripe++;
 }
 return{id:randomUUID(),kind:'farm',observedAt:now,world:rules.world,dimension:rules.dimension,data:{id:farm.id,crop:'wheat',plots:rows.length,planted,watered,ripe,harvested:0,sampleOnly:true}};
}
