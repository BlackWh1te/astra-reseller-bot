import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
const dir=await mkdtemp(join(tmpdir(),'astra-panel-'));process.env.RESELLER_BOT_DATA_DIR=dir;process.env.RESELLER_BOT_TEST='1';
const engine=await import('../app/engine.mjs');
const {createPanelExtension}=await import('../app/panel.mjs');
engine.setDashboardExtension(createPanelExtension);
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const config={apiBase:'http://127.0.0.1:1',devKey:'sk-dev-'+'a'.repeat(40),goldenKey:'mock-no-external-network',shopName:'Audit <img src=x onerror=alert(1)>',dashboardPort:port,ai:{key:null,keyId:null,model:'gemini-3.8-flash'},dryRun:true,topUpKeys:true,pollMs:5000};
let created=0;
const api={
 async me(){return {reseller:{id:2,username:'audit-shop'},pool:{balance:1938400000,credited:2000000000},usd_pool:{balance:499.7},steam_pool:{balance:50},smm_pool:{balance:20},keys:{active:0}};},
 async models(){return {groups:[{group:'full',name_ru:'Все модели'}]};},async rates(){return {usd_per_million:{gemini:.4}};},
 async request(method,path){if(path==='/topup-options')return {pricing:{apiRubPerMillion:2.5},reseller:{id:2,username:'audit-shop'}};if(path.startsWith('/keys?'))return {data:[],next_cursor:null};if(path.startsWith('/usage'))return {data:[],models:[],next_cursor:null};throw new Error('unexpected request: '+path);},
 async createKey(body){created++;assert.equal(body.tokens,100e6);return {secret:'sk-ag-'+'b'.repeat(48)};},
};
const store=new engine.Store(join(dir,'state.json'));const bot=new engine.ResellerBot(config,store,api);const server=engine.startDashboard(config,store,bot,api);await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));const base=`http://127.0.0.1:${port}`;
test('every panel page works; token and dollar budgets are separate; host/origin and CSRF controls apply',async()=>{
 for(const view of ['overview','balance','keys','usage','setup','updates','ai','goods','orders','activity']){
  const response=await fetch(`${base}/?view=${view}`);assert.equal(response.status,200,view);const html=await response.text();assert(!html.includes('<img src=x onerror=alert(1)>'));
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(html,/<script nonce="[^"]+">/);
  if(view==='overview'){assert.match(html,/1\.94B/);assert.match(html,/Доллары API/);}
  if(view==='balance'){assert.match(html,/499,7/);assert.match(html,/Миллион|млн|млрд/);assert.match(html,/neva_glamur67/);}
 }
 assert.equal((await fetch(base,{headers:{origin:'https://attacker.test'}})).status,403);
 const hostStatus=await new Promise((resolve,reject)=>{httpGet(base,{headers:{host:'attacker.test'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);
 assert.equal((await fetch(base+'/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=key_create&token=wrong'})).status,403);assert.equal(created,0);
 const page=await(await fetch(base+'/?view=keys')).text();const token=page.match(/name="token" value="([^"]+)"/)[1];const op=page.match(/name="op_id" value="([^"]+)"/)[1];
 const response=await fetch(base+'/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams({token,action:'key_create',op_id:op,name:'Audit buyer',unit:'millions',amount:'100',group:'full',view:'keys'})});assert.equal(response.status,200);assert.match(await response.text(),/sk-ag-/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(created,1);
 const tg=await fetch(base+'/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,action:'support_topup',wallet:'steam',amount:'50'}),redirect:'manual'});assert.equal(tg.status,303);assert.equal(new URL(tg.headers.get('location')).pathname,'/neva_glamur67');
});
test.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.saveNow();await rm(dir,{recursive:true,force:true});});
