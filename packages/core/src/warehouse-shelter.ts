import {BaseShelterSchema,type BaseShelter,type ContainerRef,type ExpectedBlock} from '../../contracts/src';

/** Only a verified, fully specified building can supply a warehouse doorway. */
export function warehouseShelter(container:ContainerRef,blocks:ExpectedBlock[]):BaseShelter|undefined{
  if(blocks.length<16||blocks.length>2048)return;
  const min={x:Math.min(...blocks.map(b=>b.position.x)),y:Math.min(...blocks.map(b=>b.position.y)),z:Math.min(...blocks.map(b=>b.position.z))};
  const max={x:Math.max(...blocks.map(b=>b.position.x)),y:Math.max(...blocks.map(b=>b.position.y)),z:Math.max(...blocks.map(b=>b.position.z))};
  if(max.x-min.x<4||max.z-min.z<4||max.y-min.y<3||max.y-min.y>5)return;
  const planned=new Map(blocks.map(b=>[`${b.position.x},${b.position.y},${b.position.z}`,b.name]));
  const doors=blocks.filter(b=>b.name.endsWith('_door')&&b.name!=='iron_door'&&b.position.y===min.y+1);
  for(const block of doors){
    const p=block.position,d=p.z===min.z?{x:0,z:1}:p.z===max.z?{x:0,z:-1}:p.x===min.x?{x:1,z:0}:p.x===max.x?{x:-1,z:0}:undefined;
    if(!d||planned.get(`${p.x},${p.y+1},${p.z}`)!==block.name)continue;
    const inside={x:p.x+d.x,y:p.y,z:p.z+d.z};if(planned.has(`${inside.x},${inside.y},${inside.z}`)||planned.has(`${inside.x},${inside.y+1},${inside.z}`))continue;
    return BaseShelterSchema.parse({warehouseId:container.id,world:container.world,dimension:container.dimension,door:p,inside,outside:{x:p.x-d.x,y:min.y,z:p.z-d.z},blocks});
  }
}
