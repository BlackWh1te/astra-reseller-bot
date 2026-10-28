import { build } from 'esbuild';
import { copyFile,mkdir,readFile,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname,join } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const out=join(root,'release','funpay-bot-reseller');await mkdir(out,{recursive:true});
await build({entryPoints:[join(root,'app/main.mjs')],outfile:join(out,'bot.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},legalComments:'eof',sourcemap:false});
for(const file of ['start.sh','start.ps1','start.cmd','start-linux.sh','knowledge.md','lot-templates.json','README.md'])await copyFile(join(root,file),join(out,file));
for(const name of ['bot.mjs','README.md','knowledge.md','lot-templates.json']){
 const source=await readFile(join(out,name),'utf8');
 if(/(?:kosell|vingboost|tokify)/i.test(source))throw new Error(`${name}: internal supplier name in client package`);
 if(/sk-dev-[A-Za-z0-9]{30,}|sk-ag-[A-Za-z0-9]{35,}|-----BEGIN PRIVATE KEY-----/.test(source))throw new Error(`${name}: possible embedded secret`);
}
if(process.platform==='win32')execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe'),['-a','-cf','funpay-bot-reseller.zip','funpay-bot-reseller'],{cwd:join(root,'release')});
else execFileSync('zip',['-qr','funpay-bot-reseller.zip','funpay-bot-reseller'],{cwd:join(root,'release')});
console.log('Built self-contained bot and Windows/macOS/Linux release package.');
