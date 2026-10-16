import {itemCount,sameContainer,type Goal,type GoalInput,type Observation,type Rules} from '../../contracts/src';
import {freshObservations} from './verification';

/** Bounded food production from observed warehouse stock and completed work. */
export function baseSupplyGoals(rules:Rules,goals:Goal[],observations:Observation[],now:number,epoch:string):GoalInput[]{
 const farm=rules.baseAutonomy,warehouse=rules.warehouse,base=rules.baseShelter;if(!farm||!warehouse||!base)return[];
 const result:GoalInput[]=[],owned=goals.filter(g=>g.input.params.baseSupplyId===farm.id&&g.state!=='cancelled'),step=(name:string)=>owned.filter(g=>g.input.params.baseSupplyStep===name);
 const add=(name:string,input:GoalInput)=>result.push({...input,source:'autonomous',preferredBotId:farm.botId,params:{...input.params,baseSupplyId:farm.id,baseSupplyStep:name,useBaseDoor:true}});
 const stock=freshObservations({observations:observations.filter(o=>o.controllerEpoch===epoch),now,maxAgeMs:rules.observationMaxAgeMs,world:warehouse.world,dimension:warehouse.dimension}).filter(o=>o.kind==='container'&&sameContainer(o.data.container,warehouse)).sort((a,b)=>b.observedAt-a.observedAt||b.receivedAt-a.receivedAt)[0];
 for(const [name,item,quantity]of [['seed-stock','wheat_seeds',farm.positions.length],['wood-stock','oak_log',farm.woodTarget]] as const)if(!step(name).length)add(name,{kind:'collect',item,quantity,mode:'maintain',priority:name==='seed-stock'?14:10,params:{batchSize:2,returnTo:base.outside}});
 if(!stock||stock.kind!=='container')return result;
 const count=(item:string)=>itemCount(stock.data.items,item);
 const setup=step('farm-setup')[0],initialPlots=Math.min(farm.positions.length,count('wheat_seeds'));
 if(!setup&&initialPlots>=Math.min(2,farm.positions.length)&&count('oak_log')>=1)add('farm-setup',{kind:'farm',priority:15,params:{id:farm.id,crop:'wheat',mode:'setup',plots:initialPlots,origin:farm.origin,positions:farm.positions.slice(0,initialPlots),warehouseInputs:[{item:'wheat_seeds',quantity:initialPlots},{item:'oak_log',quantity:1}],prepareHoe:true}});
 if(setup?.state!=='completed')return result;
 const expansions=owned.filter(g=>String(g.input.params.baseSupplyStep).startsWith('farm-expand-')),planted=Math.min(farm.positions.length,Math.max(Number(setup.input.params.plots??farm.positions.length),...expansions.filter(g=>g.state==='completed').map(g=>Number(g.input.params.plots))));
 const additional=Math.min(farm.positions.length-planted,count('wheat_seeds'));
 if(additional>0&&!expansions.some(g=>!['completed','cancelled'].includes(g.state))){const plots=planted+additional;add(`farm-expand-${plots}`,{kind:'farm',priority:15,params:{id:farm.id,crop:'wheat',mode:'setup',plots,origin:farm.origin,positions:farm.positions.slice(0,plots),warehouseInputs:[{item:'wheat_seeds',quantity:additional}],prepareHoe:false}});}
 const observedFarm=freshObservations({observations:observations.filter(o=>o.controllerEpoch===epoch),now,maxAgeMs:rules.observationMaxAgeMs,world:rules.world,dimension:rules.dimension}).filter(o=>o.kind==='farm'&&o.data.id===farm.id).sort((a,b)=>b.observedAt-a.observedAt||b.receivedAt-a.receivedAt)[0];
 if(observedFarm?.kind==='farm'&&observedFarm.data.ripe>0&&count('wheat_seeds')>=planted&&!step('farm-harvest').some(g=>!['completed','cancelled'].includes(g.state)))add('farm-harvest',{kind:'farm',quantity:1,priority:17,params:{id:farm.id,crop:'wheat',mode:'harvest',plots:planted,origin:farm.origin,positions:farm.positions.slice(0,planted),warehouseInputs:[{item:'wheat_seeds',quantity:planted}]}});
 if(count('bread')<farm.breadTarget&&count('wheat')>=3&&!step('bread-batch').some(g=>!['completed','cancelled'].includes(g.state)))add('bread-batch',{kind:'craft',item:'bread',quantity:1,quantityMode:'additional',priority:18,params:{recipeFromWarehouse:true}});
 return result;
}
