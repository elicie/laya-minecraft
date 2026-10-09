// Synthetic fixture validates viewer transport only, never presented as live gameplay.
const {EventEmitter}=require('node:events'),{Vec3}=require('vec3'),assert=require('node:assert/strict')
const {io}=require('socket.io-client')
const bot=new EventEmitter();bot.version='1.21.1';bot.username='TransportTest';bot.entities={};bot.entity={position:new Vec3(0,65,0),yaw:0,pitch:0};bot.world={getColumnAt:async()=>null}
require('prismarine-viewer').mineflayer(bot,{port:{port:3008,host:'127.0.0.1'},prefix:'/view',firstPerson:true,viewDistance:1})
const timeout=setTimeout(()=>{console.error('Viewer proxy timeout');process.exit(1)},10000)
;(async()=>{
 const r=await fetch('http://127.0.0.1:3000/view/');assert.equal(r.status,200);assert.ok((await r.text()).includes('Prismarine Viewer'))
 const socket=io('http://127.0.0.1:3000',{path:'/view/socket.io',transports:['websocket']})
 socket.on('version',v=>{assert.equal(v,'1.21.1');setTimeout(()=>bot.emit('move'),100)})
 socket.on('position',p=>{assert.equal(p.pos.y,65);assert.equal(p.pitch,0);console.log('PASS viewer static proxy and live WebSocket position stream (synthetic fixture)');socket.close();bot.viewer.close();clearTimeout(timeout)})
 socket.on('connect_error',e=>{throw e})
})().catch(e=>{console.error(e);process.exit(1)})
