import { randomBytes, createHmac, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { fail } from './files.mjs';

export const COOKIE = '__Host-kruzhivo';
const SESSION_SECONDS = 30 * 86400;
function secret(value) { if (typeof value !== 'string' || value.length < 43) throw new Error('Missing session secret'); return value; }
const mac = (value, key) => createHmac('sha256', secret(key)).update(value).digest('base64url');
export function sessionFromCookie(header = '', key, time = Date.now()) {
  const raw = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [id, expiry, signature, extra] = raw.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(id || '') || !/^\d{13}$/.test(expiry || '') || !/^[\w-]{43}$/.test(signature || '')) return null;
  const expected = mac(`${id}.${expiry}`, key);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) || Number(expiry) <= time || Number(expiry) > time + SESSION_SECONDS * 1000 + 60000) return null;
  return { id, expiry: Number(expiry) };
}
export function newSession(key, time = Date.now()) {
  const id = randomBytes(32).toString('hex'), expiry = time + SESSION_SECONDS * 1000;
  const value = `${id}.${expiry}.${mac(`${id}.${expiry}`, key)}`;
  return { id, expiry, cookie: `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict` };
}
const encryptionKey = key => createHash('sha256').update('kruzhivo-credential-v1\0' + secret(key)).digest();
export function sealKey(key, workspace, master) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(master), iv);
  cipher.setAAD(Buffer.from(workspace));
  const bytes = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function openKey(value, workspace, master) {
  try {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(master), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(workspace)); decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw fail('Подключите API-ключ заново.', 401); }
}
export function checkOrigin(req) {
  const host = req.headers.host || '';
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw fail('Некорректный адрес.', 400);
  const origin = `https://${host}`;
  if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== origin || req.headers['x-kruzhivo-client'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) throw fail('Обновите страницу и повторите действие.', 403);
  return origin;
}


export const ADMIN_COOKIE = '__Host-kruzhivo-admin';
export function validAdminToken(value, expected) {
  if(typeof value!=='string'||typeof expected!=='string'||expected.length<43||value.length>200)return false;
  return timingSafeEqual(createHash('sha256').update(value).digest(),createHash('sha256').update(expected).digest());
}
export function adminCookie(token,master,time=Date.now()) {
  const expiry=time+SESSION_SECONDS*1000;
  const signature=mac('shared-admin.'+expiry+'.'+createHash('sha256').update(token).digest('hex'),master);
  return `${ADMIN_COOKIE}=${expiry}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict`;
}
export function isAdmin(header='',token,master,time=Date.now()) {
  if(typeof token!=='string'||token.length<43)return false;
  const raw=header.split(';').map(x=>x.trim()).find(x=>x.startsWith(ADMIN_COOKIE+'='))?.slice(ADMIN_COOKIE.length+1);
  if(!raw)return false;
  const [expiry,signature,extra]=raw.split('.');
  if(extra||!/^\d{13}$/.test(expiry||'')||!/^[\w-]{43}$/.test(signature||'')||Number(expiry)<=time||Number(expiry)>time+SESSION_SECONDS*1000+60000)return false;
  const expected=mac('shared-admin.'+expiry+'.'+createHash('sha256').update(token).digest('hex'),master);
  return timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
