import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync,sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { authorizeLocal,validateConfig,boundedBody } from '../app/security.mjs';
import { topupRequest,REPOSITORY } from '../app/support.mjs';
import { verifyManifest,sha256,applyStaged,RELEASE_FILES,newer,download } from '../app/updater.mjs';
test('local panel rejects foreign origins, DNS rebinding and cross-site requests',()=>{
 const hosts=new Set(['127.0.0.1:4777','localhost:4777']);
 assert(authorizeLocal({headers:{host:'127.0.0.1:4777',origin:'http://127.0.0.1:4777'}},hosts));
 for(const headers of [{host:'attacker.test:4777'},{host:'127.0.0.1:4777',origin:'https://attacker.test'},{host:'127.0.0.1:4777','sec-fetch-site':'cross-site'},{host:'127.0.0.1:4777',origin:'null'}])assert(!authorizeLocal({headers},hosts));
});
test('credentials can only be sent to the intended service',()=>{
 const good={apiBase:'https://api.gserver.online',devKey:'sk-dev-'+'a'.repeat(40),dashboardPort:4777};assert.equal(validateConfig(good),good);
 for(const apiBase of ['https://evil.test','http://api.gserver.online','https://api.gserver.online@evil.test','https://api.gserver.online/extra'])assert.throws(()=>validateConfig({...good,apiBase}));
 assert.throws(()=>validateConfig({...good,funpayBaseUrl:'https://evil.test'}));
});
test('body limit handles bytes and refuses oversized requests',async()=>{
 const request=Readable.from([Buffer.alloc(16385)]);request.headers={};await assert.rejects(boundedBody(request),/too large/);
});
test('topup only composes a Telegram message; price is not payment confirmation',()=>{
 const result=topupRequest({wallet:'api_tokens',amount:100,reseller:{id:8,username:'shop'},pricing:{apiRubPerMillion:3}});
 assert.equal(new URL(result.url).hostname,'t.me');assert.equal(new URL(result.url).pathname,'/neva_glamur67');assert.match(result.text,/300.00 ₽/);assert.match(result.text,/ID 8/);assert.match(result.text,/После проверки оплаты/);
 assert.throws(()=>topupRequest({wallet:'owner',amount:100}));assert.throws(()=>topupRequest({wallet:'smm',amount:-1}));
});
const keys=generateKeyPairSync('ed25519');
function envelope(manifest,key=keys.privateKey){const bytes=Buffer.from(JSON.stringify(manifest));return {payload:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64')};}
function manifest(){return {repository:REPOSITORY,version:'1.4.1',issuedAt:Date.now()-1000,expiresAt:Date.now()+86400000,files:[...RELEASE_FILES].map(name=>({name,size:3,sha256:sha256(Buffer.from('new'))}))};}
test('signed updates reject tampering, wrong publisher, expired metadata and traversal',()=>{
 const m=manifest();assert.equal(verifyManifest(envelope(m),keys.publicKey).version,'1.4.1');
 assert.throws(()=>verifyManifest({...envelope(m),payload:Buffer.from('{}').toString('base64')},keys.publicKey));
 assert.throws(()=>verifyManifest(envelope(m),generateKeyPairSync('ed25519').publicKey));
 assert.throws(()=>verifyManifest(envelope({...m,expiresAt:Date.now()-1}),keys.publicKey));
 m.files[0].name='../data/config.json';assert.throws(()=>verifyManifest(envelope(m),keys.publicKey));
 assert(newer('1.4.1','1.4.0'));assert(!newer('1.3.9','1.4.0'));assert(!newer('1.4.0','1.4.0'));
});
test('updater refuses untrusted URLs before making a request',async()=>{
 let called=false;const fake=()=>{called=true;throw new Error();};await assert.rejects(download('https://evil.test/update',100,fake));assert(!called);
});
test('installation preserves configuration, history and custom texts and rolls back failed writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astra-update-'));const stage=join(dir,'stage');await mkdir(stage);await mkdir(join(dir,'data'));
 const m=manifest();for(const f of m.files){await writeFile(join(stage,f.name),'new');await writeFile(join(dir,f.name),'old');}
 await writeFile(join(dir,'data/config.json'),'private-local-config');await writeFile(join(dir,'data/state.json'),'order-history');
 let calls=0;const {rename}=await import('node:fs/promises');
 await assert.rejects(applyStaged({dir,stage,manifest:m,move:async(a,b)=>{if(++calls===3)throw new Error('simulated disk failure');await rename(a,b);}}));
 assert.equal(await readFile(join(dir,'bot.mjs'),'utf8'),'old');assert.equal(await readFile(join(dir,'start.sh'),'utf8'),'old');
 await applyStaged({dir,stage,manifest:m});
 assert.equal(await readFile(join(dir,'bot.mjs'),'utf8'),'new');assert.equal(await readFile(join(dir,'knowledge.md'),'utf8'),'old');assert.equal(await readFile(join(dir,'knowledge.md.new'),'utf8'),'new');
 assert.equal(await readFile(join(dir,'data/config.json'),'utf8'),'private-local-config');assert.equal(await readFile(join(dir,'data/state.json'),'utf8'),'order-history');
 await assert.rejects(applyStaged({dir,stage,manifest:m,busy:()=>true}),/заказ/);
 await writeFile(join(stage,'bot.mjs'),'tampered');await assert.rejects(applyStaged({dir,stage,manifest:m}),/целостности/);
 await rm(dir,{recursive:true,force:true});
});
