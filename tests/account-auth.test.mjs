import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createAccountAuth, passwordHash } from '../server/account-auth.mjs';
import { createHostedHandler } from '../api/index.mjs';
import { newSession, adminCookie } from '../server/cloud-security.mjs';
import { createSharedConnection } from '../server/shared-connection.mjs';
import { CATALOG } from '../server/catalog.mjs';
import { zipFiles } from '../server/files.mjs';
import { loginPage } from '../public/login.js';

function memoryBlob(){const files=new Map();let revision=0;return{files,
 async get(p){const x=files.get(p);return x?{statusCode:200,stream:new Blob([x.bytes]).stream()}:null;},
 async head(p){const x=files.get(p);if(!x)throw Error('Missing');return{etag:x.etag};},
 async put(p,bytes,o){const x=files.get(p);if(o.ifMatch&&x?.etag!==o.ifMatch||x&&o.allowOverwrite===false)throw Object.assign(Error('Conflict'),{name:'BlobPreconditionFailedError'});files.set(p,{bytes:Buffer.from(bytes),etag:String(++revision)});},async del(p){files.delete(p);}
};}
const master=randomBytes(32).toString('base64url'),admin=randomBytes(32).toString('base64url');
const accounts=await Promise.all([['official-id','gos.test','official','Тестовый госслужащий'],['expert-id','expert.test','expert','Тестовый эксперт']].map(async([id,username,role,displayName])=>{const salt=randomBytes(16).toString('hex');return{id,username,role,displayName,salt,passwordHash:await passwordHash('test-only-password',salt)};}));

test('Passwords are verified with salted hashes; opaque sessions are revocable, expiring and bound to account configuration',async()=>{
 const storage=memoryBlob(),auth=createAccountAuth(master,accounts,storage);
 await assert.rejects(auth.login('gos.test','wrong','test-ip'),e=>e.status===401);
 const signed=await auth.login('gos.test','test-only-password','test-ip');const cookie=signed.cookie.split(';')[0];
 assert.equal((await auth.current(cookie)).role,'official');assert.ok(!JSON.stringify(signed.user).includes('passwordHash'));
 for(const flag of ['Secure','HttpOnly','SameSite=Strict'])assert.ok(signed.cookie.includes(flag));
 assert.equal(await auth.current(cookie+'x'),null);
 const rotated=createAccountAuth(master,accounts.map(a=>({...a,passwordHash:'1'.repeat(64)})),storage);assert.equal(await rotated.current(cookie),null);
 assert.ok(![...storage.files.values()].some(v=>v.bytes.includes('test-only-password')));
 await auth.logout(cookie);assert.equal(await auth.current(cookie),null);
});

test('Excessive login attempts are throttled without returning account details',async()=>{
 const auth=createAccountAuth(master,accounts,memoryBlob());for(let i=0;i<10;i++)await assert.rejects(auth.login('gos.test','wrong','rate-test-ip'),e=>e.status===401);
 await assert.rejects(auth.login('gos.test','test-only-password','rate-test-ip'),e=>e.status===429);
});

