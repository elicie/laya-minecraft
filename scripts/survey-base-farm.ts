import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import {Vec3} from 'vec3';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
async function main(){
 const snapshot=await fetch('http://127.0.0.1:3001/api/v1/snapshot?view=dashboard').then(r=>r.json()) as any;
 const a=snapshot.agents.find((a:any)=>a.id===snapshot.rules.baseAutonomy.botId),bot=await createCompatibleBot({...a.config.connection,username:'LayaReadOnly'});
 try{await once(bot,'spawn');await new Promise(r=>setTimeout(r,1200));const start=bot.entity.position.clone(),o=snapshot.rules.baseAutonomy.origin,blocks:any[]=[];
 for(let x=o.x-9;x<=o.x+9;x++)for(let z=o.z-9;z<=o.z+9;z++)for(let y=o.y-1;y<=o.y+2;y++){const b=bot.blockAt(new Vec3(x,y,z));if(b)blocks.push({position:{x,y,z},name:b.name,shapes:b.shapes,properties:b.getProperties()});}
 const record={observedAt:Date.now(),world:snapshot.rules.world,observerPosition:start,unmoved:start.equals(bot.entity.position),health:bot.health,blocks};writeFileSync(process.argv[2]??'/tmp/laya-ops-farm-survey.json',JSON.stringify(record));console.log(JSON.stringify({blocks:blocks.length,unmoved:record.unmoved,health:bot.health}));
 }finally{bot.quit('read-only farm survey complete');}
}void main().catch(e=>{console.error(e);process.exitCode=1;});
