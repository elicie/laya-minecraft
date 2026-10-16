import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';

// This account only observes loaded blocks. It never moves or interacts.
async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Provide the observation output path');
  const snapshot = await fetch('http://127.0.0.1:3001/api/v1/snapshot').then(r => r.json()) as any;
  const farmer = snapshot.agents.find((a: any) => a.id === snapshot.rules.baseAutonomy.botId);
  const bot = await createCompatibleBot({ ...farmer.config.connection, username: 'LayaReadOnly' });
  try {
    await once(bot, 'spawn');
    await new Promise(resolve => setTimeout(resolve, 2200));
    const initial = bot.entity.position.clone();
    const plots = snapshot.rules.baseAutonomy.positions.map((p: any) => {
      const soil = bot.blockAt(new Vec3(p.x, p.y, p.z));
      const crop = bot.blockAt(new Vec3(p.x, p.y + 1, p.z));
      return { position: p, soil: soil && { name: soil.name, stateId: soil.stateId, properties: soil.getProperties() },
        crop: crop && { name: crop.name, stateId: crop.stateId, properties: crop.getProperties() } };
    });
    const record = { observedAt: new Date().toISOString(), source: 'read-only public block observations',
      world: snapshot.rules.world, worldAge: bot.time.age, timeOfDay: bot.time.timeOfDay,
      observerPosition: initial, unmoved: initial.equals(bot.entity.position), plots };
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record));
  } finally { bot.quit('read-only field observation complete'); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
