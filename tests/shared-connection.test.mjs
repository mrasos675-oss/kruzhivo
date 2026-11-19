import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createSharedConnection } from '../server/shared-connection.mjs';
import { createHostedHandler } from '../api/index.mjs';
import { adminCookie, isAdmin, validAdminToken, sessionFromCookie } from '../server/cloud-security.mjs';
import { createCloudStore } from '../server/cloud-store.mjs';
import { normalizeConnection } from '../server/providers.mjs';
import { CATALOG } from '../server/catalog.mjs';

function memoryBlob(){const files=new Map();let revision=0;return {files,
 async get(path){const x=files.get(path);return x?{statusCode:200,stream:new Blob([x.bytes]).stream()}:null;},
 async head(path){const x=files.get(path);if(!x)throw Error('Missing');return {etag:x.etag};},
 async put(path,bytes,options){const before=files.get(path);if((options.ifMatch&&before?.etag!==options.ifMatch)||(before&&options.allowOverwrite===false))throw Object.assign(Error('Conflict'),{name:'BlobPreconditionFailedError'});assert.equal(options.access,'private');files.set(path,{bytes:Buffer.from(bytes),etag:String(++revision),options});},
 async del(path){files.delete(path);}
};}
const master=randomBytes(32).toString('base64url'),admin=randomBytes(32).toString('base64url');
const connection=normalizeConnection({provider:'polza',model:'test/model'});

test('Owner capability is signed, expires, and is invalidated by rotation',()=>{
 const cookie=adminCookie(admin,master).split(';')[0];assert.equal(isAdmin(cookie,admin,master),true);
 assert.equal(isAdmin(cookie+'x',admin,master),false);assert.equal(isAdmin(cookie,'b'.repeat(43),master),false);
 assert.equal(isAdmin(cookie,admin,master,Date.now()+31*86400000),false);
 assert.equal(validAdminToken('bad',admin),false);assert.equal(validAdminToken(admin,admin),true);
});

test('Shared configuration persists encrypted without TTL; global leases are atomic and revoked configurations cannot be used',async()=>{
 const storage=memoryBlob(),a=createSharedConnection(master,storage),b=createSharedConnection(master,storage);
 assert.equal((await a.read()).key,'');await a.set('shared-private-sentinel',connection);
 const saved=await b.read();assert.equal(saved.key,'shared-private-sentinel');assert.equal(saved.connection.model,'test/model');
 const file=storage.files.get('system/shared-connection-v1.json');assert.ok(!file.bytes.includes('shared-private-sentinel'));assert.ok(!file.bytes.includes('test/model'));assert.equal(file.options.ttlDays,undefined);
 const attempts=await Promise.allSettled([a.reserve(saved.revision),b.reserve(saved.revision)]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.find(x=>x.status==='rejected').reason.status,429);
 await a.release(attempts.find(x=>x.status==='fulfilled').value);
 await b.set('replacement-sentinel',connection);assert.equal(await a.valid(saved.revision),false);
 await assert.rejects(a.reserve(saved.revision),e=>e.status===409);
 const current=await a.read();for(let i=0;i<7;i++)await a.release(await b.reserve(current.revision));
 await assert.rejects(a.reserve(current.revision),e=>e.status===429);
 await b.set('',{...connection,model:''});assert.equal((await a.read()).key,'');
});

