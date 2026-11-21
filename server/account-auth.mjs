import * as blob from '@vercel/blob';
import { randomBytes, createHash, createHmac, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './files.mjs';

const scrypt=promisify(derive);
const COOKIE='__Host-kruzhivo-account';
const seconds=7*86400;
const gitToken = /^[\w-]{43}$/;
const redisToken = /^r1\.[\w-]{43}$/;
const readOptions={access:'private',useCache:false};
const writeOptions={access:'private',addRandomSuffix:false,contentType:'application/json',cacheControlMaxAge:0};
const digest=value=>createHash('sha256').update(value).digest('hex');
export const publicAccount=a=>a?{id:a.id,username:a.username,role:a.role,displayName:a.displayName}:null;
export async function passwordHash(password,salt){return Buffer.from(await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex');}
export function parseAccounts(value){
  let rows;try{rows=typeof value==='string'?JSON.parse(value):value||[];}catch{throw fail('Вход временно недоступен.',503);}
  if(!Array.isArray(rows)||rows.length>100)throw fail('Вход временно недоступен.',503);
  const ids=new Set(),names=new Set();
  for(const a of rows){if(!a||typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||typeof a.username!=='string'||!/^[a-z0-9._-]{1,64}$/.test(a.username)||!['official','expert','admin'].includes(a.role)||typeof a.displayName!=='string'||a.displayName.length>200||!/^[a-f0-9]{32,128}$/.test(a.salt||'')||!/^[a-f0-9]{64}$/.test(a.passwordHash||'')||ids.has(a.id)||names.has(a.username))throw fail('Вход временно недоступен.',503);ids.add(a.id);names.add(a.username);}
  return rows;
}
export function createAccountAuth(master,accounts,storage=blob,{redis=null,demoEnabled=false,demoAccount=(rows,role)=>rows.find(a=>a.role===role)}={}){
 const rows=parseAccounts(accounts),tokenFrom=header=>header?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 const path=token=>'auth/sessions/'+createHmac('sha256',master).update(token).digest('hex')+'.json';
 const attemptPath=ip=>'auth/attempts/'+createHmac('sha256',master).update(ip).digest('hex')+'.json';
 const stamp=a=>digest(JSON.stringify(a));
 async function read(p){const r=await storage.get(p,readOptions);if(!r||r.statusCode===404)return null;if(r.statusCode!==200)throw fail('Сервис входа временно недоступен.',503);return JSON.parse(await new Response(r.stream).text());}
 async function throttle(ip,sessionChanges=[]){
  const p=attemptPath(ip);
  if(redis)return redis.recordAttempt(p);
  for(let i=0;i<5;i++){
   let meta,fresh;
   if(storage.kind==='github'){
    const entry=await storage.get(p,{fresh:i>0});
    if(entry){meta=entry.blob;fresh=await new Response(entry.stream).json();}
   }else{
    const existing=await read(p);
    meta=existing?await storage.head(p):null;
    fresh=meta?await read(p):null;
   }
   const now=Date.now(),times=(fresh?.times||[]).filter(t=>now-t<900000);
   if(times.length>=10)throw fail('Слишком много попыток входа. Повторите через 15 минут.',429);
   times.push(now);
   const change={path:p,bytes:JSON.stringify({times}),options:{...writeOptions,ttlDays:1,allowOverwrite:!!meta,...(meta?{ifMatch:meta.etag}:{})}};
   try{
    if(sessionChanges.length)await storage.putMany([change,...sessionChanges]);
    else await storage.put(change.path,change.bytes,change.options);
    return;
   }catch(e){
    if(!['BlobPreconditionFailedError','BlobAlreadyExistsError'].includes(e.name))throw e;
   }
  }
  throw fail('Повторите вход через несколько секунд.',429);
 }
 const registryPath='auth/registered-accounts-v1.json';
 async function allAccounts(){const saved=await read(registryPath);return [...rows,...parseAccounts(saved?.accounts||[]).filter(a=>!rows.some(e=>e.id===a.id||e.username===a.username))];}
 function prepareSession(a,header,demo){
  const old=tokenFrom(header);
  const token=(redis?'r1.':'')+randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+seconds*1000;
  const session={path:path(token),bytes:JSON.stringify({accountId:a.id,stamp:stamp(a),expiresAt,demo}),ttl:seconds};
  if(redisToken.test(old||''))session.previousPath=path(old);
  const changes=[{path:session.path,bytes:session.bytes,options:{...writeOptions,ttlDays:7,allowOverwrite:false}}];
  if(!redis&&gitToken.test(old||''))changes.unshift({path:path(old),remove:true});
  const signed={user:publicAccount(a),cookie:`${COOKIE}=${token}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Strict`};
  return {old,session,changes,signed};
 }
 async function revokeLegacy(old){
  if(gitToken.test(old||''))await storage.del(path(old));
 }
 async function issueSession(a,header,demo=false){
  const {old,session,changes,signed}=prepareSession(a,header,demo);
  if(redis){
   await revokeLegacy(old);
   await redis.issue(session);
  }else if(changes.length>1&&storage.putMany)await storage.putMany(changes);
  else for(const change of changes){
   if(change.remove)await storage.del(change.path);
   else await storage.put(change.path,change.bytes,change.options);
  }
  return signed;
 }
 return {
  async listAccounts(){return (await allAccounts()).map(publicAccount);},
  async register(){throw fail('Регистрация недоступна.',403);},
  accounts:rows.map(publicAccount),
  async current(header){
   const token=tokenFrom(header)||'';
   const session=redisToken.test(token)?await redis?.read(path(token)):gitToken.test(token)?await read(path(token)):null;
   if(!session||session.expiresAt<=Date.now()||session.demo&&!demoEnabled)return null;
   const account=rows.find(a=>a.id===session.accountId)||(await allAccounts()).find(a=>a.id===session.accountId);
   return account&&session.stamp===stamp(account)?publicAccount(account):null;
  },
  async login(username,password,ip,header){
   const available=await allAccounts();if(!available.length)throw fail('Учётные записи ещё не настроены.',503);
   const name=typeof username==='string'?username.trim().toLowerCase():'';
   if(!/^[a-z0-9._-]{1,64}$/.test(name)||typeof password!=='string'||password.length>200)throw fail('Неверный логин или пароль.',401);
   await throttle(ip);const a=available.find(a=>a.username===name);
   const actual=Buffer.from(await passwordHash(password,a?.salt||'0'.repeat(32)),'hex'),expected=Buffer.from(a?.passwordHash||'0'.repeat(64),'hex');
   if(!timingSafeEqual(actual,expected)||!a)throw fail('Неверный логин или пароль.',401);
   return issueSession(a,header);
  },
  async loginDemo(role,ip,header){
   if(!demoEnabled)throw fail('Демонстрационный вход отключён.',403);
   if(!['official','expert','admin'].includes(role))throw fail('Выберите роль для входа.',400);
   const a=demoAccount(rows,role);if(!a)throw fail('Демо-аккаунт этой роли не настроен.',503);
   if(redis){
    const {old,session,signed}=prepareSession(a,header,true);
    await redis.recordAttempt(attemptPath('demo:'+ip),session);
    await revokeLegacy(old);
    return signed;
   }
   if(storage.putMany){
    const {changes,signed}=prepareSession(a,header,true);
    await throttle('demo:'+ip,changes);
    return signed;
   }
   await throttle('demo:'+ip);
   return issueSession(a,header,true);
  },
  async logout(header){
   const token=tokenFrom(header)||'';
   if(redisToken.test(token))await redis?.revoke(path(token));
   else await revokeLegacy(token);
   return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
  },
 };
}

export function roleAllowed(user,method,path){
 if(path==='/api/storage/recover')return user.role==='admin'&&method==='POST';
 if(path==='/api/settings/probe')return user.role==='admin'&&method==='POST';
 if(user.role==='admin')return method==='GET'&&['/api/bootstrap','/api/methodology'].includes(path)||method==='POST'&&['/api/settings','/api/storage/recover'].includes(path);
 if(path==='/api/profile'&&method==='PUT')return true;
 if(['/api/settings','/api/admin/login','/api/settings/personal'].includes(path))return false;
 if(path==='/api/sources'||/^\/api\/sources\/[^/]+(?:\/download)?$/.test(path)){
  if(method==='GET'&&path.endsWith('/download'))return ['official','expert'].includes(user.role);
  return user.role==='expert'&&(method==='POST'&&path==='/api/sources'||method==='PATCH'&&/^\/api\/sources\/[^/]+$/.test(path));
 }
 if(user.role==='expert'&&method==='GET'&&/^\/api\/sample-documents\/[a-z0-9-]+\.docx$/.test(path))return true;
 if(user.role==='expert'&&((method==='POST'&&path==='/api/examples')||(method==='PATCH'&&/^\/api\/examples\/[^/]+$/.test(path))))return true;
 if(user.role==='official')return !/\/expert-cases\/[^/]+\/(accept|start|draft|sign|new-draft)$/.test(path);
 if(method==='GET')return ['/api/bootstrap','/api/methodology','/api/expert-cases','/api/expert-cases/history'].includes(path)||/^\/api\/expert-cases\/[a-f0-9-]{36}(?:\/conclusions\/[0-9]+\.docx)?$/.test(path);
 return ['POST','PUT'].includes(method)&&/^\/api\/expert-cases\/[a-f0-9-]{36}\/(accept|start|messages|draft|sign|new-draft)$/.test(path);
}