test('Shared cabinets start clean and a DOCX goes to the expert queue without selecting an expert',async t=>{
 const storage=memoryBlob(), jobs=[];
 const proposal='Подразделение выдаёт документ по запросу.';
 const sharedAccounts=accounts.map(a=>({...a,id:'demo-'+a.role+'-v1'}));
 await storage.put('workspaces/account-demo-official-v1/state.json',JSON.stringify({
   db:{schemaVersion:1,documents:[{id:'old-sample',sample:true}],sources:[],examples:[]},credential:null
 }),{allowOverwrite:false});
 await createSharedConnection(master,storage).set('pilot-isolated-key',{provider:'polza',model:'test/model'});
 const handler=createHostedHandler({
  pilotMode:true,getMaster:()=>master,getAdminToken:()=>admin,getAccounts:()=>JSON.stringify(sharedAccounts),
  getDemoLogin:()=>true,storage,schedule:p=>jobs.push(p),
  fetcher:async(_url,options)=>{
   const payload=JSON.parse(JSON.parse(options.body).messages[1].content);
   assert.match(payload.document,/Пилотный синтетический документ/);
   let content;
   if (!payload.findings) {
    content={findings:[{factorId:'F12',point:'1.2',quote:'Документ предоставляется по запросу.',explanation:'Уточнить формулировку.',basis:[]}],coverage:CATALOG.factors.map(f=>({factorId:f.id,status:f.id==='F12'?'finding':'limited',note:'Нет проверенных источников.'})),limitations:[]};
   } else {
    const [finding]=payload.findings;
    if (!finding.review) {
     content={reviews:[{findingId:finding.id,verdict:'insufficient',explanation:'Нужна применимая норма.',counterarguments:[],evidence:['Пилотный синтетический документ. 1.2. Документ предоставляется по запросу.'],checks:{context:'Сверено',exception:'Нет данных',applicability:'Нет данных',freshness:'Нет данных'},doubts:[]}]};
    } else {
     assert.equal(finding.review.verdict,'insufficient');
     const meaningChecks=Object.fromEntries(['rights','obligations','deadlines','conditions','exceptions','competence'].map(k=>[k,{status:'preserved',explanation:'Без изменений.'}]));
     content={edits:[{findingId:finding.id,proposal,explanation:'Проект уточнения текста.',meaning:'preserved',meaningExplanation:'Условие выдачи сохранено.',meaningChecks}]};
    }
   }
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]});
  }
 });
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 assert.equal((await call('auth/session')).body.pilotMode,true);
 assert.equal((await call('auth/session')).body.user,null);assert.equal((await call('bootstrap')).status,401);
 const legacy=newSession(master).cookie.split(';')[0];assert.equal((await call('bootstrap',legacy+'; '+adminCookie(admin,master).split(';')[0])).status,401);
 assert.equal((await call('auth/login',null,{username:'gos.test',password:'wrong'})).status,401);
 const official=await call('auth/demo-login',null,{role:'official'});assert.equal(official.status,200);assert.equal(official.body.user.role,'official');
 const expert=await call('auth/demo-login',null,{role:'expert'});assert.equal(expert.body.user.role,'expert');
 let boot=await call('bootstrap',official.cookie);assert.equal(boot.body.account.role,'official');assert.equal(boot.body.config.experts.length,0);assert.ok(!JSON.stringify(boot.body).includes('passwordHash'));assert.ok(!JSON.stringify(boot.body).includes('test-only-password'));assert.ok(!JSON.stringify(boot.body).includes(master));
 assert.equal(boot.body.documents.length,0);
 assert.equal((await call('expert-cases',expert.cookie)).body.cases.length,0);
 const bytes=zipFiles({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1.1. Пилотный синтетический документ.</w:t></w:r></w:p><w:p><w:r><w:t>1.2. Документ предоставляется по запросу.</w:t></w:r></w:p></w:body></w:document>'});
 const uploaded=await call('extract',official.cookie,{fileName:'pilot.docx',base64:bytes.toString('base64')});assert.equal(uploaded.status,200);
 const newDoc=await call('documents',official.cookie,{name:'Пилотный синтетический документ',kind:'Регламент',text:uploaded.body.text,uploadId:uploaded.body.uploadId});assert.equal(newDoc.status,201);
 const same=await call('auth/demo-login',null,{role:'official'});assert.ok((await call('bootstrap',same.cookie)).body.documents.some(d=>d.id===newDoc.body.id));
 const expertBoot=await call('bootstrap',expert.cookie);assert.equal(expertBoot.body.documents.length,0);assert.equal(expertBoot.body.account.role,'expert');
 assert.equal((await call('documents',expert.cookie,{name:'Forbidden',text:'Text'})).status,403);
 assert.equal((await call('settings',expert.cookie,{key:'forbidden'})).status,403);
 const document=(await call('bootstrap',official.cookie)).body.documents[0];assert.ok(document.versions[0].original);
 const execution=await call('documents/'+document.id+'/runs',official.cookie,{versionId:document.versions[0].id,mode:'api'});assert.equal(execution.status,202);
 await Promise.all(jobs);
 const run=(await call('bootstrap',official.cookie)).body.documents[0].runs[0];assert.equal(run.status,'completed');
 assert.deepEqual(run.stages,{analyst:'completed',reviewer:'completed',editor:'completed'});
 assert.equal(run.findings[0].editor.proposal,proposal);
 assert.equal(run.findings[0].editor.requiresLegalReview,true);
 assert.equal((await call('expert-cases',expert.cookie)).body.cases.length,0);
 assert.equal(run.expertCaseId,undefined);
 for(let i=0;i<2;i++)assert.equal((await call('expert-cases',official.cookie,{runId:run.id,acknowledge:true})).status,409);
 const finding=run.findings[0];
 assert.equal((await call('runs/'+run.id+'/findings/'+finding.id,official.cookie,{status:'rejected',explanation:'Тестовое отклонение',revision:0},'PUT')).status,200);
 const sent=await call('expert-cases',official.cookie,{runId:run.id});assert.equal(sent.status,201);
 const incoming=(await call('expert-cases',expert.cookie)).body.cases;
 assert.equal(incoming.length,1);
 const id=sent.body.id;
 assert.ok(id);
 assert.equal(incoming[0].id,id);assert.equal(incoming[0].status,'waiting');
 const expertCase=(await call('expert-cases/'+id,expert.cookie)).body;
 assert.equal(expertCase.run.findings[0].editor.proposal,proposal);
 assert.equal(expertCase.run.findings[0].decision.status,'rejected');
 assert.equal(expertCase.document.text,uploaded.body.text);
 const repeated=await call('expert-cases',same.cookie,{runId:run.id});assert.equal(repeated.body.id,id);
 assert.equal((await call('expert-cases/'+id+'/start',official.cookie,{})).status,403);
 assert.equal((await call('expert-cases/'+id+'/draft',expert.cookie,{text:'Преждевременный черновик',revision:0},'PUT')).status,409);
 assert.equal((await call('expert-cases/'+id+'/start',expert.cookie,{})).status,200);
 const otherExpert=await call('auth/demo-login',null,{role:'expert'});
 assert.equal((await call('expert-cases',otherExpert.cookie)).body.cases[0].status,'reviewing');
 const c=await call('expert-cases/'+id,expert.cookie);assert.equal(c.body.document.kind,'Регламент');assert.equal(c.body.expertProfile.accountId,'demo-expert-v1');assert.equal(c.body.expertProfile.authentication,'password-account');
 assert.equal((await call('expert-cases/'+id+'/sign',official.cookie,{revision:0})).status,403);
 assert.equal((await call('expert-cases/'+id+'/draft',expert.cookie,{text:'Заключение тестового эксперта.',revision:0},'PUT')).status,200);
 assert.equal((await call('expert-cases/'+id+'/sign',expert.cookie,{revision:1})).status,200);
 assert.equal((await call('expert-cases/'+id,official.cookie)).body.conclusions[0].confirmation.expert.username,'expert.test');
 assert.equal((await call('auth/logout',official.cookie,{})).status,200);assert.equal((await call('bootstrap',official.cookie)).status,401);assert.equal((await call('bootstrap',same.cookie)).status,200);
 const report=await fetch(base+'/api/expert-cases/'+id+'/conclusions/1.docx',{headers:{cookie:same.cookie}});
 assert.equal(report.status,200);assert.match(report.headers.get('content-type'),/wordprocessingml/);
 const reviewPath='workspaces/expert-review-v1/state.json',reviewState=JSON.parse(storage.files.get(reviewPath).bytes);
 Object.assign(reviewState.db.expertCases[0],{archivedAt:new Date().toISOString(),trainingArchive:true});
 await storage.put(reviewPath,JSON.stringify(reviewState),{allowOverwrite:true});
 for(const participant of [same,expert]){
   assert.equal((await call('expert-cases',participant.cookie)).body.cases.length,0);
   assert.equal((await call('expert-cases/history',participant.cookie)).body.cases[0].id,id);
   assert.equal((await call('expert-cases/'+id,participant.cookie)).body.conclusions[0].status,'confirmed');
 }
 assert.equal((await call('expert-cases/'+id+'/new-draft',expert.cookie,{})).status,409);
 assert.ok(JSON.parse(storage.files.get('workspaces/account-demo-official-v1/state.json').bytes).db.documents[0].sample);
 const html=loginPage('<script>',true);
 for(const role of ['official','expert','admin'])assert.ok(html.includes('data-role="'+role+'"'));
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('id="login-form"'));
});

