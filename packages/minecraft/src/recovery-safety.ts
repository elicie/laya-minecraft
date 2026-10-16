import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { PositionSchema, type JsonObject, type Position } from '../../contracts/src';
import { HOSTILES } from './combat-policy';
import { recoveryThreatsClear, safeCombatRoute, safeCombatStand, stableCombatFooting } from './combat-retreat';
import { ConditionWait, type ActionServices } from './services';
import { walkingFeet } from './observations';
import { observedGroundRoute, observedGroundStand } from './observed-ground-walk';
import { centerSupportedCell, settleStandingFootprint } from './standing-footprint';
import { resourceClearance, safeResourceStand } from './resource-recovery';
import { alternateSafeWalk, walkCorner } from './safe-walk';

const cell = PositionSchema.refine(p => Object.values(p).every(Number.isInteger));
const schema = z.object({ anchor: cell, attempts: z.number().int().min(0).max(5), elapsedMs: z.number().nonnegative(), probes: z.array(z.object({ position: cell, name: z.string(), stateId: z.number().int().nonnegative().optional() })).max(128), status: z.enum(['searching', 'waiting', 'safe']), fingerprint: z.string().max(30000), reason: z.string().max(1000).default(''), displacements:z.array(z.object({from:cell,to:cell})).max(16).default([]) });
const vector = (p: Position) => new Vec3(p.x, p.y, p.z);
const plain = (p: Position): Position => ({ x: p.x, y: p.y, z: p.z });
const key = (p: Position) => `${p.x},${p.y},${p.z}`;

/** Item accounting is complete, but a cliff-adjacent respawn must leave its
 * stable starting tile before ordinary tasks can be admitted. */
