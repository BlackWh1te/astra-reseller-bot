import { createPrivateKey,createPublicKey,sign } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY } from './app/support.mjs';
import { RELEASE_FILES,sha256 } from './app/updater.mjs';
import { RELEASE_PUBLIC_KEY } from './app/update-key.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const key=process.env.RELEASE_SIGNING_KEY??await readFile(process.env.RELEASE_SIGNING_KEY_FILE,'utf8');
const privateKey=createPrivateKey(key);
if(createPublicKey(privateKey).export({type:'spki',format:'pem'}).trim()!==RELEASE_PUBLIC_KEY.trim())throw new Error('Signing key does not match the pinned publisher key');
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const files=[];
for(const name of RELEASE_FILES){const bytes=await readFile(join(root,'release/funpay-bot-reseller',name));files.push({name,size:bytes.length,sha256:sha256(bytes)});}
const issuedAt=Date.now();
const manifest={repository:REPOSITORY,version,issuedAt,expiresAt:issuedAt+365*86400000,files};
const payload=Buffer.from(JSON.stringify(manifest));
await writeFile(join(root,'release/manifest.json'),JSON.stringify({payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')}));
console.log('Signed release',version,'with pinned publisher key.');
