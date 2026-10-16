import type {Goal,Task} from '../../contracts/src';
import type catalog from '../../contracts/src/base-decisions.json';
export function baseDecisionAction(task:Task,goal:Goal):keyof typeof catalog.criteria|undefined{
 const step=goal.input.params.baseSupplyStep;
 if(step==='seed-stock')return'seed_supply';if(step==='wood-stock')return'wood_supply';if(step==='farm-setup'||typeof step==='string'&&step.startsWith('farm-expand-'))return'farm_setup';if(step==='farm-harvest')return'farm_harvest';if(step==='bread-batch')return'bake_food';
 if(task.kind==='farm')return task.params.mode==='harvest'?'farm_harvest':'farm_setup';
 if(task.kind==='collect'){if(task.params.item==='wheat_seeds')return'seed_supply';if(typeof task.params.item==='string'&&task.params.item.endsWith('_log'))return'wood_supply';}
 if(task.kind==='store')return'warehouse_store';if(task.kind==='take')return'warehouse_take';if(task.kind==='explore')return'explore';
 if(task.kind==='craft'){if(task.params.item==='bread')return'bake_food';if(typeof task.params.item==='string'&&/_(hoe|pickaxe|axe|sword|shovel)$/.test(task.params.item))return'tool_craft';}
 if(task.kind==='home'&&task.params.basePassage==='inside')return'base_return';
}