test('Registration is disabled without writing accounts; existing saved accounts can still log in',async()=>{
 const storage=memoryBlob(),request={username:'new.expert',password:'testing-only-long-password',displayName:'Новый эксперт',role:'expert',consent:true};
 const saved={id:'previous-expert',username:request.username,role:'expert',displayName:request.displayName,salt:'a'.repeat(32),passwordHash:await passwordHash(request.password,'a'.repeat(32))};
 await storage.put('auth/registered-accounts-v1.json',JSON.stringify({accounts:[saved]}),{allowOverwrite:false});
 const before=storage.files.get('auth/registered-accounts-v1.json').bytes;
 const auth=createAccountAuth(master,accounts,storage);
 for(const role of ['official','expert','admin'])await assert.rejects(auth.register({...request,role},'registration-ip'),e=>e.status===403);
 assert.equal(storage.files.get('auth/registered-accounts-v1.json').bytes,before);
 const signed=await auth.login(request.username,request.password,'existing-login');
 assert.equal((await auth.current(signed.cookie)).id,saved.id);
});

test('Both roles can save isolated profiles; stale edits, forged avatars and expert writes are rejected; sample DOCX is usable',async t=>{
 const storage=memoryBlob(),handler=createHostedHandler({getMaster:()=>master,getAdminToken:()=>admin,getAccounts:()=>accounts,storage,schedule:()=>{}});
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const official=await call('auth/login',null,{username:'gos.test',password:'test-only-password'}),expert=await call('auth/login',null,{username:'expert.test',password:'test-only-password'});
 const profile={revision:0,fullName:'Тестовый специалист',organization:'Учебная организация',department:'Отдел',position:'Эксперт',goals:'Тестирование',role:'official'};
 assert.equal((await call('profile',expert.cookie,profile,'PUT')).status,200);
 let boot=await call('bootstrap',expert.cookie);assert.equal(boot.body.profile.fullName,profile.fullName);assert.equal(boot.body.account.role,'expert');assert.equal(boot.body.profile.role,undefined);
 assert.equal((await call('profile',expert.cookie,profile,'PUT')).status,409);
 assert.equal((await call('profile',expert.cookie,{...profile,revision:1,avatar:'data:image/svg+xml;base64,PHN2Zz4='},'PUT')).status,400);
 assert.equal((await call('bootstrap',official.cookie)).body.profile,undefined);
 assert.equal((await call('profile',official.cookie,profile,'PUT')).status,200);
 assert.equal((await call('settings',expert.cookie,{key:'fake-only-key'})).status,403);
 assert.equal((await call('sources',official.cookie,{title:'forbidden'})).status,403);
 const response=await fetch(base+'/api/sample-documents/permit.docx',{headers:{cookie:official.cookie}});
 assert.equal(response.status,200);const {extractDocx}=await import('../server/files.mjs');assert.match(extractDocx(Buffer.from(await response.arrayBuffer())),/УЧЕБНЫЙ ПРИМЕР/);
 assert.equal((await call('auth/session',null)).body.user,null);
 const registered=await call('auth/register',null,{username:'created.via.http',password:'test-http-password-long',displayName:'HTTP account',role:'expert',consent:true});assert.equal(registered.status,403);assert.equal(registered.cookie,undefined);
});