test('Two independent browser sessions use one shared key; only owner can manage it and personal documents remain isolated',async t=>{
 const storage=memoryBlob(),jobs=[];let providerCalls=0;
 const handler=createHostedHandler({authRequired:false,getMaster:()=>master,getAdminToken:()=>admin,storage,schedule:p=>jobs.push(p),fetcher:async(_url,opts)=>{
   providerCalls++;assert.equal(opts.headers.Authorization,'Bearer personal-key-sentinel');
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({findings:[],coverage:CATALOG.factors.map(f=>({factorId:f.id,status:'limited',note:'Нет правовых источников.'})),limitations:[]})}}]});
 }});
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await Promise.all(jobs);await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const alice=await call('bootstrap'),bob=await call('bootstrap');assert.equal(alice.body.config.configured,false);assert.notEqual(alice.cookie,bob.cookie);
 assert.equal((await call('settings',bob.cookie,{key:'hijack',connection})).status,403);
 assert.equal((await call('admin/login',bob.cookie,{token:'bad'})).status,403);
 const login=await call('admin/login',alice.cookie,{token:admin});assert.equal(login.status,200);const owner=alice.cookie+'; '+login.cookie;
 const personal=createCloudStore(sessionFromCookie(alice.cookie,master).id,master,storage);await personal.setCredential('personal-key-sentinel',connection.model,connection);
 let boot=await call('bootstrap',owner);assert.equal(boot.body.config.personalConfigured,true);assert.equal(boot.body.config.canManage,true);
 assert.equal((await call('settings',owner,{key:'personal-key-sentinel',connection:boot.body.config.personalConnection})).status,200);
 boot=await call('bootstrap',bob.cookie);assert.equal(boot.body.config.configured,true);assert.equal(boot.body.config.usingShared,true);assert.equal(boot.body.config.canManage,false);assert.equal(boot.body.config.connection.model,connection.model);
 assert.ok(!JSON.stringify(boot.body).includes('personal-key-sentinel'));assert.ok(!JSON.stringify(boot.body).includes(admin));
 const doc=await call('documents',bob.cookie,{name:'Bob private document',text:'1.1. Тестовый документ.'});assert.equal(doc.status,201);
 boot=await call('bootstrap',bob.cookie);const d=boot.body.documents.find(x=>x.id===doc.body.id);
 const run=await call(`documents/${d.id}/runs`,bob.cookie,{versionId:d.versions[0].id,mode:'api'});assert.equal(run.status,202);await Promise.all(jobs);assert.equal(providerCalls,1);
 boot=await call('bootstrap',bob.cookie);assert.equal(boot.body.documents.find(x=>x.id===d.id).runs[0].status,'completed');
 assert.ok(!(await call('bootstrap',owner)).body.documents.some(x=>x.name==='Bob private document'));
 assert.equal((await call('settings',bob.cookie,{key:'',connection})).status,403);
 assert.equal((await call('settings',owner,{key:'',connection})).status,200);
 boot=await call('bootstrap',bob.cookie);assert.equal(boot.body.config.configured,false);
  assert.equal((await personal.credential()).key,'');
  assert.equal((await createSharedConnection(master,storage).read()).key,'');
  assert.equal((await call(`documents/${d.id}/runs`,bob.cookie,{versionId:d.versions[0].id,mode:'api'})).status,400);
});

