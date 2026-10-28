import { timingSafeEqual } from 'node:crypto';
export const SERVICE_ORIGIN = 'https://api.gserver.online';
export function safeEqual(a,b) { const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y); }
export function isLocalTest(url) { return process.env.RESELLER_BOT_TEST==='1'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname); }
export function validateConfig(config) {
  const base=new URL(config.apiBase);
  if(base.origin!==SERVICE_ORIGIN&&!isLocalTest(base)) throw new Error('Адрес API должен быть https://api.gserver.online. Ключи не отправляются на сторонние серверы.');
  if(base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname))throw new Error('Некорректный адрес API.');
  if(config.funpayBaseUrl&&!isLocalTest(new URL(config.funpayBaseUrl)))throw new Error('Подмена адреса FunPay разрешена только в локальных тестах.');
  if(config.aiBaseUrl&&!isLocalTest(new URL(config.aiBaseUrl)))throw new Error('Подмена адреса ИИ разрешена только в локальных тестах.');
  if(!Number.isInteger(config.dashboardPort)||config.dashboardPort<1024||config.dashboardPort>65535)throw new Error('Некорректный порт панели.');
  if(!isLocalTest(base)&&!/^sk-dev-[A-Za-z0-9_-]{20,150}$/.test(config.devKey))throw new Error('Нужен ключ API разработчика из кабинета реселлера.');
  return config;
}
export function authorizeLocal(request,hosts) {
  if(!hosts.has(request.headers.host??''))return false;
  const origin=request.headers.origin;
  if(origin&& ![...hosts].some(h=>origin===`http://${h}`))return false;
  const site=request.headers['sec-fetch-site'];
  return !site||site==='same-origin'||site==='none';
}
export function securityHeaders(response,nonce) {
 response.setHeader('Cache-Control','no-store');
 response.setHeader('X-Content-Type-Options','nosniff');
 response.setHeader('Referrer-Policy','no-referrer');
 response.setHeader('X-Frame-Options','DENY');
 response.setHeader('Cross-Origin-Resource-Policy','same-origin');
 response.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}
export async function boundedBody(request,limit=16_384) {
 const declared=Number(request.headers['content-length']);
 if(Number.isFinite(declared)&&declared>limit)throw new Error('Request too large');
 const chunks=[];let size=0;
 for await(const chunk of request){size+=chunk.length;if(size>limit)throw new Error('Request too large');chunks.push(chunk);}
 return Buffer.concat(chunks).toString('utf8');
}
export const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