test('Administrator password login alone manages shared API; normal accounts and old owner cookies cannot change it',async t=>{
 const salt=randomBytes(16).toString('hex'),adminAccount={id:'system-admin-test',username:'admin.test',role:'admin',displayName:'Администратор',salt,passwordHash:await passwordHash('admin-only-test-password',salt)};
 const storage=memoryBlob(),handler=createHostedHandler({getMaster:()=>master,getAdminToken:()=>admin,getAccounts:()=>accounts,getAdminAccount:()=>[adminAccount],storage,schedule:()=>{}});
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const owner=await call('auth/login',null,{username:'admin.test',password:'admin-only-test-password'});assert.equal(owner.status,200);assert.equal(owner.body.user.role,'admin');
 let boot=await call('bootstrap',owner.cookie);assert.equal(boot.body.config.canManage,true);assert.equal(boot.body.documents.length,0);assert.ok(!JSON.stringify(boot.body).includes('admin-only-test-password'));
 const connection={provider:'deepseek',protocol:'openai',baseUrl:'https://api.deepseek.com',model:'test-model'};
 assert.equal((await call('settings',owner.cookie,{key:'mock-shared-key-only',connection})).status,200);
 for(const username of ['gos.test','expert.test']){const user=await call('auth/login',null,{username,password:'test-only-password'}),b=await call('bootstrap',user.cookie);assert.equal(b.body.config.configured,true);assert.equal(b.body.config.canManage,false);assert.ok(!JSON.stringify(b.body).includes('mock-shared-key-only'));assert.equal((await call('settings',user.cookie+'; '+adminCookie(admin,master).split(';')[0],{key:'forbidden',connection})).status,403);}
 assert.equal((await call('documents',owner.cookie,{name:'Forbidden',text:'text'})).status,403);assert.equal((await call('expert-cases',owner.cookie)).status,403);assert.equal((await call('profile',owner.cookie,{role:'official'},'PUT')).status,403);
 assert.equal((await call('settings',owner.cookie,{key:'',connection})).status,200);
 const official=await call('auth/login',null,{username:'gos.test',password:'test-only-password'});assert.equal((await call('bootstrap',official.cookie)).body.config.configured,false);
 assert.equal((await call('auth/logout',owner.cookie,{})).status,200);assert.equal((await call('bootstrap',owner.cookie)).status,401);
});

