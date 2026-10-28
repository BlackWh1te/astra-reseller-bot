import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=await mkdtemp(join(tmpdir(),'astra-engine-'));process.env.RESELLER_BOT_DATA_DIR=dir;process.env.RESELLER_BOT_TEST='1';
const engine=await import('../app/engine.mjs');
test('all current token and dollar title forms keep correct billing and promotion',()=>{
 for(const size of [1,2,5,10,100,200,300])for(const title of [`🔥 API КЛЮЧ ${size}M ТОКЕНОВ | GPT/Opus 5.5/Gemini/Kimi/GLM | Автовыдача | +10% [ACLAUDET${size*100}]`,`𝗔𝗣𝗜 КЛЮЧ ${size}M ТОКЕНОВ | Все модели | +10%`]){
  const detected=engine.detectLot(title);assert(detected?.plan,title);const grant=engine.grantFor(detected.plan,2);assert.equal(grant.group,'full');assert.equal(grant.tokens,size*2e6);assert.equal(grant.reviewBonus,size*2e5);assert.equal(grant.billing??'tokens','tokens');
 }
 const usd=engine.detectLot('API КЛЮЧ GEMINI GPT CLAUDE БАЛАНС $100 +10%');assert.equal(engine.grantFor(usd.plan,1).billing,'usd');
});
test('a crash during bonus request does not persist a false awarded marker; concurrent events award once',async()=>{
 const store=new engine.Store(join(dir,'test-state.json'));const order={id:'MOCK-AUDIT',keyId:99,reviewBonusAt:null,plan:JSON.stringify({group:'full',millions:100,bonusPercent:10})};store.state.orders[order.id]=order;
 let finish;const held=new Promise(resolve=>{finish=resolve;});let calls=0;
 const ctx={store,noKeyForBonus:new Set(),api:{bonus:async()=>{calls++;await held;}}};
 const first=engine.ResellerBot.prototype.grantReviewBonus.call(ctx,order,10e6);
 await new Promise(resolve=>setTimeout(resolve,5));store.saveNow();assert.equal(JSON.parse(await readFile(join(dir,'test-state.json'),'utf8')).orders[order.id].reviewBonusAt,null);
 assert.equal(await engine.ResellerBot.prototype.grantReviewBonus.call(ctx,order,10e6),false);assert.equal(calls,1);finish();assert.equal(await first,true);assert.equal(order.reviewBonusTokens,10e6);
 assert.equal(await engine.ResellerBot.prototype.grantReviewBonus.call(ctx,order,10e6),false);
 store.saveNow();
});
test.after(async()=>{await rm(dir,{recursive:true,force:true});});