export async function leaveRecoveryEdge(bot: Bot, s: ActionServices, now: () => number = Date.now): Promise<boolean> {
  s.check();
  const parsed = schema.safeParse(s.checkpoint.recoverySafety);
  const state = parsed.success ? parsed.data : { anchor: plain(walkingFeet(bot)), attempts: 0, elapsedMs: 0, probes: [], status: 'searching' as const, fingerprint: '', reason: '', displacements:[] as {from:Position;to:Position}[] };
  s.checkpoint.recoverySafety = state as unknown as JsonObject;
  const threats = () => Object.values(bot.entities).filter(e => HOSTILES.has(e.name ?? ''));
  const clear = (p: Position) => recoveryThreatsClear(bot,p);
  const sample = (p: Position) => {
    const q = vector(p).floored(), block = bot.blockAt(q); if (!block) return;
    state.probes = [...state.probes.filter(probe => key(probe.position) !== key(q)), { position: plain(q), name: block.name, ...(typeof block.stateId === 'number' ? { stateId: block.stateId } : {}) }].slice(-128);
  };
  const fingerprint = () => JSON.stringify({ healthReady: bot.health > s.rules.combat.retreatHealth, foodReady: bot.food > 6, coveredCurrentStand:clear(walkingFeet(bot)),
    blocks: state.probes.map(probe => { const actual = bot.blockAt(vector(probe.position)); return [key(probe.position), actual?.name ?? probe.name, actual?.stateId ?? probe.stateId]; }),
    threats: threats().filter(e => vector(e.position).distanceTo(vector(state.anchor)) < 32).map(e => `${e.id}:${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`).sort() });
  const waiting = (reason: string): false => { state.status = 'waiting'; state.fingerprint = fingerprint(); state.reason = reason; s.progress('안전 지면 대기', reason); return false; };
  let current = walkingFeet(bot);
  const leaf=bot.blockAt(current.offset(0,-1,0));
  // Version 1 charged synchronous preflight refusals as walking attempts.
  // Correct that one legacy signature; retain its elapsed time and archive it.
  if(leaf?.name.endsWith('_leaves')&&s.checkpoint.canopyExitVersion===1&&s.checkpoint.canopyExitPreflightRepair===undefined&&s.checkpoint.canopyExitSearch===undefined&&state.status==='waiting'&&state.attempts===5&&state.elapsedMs<500&&current.equals(vector(state.anchor))){
    s.checkpoint.canopyExitPreflightRepair={attempts:state.attempts,elapsedMs:state.elapsedMs,position:plain(current),observedAt:now()};state.attempts=0;
  }
  if(leaf?.name.endsWith('_leaves')&&bot.entity.onGround===true&&bot.health>s.rules.combat.retreatHealth&&bot.food>6&&!threats().some(e=>vector(e.position).distanceTo(current)<12)&&state.attempts<5&&state.elapsedMs<30000&&(s.checkpoint.canopyExitVersion!==3||state.status!=='waiting'||state.fingerprint!==fingerprint())){
    s.checkpoint.canopyExitVersion=3;const started=now(),before=vector(bot.entity.position),minimumThreatDistance=new Map(threats().map(e=>[e.id,Math.min(20,vector(e.position).distanceTo(before))]));
    const routes:JsonObject[]=[],diagnostic:JsonObject={from:plain(current),candidates:[],routes,threats:threats().map(e=>({name:e.name??'',position:plain(e.position)})),observedAt:now()};s.checkpoint.canopyExitSearch=diagnostic;
    const escapeClear=(p:Position)=>threats().every(e=>vector(e.position).distanceTo(vector(p))>=(minimumThreatDistance.get(e.id)??20)-.05);
    const stand=(p:Position)=>{
      const q=vector(p),support=bot.blockAt(q.offset(0,-1,0));for(const dy of [-1,0,1])sample(q.offset(0,dy,0));
      if(!escapeClear(q)||!resourceClearance(bot.blockAt(q))||!resourceClearance(bot.blockAt(q.offset(0,1,0))))return false;
      if(observedGroundStand(bot,q))return true;
      if(!support?.name.endsWith('_leaves')||support.boundingBox!=='block'||!support.shapes?.some(a=>a[0]===0&&a[1]===0&&a[2]===0&&a[3]===1&&a[4]===1&&a[5]===1))return false;
      return [[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dz])=>[0,-1].every(dy=>!['water','lava','fire','soul_fire','magma_block','cactus','campfire','soul_campfire','powder_snow','sweet_berry_bush'].includes(bot.blockAt(q.offset(dx!,dy,dz!))?.name??'')));
    };
    try{
      await s.pause(100);s.check();
      if(vector(bot.entity.position).distanceTo(before)>.02||!walkingFeet(bot).equals(current)||!stand(current))return waiting('나뭇잎 위의 실제 정지 발판과 위협을 다시 확인해야 합니다.');
      const candidates:Vec3[]=[];
      for(let dx=-12;dx<=12;dx++)for(let dz=-12;dz<=12;dz++)for(let dy=-8;dy<=2;dy++){
        const p=current.offset(dx,dy,dz);if(p.distanceTo(current)>12||!safeCombatStand(bot,p)||!safeResourceStand(bot,p,()=>false)||!threats().every(e=>vector(e.position).distanceTo(p.offset(.5,0,.5))>=21))continue;candidates.push(p);
      }
      candidates.sort((a,b)=>a.distanceTo(current)-b.distanceTo(current));
      diagnostic.candidates=candidates.slice(0,12).map(plain);
      for(const target of candidates.slice(0,12)){
        s.check();if(state.attempts>=5||state.elapsedMs+now()-started>=30000)break;
        const path=alternateSafeWalk(bot,target,{within:p=>vector(p).distanceTo(current)<=12,stand}),proof:JsonObject={target:plain(target),found:path!==undefined,steps:path?.length??0};routes.push(proof);if(!path?.length||path.length>64)continue;
        let charged=false;s.progress('안전 지면 이동','실제 온전한 나뭇잎 발판만 짧게 지나 기존의 안전한 지면으로 내려갑니다.');
        try{
          if(!await s.walkVerified?.(path,stand)){
            proof.mode='individual';state.attempts++;charged=true;
            const stepTo=async(p:Position)=>{
              s.check();if(state.elapsedMs+now()-started>=30000||!stand(p))throw new ConditionWait('나뭇잎 탈출의 실제 발판·위협 또는 이동 시간을 확인해야 합니다.');
              await centerSupportedCell(bot,s,stand);if(vector(bot.entity.position).distanceTo(walkingFeet(bot).offset(.5,0,.5))>.2)throw new ConditionWait('나뭇잎 탈출의 방향을 바꾸기 전에 현재 지지 칸에 몸을 정렬해야 합니다.');
              await s.near(vector(p).offset(.5,0,.5),0);
              for(let tick=0;tick<20&&(bot.entity.onGround!==true||Math.abs(bot.entity.position.y-p.y)>.05);tick++){s.check();await s.pause(50);}
              if(!walkingFeet(bot).equals(vector(p))||Math.abs(bot.entity.position.y-p.y)>.05||!stand(p))throw new ConditionWait('나뭇잎 탈출 발판의 실제 착지를 확인해야 합니다.');
            };
            for(const p of path){const from=walkingFeet(bot);if(from.x!==p.x&&from.z!==p.z){const middle=walkCorner(from,p,stand);if(!middle)throw new ConditionWait('나뭇잎 탈출의 직각 중간 발판이 필요합니다.');await stepTo(middle);}await stepTo(p);}
          }else{state.attempts++;charged=true;}
          for(let tick=0;tick<20&&(bot.entity.onGround!==true||Math.abs(bot.entity.position.y-target.y)>.05);tick++){s.check();await s.pause(50);}
          const landed=vector(bot.entity.position);await s.pause(100);const actual=walkingFeet(bot);
          if(bot.entity.onGround===true&&Math.abs(bot.entity.position.y-target.y)<.05&&vector(bot.entity.position).distanceTo(landed)<.08&&actual.equals(target)&&safeCombatStand(bot,actual)&&safeResourceStand(bot,actual,()=>false)&&clear(bot.entity.position)){state.anchor=plain(actual);state.status='safe';s.checkpoint.canopyExit={from:plain(current),to:plain(actual),observedAt:now()};return true;}
        }catch(error){if(!charged)state.attempts++;s.check();if(!(error instanceof ConditionWait))throw error;proof.reason=error.message.slice(0,500);}
      }
      return waiting('관측한 나뭇잎 발판에서 온전한 지면까지 이어지는 짧은 실제 경로가 필요합니다.');
    }finally{state.elapsedMs+=Math.max(0,now()-started);}
  }
  if(!stableCombatFooting(bot,current)&&state.attempts<5&&state.elapsedMs<30000&&(state.status!=='waiting'||state.fingerprint!==fingerprint()||s.checkpoint.footprintSettle===undefined)){
    const started=now();
    try{if(await settleStandingFootprint(bot,s,()=>{state.attempts++;})){current=walkingFeet(bot);state.anchor=plain(current);state.status='searching';if(safeCombatStand(bot,current)&&clear(current)){state.status='safe';return true;}}}
    finally{state.elapsedMs+=Math.max(0,now()-started);}
  }
  // Combat may have physically moved the same body beyond this local safety
  // area. Inspect its real new footing without recreating any spent allowance.
  if (current.distanceTo(vector(state.anchor))>12 && bot.health>s.rules.combat.retreatHealth && bot.food>6 && stableCombatFooting(bot,current) && clear(current)) {
    const before=vector(bot.entity.position);await s.pause(100);s.check();
    if (vector(bot.entity.position).distanceTo(before)<.08 && walkingFeet(bot).equals(current) && stableCombatFooting(bot,current) && clear(current)) {
      state.displacements=[...state.displacements,{from:{...state.anchor},to:plain(current)}].slice(-16);state.anchor=plain(current);state.status='searching';state.reason='실제로 이동한 현재 지지 발판에서 남은 안전 이동을 확인합니다.';
    }
  }
  if (state.status === 'waiting') {
    if (state.fingerprint === fingerprint()) return waiting('사망 아이템 처리는 끝났지만 현재 발판에서 벗어날 안전한 경로의 실제 변화를 기다립니다.');
    state.attempts = 0; state.elapsedMs = 0; state.status = 'searching';
  }
  sample(current); sample(current.offset(0, -1, 0)); sample(current.offset(0, 1, 0));
  if (bot.health <= s.rules.combat.retreatHealth || bot.food <= 6 || !clear(current)) return waiting('체력·허기와 주변 위협을 먼저 확인해야 안전한 지면으로 이동할 수 있습니다.');
  if (!stableCombatFooting(bot, current, () => false, sample)) return waiting('현재 발판·머리 공간이 미관측이거나 위험해 안전한 이동 시작을 확인할 수 없습니다.');
  if (state.attempts >= 5 || state.elapsedMs >= 30000) return waiting('안전 지면 이동의 시도를 소진했습니다. 실제 지형이나 위협의 변화를 기다립니다.');
  const candidates: Vec3[] = [];
  for (const radius of [1, 2, 4, 8]) for (let angle = 0; angle < 16; angle++) {
    const x = current.x + Math.round(Math.cos(angle * Math.PI / 8) * radius), zz = current.z + Math.round(Math.sin(angle * Math.PI / 8) * radius);
    for (const dy of [0, 1, -1]) {
      const p = new Vec3(x, current.y + dy, zz);
      if (p.equals(current) || candidates.some(q => q.equals(p)) || Math.hypot(p.x - state.anchor.x, p.z - state.anchor.z) > 12 || !safeCombatStand(bot, p, () => false, sample) || !clear(p)) continue;
      candidates.push(p); break;
    }
  }
  candidates.sort((a, b) => a.distanceTo(current) - b.distanceTo(current));
  const started = now();
  try {
    for (const destination of candidates.slice(0, 32)) {
      s.check(); if (state.attempts >= 5 || state.elapsedMs + now() - started >= 30000) break;
      const route = safeCombatRoute(bot, destination, { anchor: state.anchor, radius: 12, leaveUnsafeEdge: true, onProbe: sample });
      const path=route.safe?route.path:observedGroundRoute(bot,destination,12,p=>sample(p));
      if (!path || path.some(p => !clear(p))) continue;
      state.attempts++; s.progress('안전 지면 이동', '사망 아이템 처리는 끝났으므로 실제로 확인한 가까운 안전한 발판으로 이동해 작업을 재개합니다.');
      try {
        for (const step of path) {
          s.check();
          if (!(safeCombatStand(bot, step, () => false, sample)||observedGroundStand(bot,step)) || !clear(step)) throw new ConditionWait('안전 지면 이동 중 경로나 위협이 바뀌었습니다.');
          await s.near(vector(step).offset(0.5, 0, 0.5), 0);
        }
        if (bot.entity.position.distanceTo(destination.offset(0.5, 0, 0.5)) <= 1.5 && safeCombatStand(bot, bot.entity.position) && clear(bot.entity.position)) { state.status = 'safe'; return true; }
      } catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; }
    }
    return waiting('현재 발판에서 가까운 안전한 지면까지 이어지는 실제 경로를 확인하지 못했습니다.');
  } finally { state.elapsedMs += Math.max(0, now() - started); }
}
