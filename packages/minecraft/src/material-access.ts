import {MaterialAccessPlanSchema,type Position,type TaskSpec,type ResultPayload} from '../../contracts/src';
import {ConditionWait,type ActionServices} from './services';
import {observedGroundStand} from './observed-ground-walk';
import {vector,walkingFeet,observationBase} from './observations';
import {HOSTILES} from './combat-policy';

/** Explicit, bounded soil cuts and non-falling footholds for a material quarry. */
export async function prepareMaterialAccess(task:TaskSpec,s:ActionServices,protectedPosition:(p:Position)=>boolean,permitted:()=>boolean):Promise<ResultPayload>{
  const plan=MaterialAccessPlanSchema.parse(task.params.access),b=s.bot,origin=vector(plan.edits[0]!.stand),cells=plan.edits.map(e=>e.position);
  const wait=(reason:string):never=>{s.checkpoint.waitingFor={kind:'blocks',causeCode:'BUILD_ACCESS',positions:cells,watchPosition:true,watchSafety:true};throw new ConditionWait(reason,s.checkpoint);};
  if(task.source!=='user'||!permitted())wait('명시한 사용자 자원 접근 계획과 건축·수집 권한이 필요합니다.');
  if(plan.edits.some(e=>protectedPosition(e.position)||Math.hypot(e.position.x-origin.x,e.position.z-origin.z)>48||Math.abs(e.position.y-origin.y)>8))wait('자원 접근로의 보호 구역과 실제 제한 범위를 확인해야 합니다.');
  const clear=()=>permitted()&&b.health>s.rules.combat.supportHealth&&b.food>6&&!Object.values(b.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(b.entity.position)<20);
  const needed=plan.edits.filter(e=>e.after==='oak_planks'&&b.blockAt(vector(e.position))?.name!=='oak_planks').length,stock=(name:string)=>b.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
  if(stock('oak_planks')<needed){if(stock('oak_log')*4+stock('oak_planks')<needed)wait('접근로 판자를 만들 실제 소지 목재가 필요합니다.');await s.ensureItem('oak_planks',needed);}
  s.checkpoint.safeDetourRequired=true;
  for(let index=0;index<plan.edits.length;index++){
    s.check();if(!clear())wait('자원 접근로를 정리하기 전 실제 체력·허기와 위협을 확인해야 합니다.');
    const edit=plan.edits[index]!,p=vector(edit.position),actual=b.blockAt(p),pending=s.checkpoint.materialAccessPending as {index?:number;cleared?:boolean;phase?:string}|undefined;
    if(actual?.name===edit.after)continue;
    if(!actual||actual.name!==edit.before&&!(actual.name==='air'&&pending?.index===index&&(pending.cleared===true||pending.phase==='digging')))wait('자원 접근로의 실제 원래 블록이 명시한 관측과 다릅니다.');
    await s.near(vector(edit.stand).offset(.5,0,.5),0);await s.pause(100);
    for(let tick=0;tick<20&&(b.entity.onGround!==true||Math.abs(b.entity.position.y-edit.stand.y)>.1);tick++){s.check();await s.pause(50);}
    const feet=walkingFeet(b);
    if(b.entity.onGround!==true||!observedGroundStand(b,feet)||!clear())wait('자원 접근로 편집의 실제 안정 발판과 주변을 확인해야 합니다.');
    if(p.x===feet.x&&p.z===feet.z&&p.y<=feet.y+1)wait('현재 몸·머리와 지지체 아래를 자원 접근로 편집으로 파지 않습니다.');
    const current=b.blockAt(p),sandBefore=b.inventory.items().filter(i=>i.name==='sand').reduce((n,i)=>n+i.count,0);
    if(!current)wait('자원 접근로 블록이 아직 관측되지 않았습니다.');
    if(current!.name!=='air'){
      if(current!.name!==edit.before||!b.canSeeBlock(current!)||!b.canDigBlock(current!)||!clear())wait('직접 보이고 실제 채굴 거리가 확인된 명시한 흙·모래만 정리합니다.');
      const above=b.blockAt(p.offset(0,1,0));if(!above||['sand','red_sand','gravel'].includes(above.name))wait('접근로 위의 낙하 블록을 제거 계획 없이 지지체부터 파지 않습니다.');
      s.progress('자원 접근로 정리',`실제 관측한 흙·모래를 정리합니다 (${index+1}/${plan.edits.length}).`);
      s.checkpoint.materialAccessPending={index,phase:'digging'};await b.dig(current!);s.checkpoint.materialAccessPending={index,cleared:true};await s.pause(150);
    }
    if(edit.after==='oak_planks'){
      if(!b.inventory.items().some(i=>i.name==='oak_planks'&&i.count>0))wait('자원 접근 발판에 놓을 실제 판자가 필요합니다.');
      await s.place(edit.position,'oak_planks','oak_planks');
    }
    if(b.blockAt(p)?.name!==edit.after)wait('정리한 자원 접근로 블록의 실제 결과를 확인해야 합니다.');
    if(edit.before==='sand')await s.recoverDrops?.(edit.position,'sand',sandBefore+1);
    s.checkpoint.materialAccessCompleted=index+1;delete s.checkpoint.materialAccessPending;s.observations.push(s.observeInventory());
  }
  await s.near(vector(plan.exit).offset(.5,0,.5),0);await s.pause(150);
  if(!observedGroundStand(b,b.entity.position)||!clear())wait('정리한 접근로의 실제 출구와 안전한 지면을 확인해야 합니다.');
  const blocks=cells.flatMap(p=>{const actual=b.blockAt(vector(p));return actual?[{position:p,name:actual.name}]:[];});
  s.observations.push(s.observeInventory(),{...observationBase(s.rules.world,s.rules.dimension),kind:'blocks',data:{blocks}});delete s.checkpoint.waitingFor;
  return {outcome:'completed',checkpoint:s.checkpoint,observations:s.observations,evidence:s.evidence,reason:'명시한 자연 지형 정리와 실제 접근 발판·출구를 확인했습니다.'};
}