test('HTTP audit: a newly added verified project source reaches all three API payloads and expert confirmation works across browser sessions',async t=>{
 const storage=memoryBlob(),jobs=[],captured=[];
 const handler=createHostedHandler({authRequired:false,getMaster:()=>master,getAdminToken:()=>admin,storage,schedule:p=>jobs.push(p),fetcher:async(_url,opts)=>{
  const b=JSON.parse(opts.body),p=JSON.parse(b.messages[1].content);assert.ok(!opts.body.includes('source-audit-key'));
  captured.push({sources:structuredClone(p.sources),methodology:structuredClone(p.methodologicalContext)});
  let result;
  if(!p.sources.length)result={findings:[],coverage:CATALOG.factors.map(f=>({factorId:f.id,status:'limited',note:'Нет источников.'})),limitations:[]};
  else if(!p.findings)result={findings:[{factorId:'F10',point:'1.1',quote:'Специалист требует дополнительные документы.',explanation:'Синтетический тест передачи основания.',basis:[{sourceId:p.sources[0].id,locator:'Тестовый пункт',quote:p.sources[0].text}]}],coverage:CATALOG.factors.map(f=>({factorId:f.id,status:f.id==='F10'?'finding':'none',note:'Тестовый результат.'})),limitations:[]};
  else if(!p.findings[0].review)result={reviews:p.findings.map(f=>({findingId:f.id,verdict:'supported',explanation:'Синтетическая перепроверка.',counterarguments:[],evidence:[],sourceEvidence:[],checks:{context:'Проверен контекст.',exception:'Проверены исключения.',applicability:'Синтетический источник теста.',freshness:'Не является законом.'},doubts:[]}))};
  else result={edits:p.findings.map(f=>({findingId:f.id,explanation:'Тестовый проект.',proposal:'Тестовая редакция.',meaning:'preserved',meaningExplanation:'Синтетический ответ.',meaningChecks:Object.fromEntries(['rights','obligations','deadlines','conditions','exceptions','competence'].map(k=>[k,{status:'preserved',explanation:'Синтетическая проверка.'}]))}))};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
 }});
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await Promise.all(jobs);await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const alice=await call('bootstrap'),bob=await call('bootstrap'),carol=await call('bootstrap');
 const login=await call('admin/login',alice.cookie,{token:admin}),owner=alice.cookie+'; '+login.cookie;
 assert.equal((await call('settings',owner,{key:'source-audit-key',connection})).status,200);
 const source={scope:'project',title:'СИНТЕТИЧЕСКИЙ ИСТОЧНИК — не закон',url:'https://example.org/test',revision:'Тест',applicability:'Только программный тест',text:'SYNTHETIC SOURCE MARKER: перечень закрыт.',verified:true};
 assert.equal((await call('sources',bob.cookie,source)).status,403);
 const added=await call('sources',owner,source);assert.equal(added.status,201);
 await call('sources',owner,{...source,title:'Не проверен',text:'UNVERIFIED MUST NOT BE SENT',verified:false});
 const doc=await call('documents',bob.cookie,{name:'Синтетический документ аудита',text:'1.1. Специалист требует дополнительные документы.'});
 let boot=(await call('bootstrap',bob.cookie)).body;const d=boot.documents.find(x=>x.id===doc.body.id);
 assert.equal(boot.sources.filter(s=>s.scope==='project').length,2);
 const started=await call(`documents/${d.id}/runs`,bob.cookie,{versionId:d.versions[0].id,mode:'api'});assert.equal(started.status,202);await Promise.all(jobs);
 assert.equal(captured.length,3);for(const p of captured){assert.equal(p.sources.length,1);assert.equal(p.sources[0].id,added.body.id);assert.equal(p.sources[0].text,source.text);assert.ok(p.methodology.rules.length>0);}
 boot=(await call('bootstrap',bob.cookie)).body;const r=boot.documents.find(x=>x.id===d.id).runs[0];assert.equal(r.status,'completed');assert.equal(r.aiInputs.length,3);assert.ok(r.aiInputs.every(i=>i.sourceIds[0]===added.body.id));
 const invited=await call('expert-cases',bob.cookie,{runId:r.id});assert.equal(invited.status,201);const id=invited.body.id;
 assert.equal((await call('expert-cases/'+id,owner)).status,403);
 assert.equal((await call('expert-cases/'+id+'/accept',carol.cookie,{token:invited.body.token,profile:{name:'Тестовый эксперт',registryNumber:'Не проверено'}})).status,200);
 assert.equal((await call('expert-cases/'+id+'/sign',bob.cookie,{revision:0})).status,403);
 assert.equal((await call('expert-cases/'+id+'/draft',carol.cookie,{text:'Тестовое заключение эксперта.',revision:0},'PUT')).status,200);
 assert.equal((await call('expert-cases/'+id+'/sign',carol.cookie,{revision:1})).status,200);
 assert.equal((await call('expert-cases/'+id,bob.cookie)).body.conclusions[0].status,'confirmed');
 assert.equal((await call('sources/'+added.body.id,owner,{active:false},'PATCH')).status,200);
 assert.equal((await call('sources/'+added.body.id,bob.cookie,{active:true},'PATCH')).status,403);
 const repeat=await call(`documents/${d.id}/runs`,bob.cookie,{versionId:d.versions[0].id,mode:'api'});assert.equal(repeat.status,202);await Promise.all(jobs);
 assert.equal(captured.at(-1).sources.length,0);
 boot=(await call('bootstrap',bob.cookie)).body;const old=boot.documents.find(x=>x.id===d.id).runs.find(x=>x.id===r.id);assert.equal(old.sources[0].text,source.text);
 t.diagnostic('Captured actual mocked HTTP payloads: Analyst 1 verified source; Reviewer 1; Editor 1. Unverified source excluded; subsequent disabled-source run receives 0. No paid calls.');
});
