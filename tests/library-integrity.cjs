const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'..'),manifest=require('../integrity/mineflayer-4.39.0.json'),pkg=require('../package.json')
assert.equal(pkg.dependencies.mineflayer,manifest.version,'Review the integrity manifest if updating the published version')
assert(!pkg.scripts?.postinstall,'Do not apply dependency patches during installation')
for(const [name,digest]of Object.entries(manifest.files)){
 const data=fs.readFileSync(path.join(root,'node_modules/mineflayer',name))
 assert.equal(crypto.createHash('sha256').update(data).digest('hex'),digest,`Mineflayer has been modified: ${name}`)
}
console.log(`PASS Mineflayer ${manifest.version}: ${Object.keys(manifest.files).length} published files unchanged; no installation patch`)