test('Demo buttons establish fixed server roles without passwords only while enabled',async t=>{
 const salt=randomBytes(16).toString('hex'),adminRow={id:'demo-admin-button',username:'button.admin',role:'admin',displayName:'Администратор',salt,passwordHash:await passwordHash('unused-test-password',salt)};
 const storage=memoryBlob();let enabled=true;const handler=createHostedHandler({getMaster:()=>master,getAdminToken:()=>admin,getAccounts:()=>accounts,getAdminAccount:()=>[adminRow],getDemoLogin:()=>enabled,storage,schedule:()=>{}});
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,origin=base.replace('http:','https:');
 const call=async(path,cookie,data)=>{const r=await fetch(base+'/api/'+path,{method:data?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(data?{origin,'x-kruzhivo-client':'1','content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 assert.equal((await call('auth/session')).body.demoLogin,true);let last;
 for(const role of ['official','expert','admin','official']){const result=await call('auth/demo-login',last,{role});assert.equal(result.status,200);assert.equal(result.body.user.role,role);assert.equal((await call('bootstrap',result.cookie)).body.config.canManage,role==='admin');assert.ok(!JSON.stringify(result.body).includes('passwordHash'));if(last)assert.equal((await call('bootstrap',last)).status,401);last=result.cookie;}
 assert.equal((await call('auth/demo-login',null,{role:'superuser'})).status,400);
 enabled=false;assert.equal((await call('auth/demo-login',null,{role:'admin'})).status,403);assert.equal((await call('bootstrap',last)).status,401);
 const html=loginPage('',true);for(const role of ['official','expert','admin'])assert.ok(html.includes('data-role="'+role+'"'));assert.ok(!html.includes('type="password"'));assert.ok(!html.includes('name="username"'));
});

test('Only expert edits the shared legal base; officials read and download and saved runs stay unchanged',async t=>{
 const storage=memoryBlob(),handler=createHostedHandler({getMaster:()=>master,getAdminToken:()=>admin,getAccounts:()=>accounts,getAdminAccount:()=>[],getDemoLogin:()=>false,storage,schedule:()=>{}});
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const official=await call('auth/login',null,{username:'gos.test',password:'test-only-password'}),expert=await call('auth/login',null,{username:'expert.test',password:'test-only-password'});
 const before=(await call('bootstrap',official.cookie)).body.documents;
 const source={title:'Тестовый источник',url:'https://example.org/test-source',revision:'Учебная редакция',applicability:'Только автоматический тест',text:'Точная цитата тестового источника.',verified:true};
 assert.equal((await call('sources',official.cookie,source)).status,403);
 const created=await call('sources',expert.cookie,source);assert.equal(created.status,201);const id=created.body.id;
 let boot=(await call('bootstrap',official.cookie)).body;let found=boot.sources.find(s=>s.id===id);assert.equal(found.scope,'project');assert.equal(found.verified,true);
 assert.equal((await call('sources/'+id,official.cookie,{active:false},'PATCH')).status,403);
 assert.equal((await call('sources/'+id,expert.cookie,{text:'Изменённая цитата тестового источника.'},'PATCH')).status,200);
 found=(await call('bootstrap',official.cookie)).body.sources.find(s=>s.id===id);assert.equal(found.verified,false);assert.equal(found.text,'Изменённая цитата тестового источника.');
 assert.equal((await call('sources/'+id,expert.cookie,{verified:true},'PATCH')).status,200);
 assert.equal((await call('sources/'+id,expert.cookie,{url:'javascript:alert(1)'},'PATCH')).status,400);
 for(const cookie of [official.cookie,expert.cookie]){const response=await fetch(base+'/api/sources/'+id+'/download',{headers:{cookie}});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.match(await response.text(),/Изменённая цитата/);}
 assert.equal((await fetch(base+'/api/sample-documents/permit.docx',{headers:{cookie:expert.cookie}})).status,200);
 assert.deepEqual((await call('bootstrap',official.cookie)).body.documents,before);
});
