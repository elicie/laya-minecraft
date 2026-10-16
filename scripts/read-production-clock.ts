import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
async function main(){
const db=new DatabaseSync('runtime/control.sqlite',{readOnly:true});const s=JSON.parse(String(db.prepare("select value from state where key='checkpoint'").get()!.value));db.close();
const a=s.agents.find((a:any)=>a.id===s.rules.baseAutonomy.botId);const b=await createCompatibleBot({...a.config.connection,username:'LayaReadOnly'});
try{await once(b,'spawn');await new Promise(r=>setTimeout(r,1800));const initial=b.entity.position.clone();console.log(JSON.stringify({timeOfDay:b.time.timeOfDay,worldAge:b.time.age,position:initial,health:b.health,unmoved:true}));if(process.argv.includes('--wait-day')){const end=Date.now()+900000;while(b.time.timeOfDay>1000&&b.health===20&&Date.now()<end)await new Promise(r=>setTimeout(r,1000));console.log(JSON.stringify({timeOfDay:b.time.timeOfDay,worldAge:b.time.age,health:b.health,unmoved:initial.equals(b.entity.position)}));}}
finally{b.quit('read-only clock observation complete');}

}
void main().catch(e=>{console.error(e);process.exitCode=1;});
