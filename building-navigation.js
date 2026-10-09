// Door traversal belongs to our navigation layer. No library movement or
// collision methods are replaced; only public client controls are used.
async function crossDoor(bot,route,token,{check,walk,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 check(token);await walk(route.from,0,token);check(token)
 const door=bot.blockAt(route.door)
 if(!door?.name.endsWith('_door')||door.name==='iron_door')throw new Error('건물 출입문을 확인하지 못했습니다.')
 if(!door.getProperties().open){await bot.activateBlock(door);await sleep(150);check(token)}
 await bot.lookAt(route.to.offset(.5,1,.5),true)
 const until=Date.now()+5000;bot.setControlState('forward',true);bot.setControlState('jump',route.to.y>bot.entity.position.y+.1)
 try{
  while(Date.now()<until){check(token);bot.setControlState('jump',route.to.y>bot.entity.position.y+.1);if(bot.entity.position.distanceTo(route.to.offset(.5,0,.5))<.65)return;await sleep(75)}
  throw new Error('출입문 통과가 막혔습니다. 입구와 주변 장애물을 확인합니다.')
 }finally{bot.setControlState('forward',false);bot.setControlState('jump',false)}
}
async function climbLadder(bot,route,token,{check,walk,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 check(token);await walk(route.entry||route.bottom,0,token);check(token)
 for(let y=route.bottom.y;y<route.top.y;y++)if(bot.blockAt(route.bottom.offset(0,y-route.bottom.y,0))?.name!=='ladder')throw new Error('탑 사다리 연결을 확인하지 못했습니다.')
 const until=Date.now()+10000;bot.setControlState('sneak',false);bot.setControlState('sprint',false)
 try{while(Math.hypot(route.bottom.x+.5-bot.entity.position.x,route.bottom.z+.5-bot.entity.position.z)>.16&&Date.now()<until){check(token);await bot.lookAt(route.bottom.offset(.5,1.62,.5),true);bot.setControlState('forward',true);await sleep(50)}
  while(Date.now()<until){check(token);if(bot.entity.position.y>=route.top.y-.05&&bot.entity.position.distanceTo(route.top.offset(.5,0,.5))<.65)return
   const reached=bot.entity.position.y>=route.top.y-.05
   await bot.lookAt(reached?route.top.offset(.5,1.62,.5):route.wall.offset(.5,bot.entity.position.y-route.wall.y+1.62,.5),true)
   bot.setControlState('forward',true);bot.setControlState('jump',!reached);await sleep(50)
  }throw new Error('탑 사다리 이동이 막혔습니다. 통로를 확인합니다.')
 }finally{bot.setControlState('forward',false);bot.setControlState('jump',false)}
}
module.exports={crossDoor,climbLadder}
