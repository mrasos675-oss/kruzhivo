import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createGithubStorage} from '../server/github-store.mjs';
import {createCloudStore} from '../server/cloud-store.mjs';
import {fakeGithub} from './helpers/github.mjs';
import http from 'node:http';
import {createHostedHandler} from '../api/index.mjs';
import {passwordHash} from '../server/account-auth.mjs';

const master=randomBytes(32).toString('base64url');
const make=(api,extra={})=>createGithubStorage({token:'test-token',master,request:api.request,writeIntervalMs:0,cacheMs:0,...extra});
const read=async(s,p)=>{const r=await s.get(p);return r?new Response(r.stream).text():null;};

test('Private GitHub storage encrypts names and contents, persists across instances, and caches immutable bodies',async()=>{
 const api=fakeGithub(),s=make(api);await s.put('private-document-name','private-document-content');
 assert.equal(api.refs.has('main'),false);assert(api.refs.has('runtime-data'));
 const configSha=api.trees.get(api.commits.get(api.refs.get('runtime-data')).tree).get('vercel.json');assert.equal(JSON.parse(api.blobs.get(configSha)).git.deploymentEnabled,false);
 for(const b of api.blobs.values()){assert(!b.includes('private-document-content'));assert(!b.includes('private-document-name'));assert(!b.includes('test-token'));}
 const cold=make(api);assert.equal(await read(cold,'private-document-name'),'private-document-content');const before=api.calls.filter(c=>c.path.startsWith('/git/blobs/')).length;
 assert.equal(await read(cold,'private-document-name'),'private-document-content');assert.equal(api.calls.filter(c=>c.path.startsWith('/git/blobs/')).length,before);
 assert.deepEqual(await cold.list('private'),['private-document-name']);
});
test('Conditional writes and simultaneous cold instances preserve independent changes and reject stale revisions',async()=>{
 const api=fakeGithub(),a=make(api),b=make(api);await a.put('shared','start');const etag=(await a.head('shared')).etag;
 await Promise.all([a.put('first','one'),b.put('second','two')]);assert.equal(await read(make(api),'first'),'one');assert.equal(await read(make(api),'second'),'two');
 await b.put('shared','new',{ifMatch:etag});await assert.rejects(a.put('shared','old',{ifMatch:etag}),e=>e.name==='BlobPreconditionFailedError');assert.equal(await read(make(api),'shared'),'new');
 await assert.rejects(a.put('shared','duplicate'),e=>e.name==='BlobAlreadyExistsError');
});
test('Expired login objects are inaccessible, long-lived documents persist, and deletion cannot resurrect them',async()=>{
 let time=Date.now();const api=fakeGithub(),s=make(api,{now:()=>time});await s.put('session','token',{ttlDays:1});await s.put('document','retained');time+=2*86400000;
 assert.equal(await read(s,'session'),null);assert.equal(await read(s,'document'),'retained');assert.deepEqual(await s.list(''),['document']);await s.del('document');assert.equal(await read(make(api),'document'),null);
});
test('An incorrect secret, tampered ciphertext or a public repository fails closed',async()=>{
 const api=fakeGithub(),s=make(api);await s.put('doc','content');await assert.rejects(read(make(api,{master:randomBytes(32).toString('base64url')}),'doc'),e=>e.status===503);
 const head=api.commits.get(api.refs.get('runtime-data')),tree=api.trees.get(head.tree),id=tree.get('index.enc');api.blobs.get(id)[40]^=1;await assert.rejects(read(make(api),'doc'),e=>e.status===503);
 const publicApi=fakeGithub();publicApi.private=false;await assert.rejects(make(publicApi).put('doc','secret'),e=>e.status===503);assert.equal(publicApi.calls.filter(c=>c.method==='POST').length,0);
});
test('Bulk recovery is atomic if any expected revision is stale',async()=>{
 const api=fakeGithub(),s=make(api);await s.put('existing','original');await assert.rejects(s.putMany([{path:'new',bytes:Buffer.from('not committed')},{path:'existing',bytes:Buffer.from('bad'),options:{ifMatch:'stale'}}]),e=>e.name==='BlobPreconditionFailedError');
 assert.equal(await read(make(api),'new'),null);assert.equal(await read(make(api),'existing'),'original');
});
test('Rate limits and network errors are bounded and do not expose provider responses',async()=>{
 const api=fakeGithub();api.failStatus=429;await assert.rejects(make(api).get('any'),e=>e.status===503&&!e.message.includes('sensitive'));assert.equal(api.calls.length,1);
 await assert.rejects(createGithubStorage({token:'x',master,request:async()=>{throw Error('secret');}}).get('any'),e=>e.status===503&&!e.message.includes('secret'));
});
test('Existing cloud transactions keep both decisions across GitHub instances and reuse reads only when requested',async()=>{
 const api=fakeGithub(),storage=make(api),a=createCloudStore('work',master,storage,{reuseReads:true}),b=createCloudStore('work',master,make(api));await a.initialize();await a.ensure();await a.credential();
 await Promise.all([a.change(db=>db.examples.push({id:'a'})),b.change(db=>db.examples.push({id:'b'}))]);assert.deepEqual((await b.read()).examples.map(x=>x.id).sort(),['a','b']);
});
test('Real HTTP login, profile persistence and logout work across cold handlers using only GitHub',async t=>{
 const api=fakeGithub(),salt=randomBytes(16).toString('hex'),accounts=[{id:'demo-official-v1',role:'official',username:'test.user',displayName:'Тестовый пользователь',salt,passwordHash:await passwordHash('only-a-test-password',salt)}];
 const server=http.createServer((req,res)=>createHostedHandler({storage:make(api),getMaster:()=>master,getAccounts:()=>accounts,getAdminAccount:()=>[],getAdminToken:()=>'',getDemoLogin:()=>true,pilotMode:true,schedule:()=>{}})(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,origin=base.replace('http:','https:');
 const call=async(path,cookie,data,method)=>{const r=await fetch(base+'/api/'+path,{method:method||(data===undefined?'GET':'POST'),headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{origin,'x-kruzhivo-client':'1','content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const stale=await call('auth/session','__Host-kruzhivo-account='+'a'.repeat(43));assert.equal(stale.status,200);assert.equal(stale.body.user,null);
 const login=await call('auth/login',null,{username:'test.user',password:'only-a-test-password'});assert.equal(login.status,200);
 let boot=await call('bootstrap',login.cookie);assert.equal(boot.status,200);assert.equal(boot.body.config.storage.provider,'github');assert.equal(boot.body.documents.length,0);
 const {avatar,...fields}=boot.body.profile;const profile={...fields,fullName:'Сохранённое имя',revision:boot.body.profile.revision};assert.equal((await call('profile',login.cookie,profile,'PUT')).status,200);
 boot=await call('bootstrap',login.cookie);assert.equal(boot.body.profile.fullName,'Сохранённое имя');assert(!JSON.stringify(boot.body).includes('passwordHash'));
 assert.equal((await call('storage/recover',login.cookie,{})).status,403);
 await call('auth/logout',login.cookie,{});assert.equal((await call('auth/session',login.cookie)).body.user,null);
 assert(api.calls.every(c=>!c.path.includes('neon')));
});
