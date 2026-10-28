import { createHash, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY } from './support.mjs';
import { RELEASE_PUBLIC_KEY } from './update-key.mjs';
export const RELEASE_FILES=new Set(['bot.mjs','start.sh','start.ps1','start.cmd','start-linux.sh','README.md','knowledge.md','lot-templates.json']);
const CUSTOM_FILES=new Set(['knowledge.md','lot-templates.json']);
const MAX_FILE=8*1024*1024;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function versionParts(value){if(!/^\d+\.\d+\.\d+$/.test(value))throw new Error('Invalid release version');return value.split('.').map(Number);}
export function newer(a,b){const aa=versionParts(a),bb=versionParts(b);for(let i=0;i<3;i++){if(aa[i]!==bb[i])return aa[i]>bb[i];}return false;}
export function verifyManifest(envelope,key=RELEASE_PUBLIC_KEY,now=Date.now()) {
 if(!envelope||typeof envelope.payload!=='string'||envelope.payload.length>32768||typeof envelope.signature!=='string')throw new Error('Invalid release envelope');
 const body=Buffer.from(envelope.payload,'base64');
 if(!verify(null,body,key,Buffer.from(envelope.signature,'base64')))throw new Error('Подпись обновления недействительна. Установка отменена.');
 const manifest=JSON.parse(body.toString('utf8'));versionParts(manifest.version);
 if(manifest.repository!==REPOSITORY||!Number.isFinite(manifest.issuedAt)||!Number.isFinite(manifest.expiresAt)||manifest.issuedAt>now+300000||manifest.expiresAt<=now||manifest.expiresAt-manifest.issuedAt>366*86400000)throw new Error('Релиз просрочен или предназначен другому приложению.');
 if(!Array.isArray(manifest.files)||manifest.files.length!==RELEASE_FILES.size)throw new Error('Неполный состав обновления.');
 const seen=new Set();
 for(const file of manifest.files){
  if(!RELEASE_FILES.has(file.name)||seen.has(file.name)||!Number.isInteger(file.size)||file.size<1||file.size>MAX_FILE||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Некорректный файл обновления.');
  seen.add(file.name);
 }
 return manifest;
}
function releaseUrl(url){
 const u=new URL(url);
 if(u.protocol!=='https:'||u.username||u.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw new Error('Недоверенный адрес обновления.');
 return u;
}
export async function download(url,max,fetcher=fetch){
 let target=releaseUrl(url);
 for(let redirects=0;redirects<=5;redirects++){
  const response=await fetcher(target,{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{'user-agent':'astra-reseller-updater','accept':'application/octet-stream'}});
  if([301,302,303,307,308].includes(response.status)){target=releaseUrl(new URL(response.headers.get('location'),target));continue;}
  if(!response.ok||!response.body)throw new Error(`Сервер обновлений ответил HTTP ${response.status}.`);
  if(Number(response.headers.get('content-length'))>max)throw new Error('Файл обновления слишком большой.');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('Файл обновления слишком большой.');chunks.push(chunk);}
  return Buffer.concat(chunks);
 }
 throw new Error('Слишком много перенаправлений.');
}
export async function applyStaged({dir,manifest,stage,busy=()=>false,move=rename}){
 // Recheck staged bytes before touching any installed file.
 for(const file of manifest.files){const bytes=await readFile(join(stage,file.name));if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw new Error('Проверка целостности обновления не пройдена.');}
 if(busy())throw new Error('Сейчас выполняется заказ. Попробуйте установить обновление после его завершения.');
 const backup=join(dir,'backups',`update-${manifest.version}-${Date.now()}`);await mkdir(backup,{recursive:true,mode:0o700});
 const changed=[];
 try{
  for(const file of manifest.files){
   const target=join(dir,file.name);let existing=null;try{existing=await readFile(target);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(CUSTOM_FILES.has(file.name)&&existing){await writeFile(target+'.new',await readFile(join(stage,file.name)),{mode:0o600});continue;}
   const bytes=await readFile(join(stage,file.name));
   if(existing)await writeFile(join(backup,file.name),existing,{mode:0o600});
   await writeFile(target+'.update',bytes,{mode:file.name.endsWith('.sh')?0o700:0o600});
   await move(target+'.update',target);changed.push({name:file.name,existed:!!existing});
  }
  await writeFile(join(backup,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 }catch(error){
  for(const file of changed.reverse()){const target=join(dir,file.name);if(file.existed){await writeFile(target+'.rollback',await readFile(join(backup,file.name)),{mode:0o600});await rename(target+'.rollback',target);}else await rm(target,{force:true});}
  throw error;
 }
 return backup;
}
export class Updater {
 constructor({dir,version,busy,restart}){Object.assign(this,{dir,version,busy,restart});this.state={status:'idle',message:'Проверка вручную. Настройки и история сохраняются.'};this.running=null;}
 async check(){
  if(this.running)return this.state;
  this.running=(async()=>{
   this.state={status:'checking',message:'Проверяю подписанный релиз…'};
   const bytes=await download(`https://github.com/${REPOSITORY}/releases/latest/download/manifest.json`,65536);
   const envelope=JSON.parse(bytes);const manifest=verifyManifest(envelope);
   if(!newer(manifest.version,this.version)){this.state={status:'current',message:'Установлена актуальная версия.'};return;}
   const stage=join(this.dir,'data',`update-stage-${manifest.version}`);await mkdir(stage,{recursive:true,mode:0o700});
   for(const file of manifest.files){const data=await download(`https://github.com/${REPOSITORY}/releases/download/v${manifest.version}/${file.name}`,file.size);if(data.length!==file.size||sha256(data)!==file.sha256)throw new Error('Контрольная сумма файла не совпала.');await writeFile(join(stage,file.name),data,{mode:0o600});}
   this.ready={manifest,stage,envelope};this.state={status:'ready',version:manifest.version,message:`Версия ${manifest.version} проверена и готова к установке.`};
  })().catch(error=>{this.ready=null;this.state={status:'error',message:error.message};}).finally(()=>{this.running=null;});
  return this.state;
 }
 async install(){
  if(!this.ready||this.state.status!=='ready')throw new Error('Сначала проверьте обновления.');
  if(this.busy())throw new Error('Выполняется заказ — дождитесь его завершения.');
  const {manifest,stage}=this.ready;
  verifyManifest(this.ready.envelope);
  await applyStaged({dir:this.dir,manifest,stage,busy:this.busy});
  this.state={status:'installed',message:'Обновление установлено. Перезапускаю бот; панель вернётся через несколько секунд.'};
  setTimeout(()=>this.restart(),1200).unref();
  return this.state.message;
 }
}
