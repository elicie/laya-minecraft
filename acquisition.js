const {itemInfo}=require('./catalog')
const sources={cobblestone:{blocks:['stone','cobblestone'],tool:'wooden_pickaxe'},raw_iron:{blocks:['iron_ore','deepslate_iron_ore'],tool:'stone_pickaxe'},raw_gold:{blocks:['gold_ore','deepslate_gold_ore'],tool:'iron_pickaxe'},coal:{blocks:['coal_ore','deepslate_coal_ore'],tool:'wooden_pickaxe'},diamond:{blocks:['diamond_ore','deepslate_diamond_ore'],tool:'iron_pickaxe'},redstone:{blocks:['redstone_ore','deepslate_redstone_ore'],tool:'iron_pickaxe'},lapis_lazuli:{blocks:['lapis_ore','deepslate_lapis_ore'],tool:'stone_pickaxe'},obsidian:{blocks:['obsidian'],tool:'diamond_pickaxe'},flint:{blocks:['gravel']},sand:{blocks:['sand']},dirt:{blocks:['dirt','grass_block']},wheat_seeds:{blocks:['short_grass','tall_grass']},sugar_cane:{blocks:['sugar_cane']}}
const smelts={iron_ingot:'raw_iron',gold_ingot:'raw_gold',glass:'sand',stone:'cobblestone',charcoal:'oak_log',cooked_beef:'beef',cooked_porkchop:'porkchop',cooked_chicken:'chicken',cooked_mutton:'mutton',cooked_rabbit:'rabbit',cooked_cod:'cod',cooked_salmon:'salmon',baked_potato:'potato'}
const drops={beef:'cow',leather:'cow',porkchop:'pig',chicken:'chicken',feather:'chicken',mutton:'sheep',white_wool:'sheep',rabbit:'rabbit',string:'spider',bone:'skeleton',arrow:'skeleton',ender_pearl:'enderman',blaze_rod:'blaze'}
function chooseRecipe(name,inventory){
 const count=n=>inventory.filter(i=>i.name===n).reduce((a,i)=>a+i.count,0),memo=new Map()
 function cost(n,trail=[]){if(count(n)>0)return 0.01;if(trail.includes(n)||trail.length>9)return 1e6;if(memo.has(n))return memo.get(n)
  const source=sourceFor(n);if(source)return n.endsWith('_log')?4:({cobblestone:2,cobbled_deepslate:5,obsidian:80,diamond:50}[n]||10)
  if(smelts[n])return cost(smelts[n],[...trail,n])+3
  if(drops[n])return 30
  const recipes=itemInfo(n)?.recipes||[];const value=recipes.length?Math.min(...recipes.map(r=>r.ingredients.reduce((sum,i)=>sum+i.count*cost(i.name,[...trail,n]),0)/r.count+1)):1e5;memo.set(n,value);return value
 }
 function score(r){return r.ingredients.reduce((sum,i)=>sum+Math.max(0,i.count-count(i.name))*cost(i.name,[name]),0)/r.count}
 return (itemInfo(name)?.recipes||[]).filter(r=>r.ingredients.length&&r.ingredients.every(i=>i.name!==name)).sort((a,b)=>score(a)-score(b))[0]
}
function sourceFor(name){return sources[name]||(name==='cobbled_deepslate'?{blocks:['deepslate','cobbled_deepslate'],tool:'wooden_pickaxe'}:null)||(/_log$/.test(name)?{blocks:[name]}:null)}
function materialPlan(name,quantity,inventory,trail=[]){
 const have=inventory.filter(i=>i.name===name).reduce((a,i)=>a+i.count,0),node={item:name,have,need:quantity,missing:Math.max(0,quantity-have),children:[]};if(!node.missing)return node
 if(trail.includes(name)||trail.length>12){node.method='dependency_cycle';return node}
 if(smelts[name]){node.method='smelt';const fuel=inventory.find(i=>i.name.endsWith('_planks'))?.name||inventory.find(i=>i.name.endsWith('_log'))?.name.replace('_log','_planks')||'oak_planks';node.children=[materialPlan(smelts[name],node.missing,inventory,[...trail,name]),materialPlan(fuel,Math.ceil(node.missing/1.5),inventory,[...trail,name])];return node}
 if(sourceFor(name)){node.method='collect';const tool=sourceFor(name).tool;if(tool)node.children=[materialPlan(tool,1,inventory,[...trail,name])];return node}
 if(drops[name]){node.method='hunt';node.source=drops[name];return node}
 const recipe=chooseRecipe(name,inventory);if(!recipe){node.method='unknown_source';return node}
 node.method='craft';const batches=Math.ceil(node.missing/recipe.count);node.children=recipe.ingredients.map(i=>materialPlan(i.name,i.count*batches,inventory,[...trail,name]));return node
}
function createAcquisition(bot,hooks){
 const {check,collectDrop,craft,table,smelt,huntMob}=hooks
 const items=()=> (bot.currentWindow||bot.inventory).items(),count=n=>items().filter(i=>i.name===n).reduce((a,i)=>a+i.count,0)
 async function acquire(name,target,token,trail=[]){
  check(token);if(!bot.registry.itemsByName[name]||!Number.isInteger(target)||target<1||target>512)throw new Error('아이템 또는 수량이 올바르지 않습니다.')
  if(count(name)>=target)return
  if(trail.includes(name)||trail.length>12)throw new Error(`재료 경로가 순환합니다: ${[...trail,name].join(' → ')}`)
  const next=[...trail,name],missing=target-count(name),source=sourceFor(name)
  if(smelts[name]){const input=name==='charcoal'?(items().find(i=>i.name.endsWith('_log'))?.name||bot.findBlock({matching:b=>b.name.endsWith('_log'),maxDistance:40})?.name||'oak_log'):smelts[name];await acquire(input,missing,token,next);for(let left=missing;left>0;left-=32){await smelt(input,name,Math.min(32,left),token);check(token)}}
  else if(source){
   if(source.tool){const rank={wooden_pickaxe:1,stone_pickaxe:2,iron_pickaxe:3,diamond_pickaxe:4,netherite_pickaxe:5};if(!items().some(i=>(rank[i.name]||0)>=rank[source.tool]&&require('./resource-collector').toolLife(i)>2))await acquire(source.tool,count(source.tool)+1,token,next)}
   hooks.onResource?.(source.blocks);await collectDrop(source.blocks,name,target,token)
  }else if(drops[name]){for(let i=0;i<Math.min(12,missing*3)&&count(name)<target;i++){check(token);await huntMob(drops[name],token)}}
  else{const nearby=bot.findBlock({matching:b=>b.name.endsWith('_log'),maxDistance:40});const recipe=chooseRecipe(name,[...items(),...(nearby?[{name:nearby.name,count:1},{name:nearby.name.replace('_log','_planks'),count:1}]:[])]);if(!recipe)throw new Error(`${name}의 획득 경로가 아직 등록되지 않았어요.`);const batches=Math.ceil(missing/recipe.count);const needsTable=!bot.recipesAll(bot.registry.itemsByName[name].id,null,null).length;if(needsTable)await table(token);for(let pass=0;pass<8&&recipe.ingredients.some(i=>count(i.name)<i.count*batches);pass++){for(const ingredient of recipe.ingredients)await acquire(ingredient.name,ingredient.count*batches,token,next)}if(recipe.ingredients.some(i=>count(i.name)<i.count*batches))throw new Error('선행 제작에 소모된 재료를 다시 확보하지 못했습니다.');await craft(name,batches,needsTable?await table(token):null,token)}
  if(count(name)<target)throw new Error(`${name}: ${count(name)}/${target}개 확보. 추가 수집이 필요합니다.`)
 }
 return {acquire}
}
module.exports={createAcquisition,materialPlan,chooseRecipe,sourceFor,smelts,drops}
