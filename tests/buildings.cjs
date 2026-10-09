const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Vec3}=require('vec3'),{createStructures,blueprint}=require('../structures')
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-building-unit-')),origin={x:4,y:65,z:4},key=`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}:overworld:house`
try{
 function setup(name,blockAt){const file=path.join(dir,name+'.json');fs.writeFileSync(file,JSON.stringify({[key]:{origin,wood:'oak',version:2}}));return createStructures({game:{dimension:'overworld'},inventory:{items:()=>[]},blockAt},{},file)}
 const air=()=>({name:'air',getProperties:()=>({})})
 const empty=setup('empty',air);assert.equal(empty.status('house').version,3,'only wholly observed, unbuilt old plans can adopt the new house')
 assert(empty.protects(new Vec3(4,65,4)),'protect the planned foundation from path excavation');assert(!empty.protects(new Vec3(20,65,20)))
 const partial=setup('partial',p=>p.equals(new Vec3(4,65,4))?{name:'oak_planks'}:air());assert.equal(partial.status('house').version,2,'never change an already started house');assert.equal(partial.status('house').total,blueprint('house',origin,2).length)
 const distant=setup('distant',()=>null);assert.equal(distant.status('house').version,2,'an unloaded house is not an empty house');assert(distant.status('house').unloaded>0);assert.deepEqual(distant.pendingMaterials('house'),[],'observe the old site before assuming materials are missing')
 const doors=setup('door',p=>p.equals(new Vec3(7,66,4))?{name:'oak_door'}:p.equals(new Vec3(4,65,4))?{name:'oak_planks'}:air())
 const entering=doors.doorCrossing(new Vec3(15,65,-5),new Vec3(8,66,8));assert(entering);assert.deepEqual(entering.from,new Vec3(7,65,2));assert.deepEqual(entering.to,new Vec3(7,66,6));assert.equal(doors.doorCrossing(new Vec3(8,66,7),new Vec3(8,66,8)),null,'already indoors requires no doorway detour')
 console.log('PASS unbuilt-only design migration, preserve started/unloaded houses, foundation protection, reload before gathering and bounded known-house doorway routing')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
