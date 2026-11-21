import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { newRun,version } from '../server/store.mjs';
import { pipeline } from '../server/engine.mjs';
import { SAMPLE_TEXT,demoAnalysis } from '../server/catalog.mjs';
import { resumeRun,nextStage } from '../server/run-stages.mjs';
import { createRunDispatcher } from '../server/run-dispatch.mjs';
import { createHostedHandler } from '../api/index.mjs';
import { createCloudStore } from '../server/cloud-store.mjs';
import { newSession } from '../server/cloud-security.mjs';
import { randomBytes } from 'node:crypto';

function storage(){const files=new Map();let rev=0;return {async get(p){const r=files.get(p);return r?{statusCode:200,stream:new Blob([r.bytes]).stream()}:null;},async head(p){return {etag:files.get(p)?.etag};},async put(p,bytes,o){const r=files.get(p);if(o.ifMatch&&o.ifMatch!==r?.etag)throw Object.assign(Error('race'),{name:'BlobPreconditionFailedError'});if(r&&o.allowOverwrite===false)throw Object.assign(Error('race'),{name:'BlobAlreadyExistsError'});files.set(p,{bytes,etag:String(++rev)});},async del(p){files.delete(p);}};}

test('Each invocation completes one checkpoint; resuming skips completed stages and preserves the failed attempt',async()=>{
 const v=version(SAMPLE_TEXT),d={id:'doc',runs:[]},r=newRun(d,v,'demo',[],[],'');d.runs.push(r);
 const options={singleStage:true,signal:new AbortController().signal};const persist=async()=>{};
 await pipeline(r,v.text,options,persist);assert.equal(nextStage(r),'reviewer');assert(r.findings.every(f=>!f.review));const findings=structuredClone(r.findings);
 await pipeline(r,v.text,options,persist);assert.equal(nextStage(r),'editor');assert.deepEqual(r.findings.map(f=>f.id),findings.map(f=>f.id));
 r.status='failed';r.stages.editor='failed';const before=JSON.stringify(r),resumed=resumeRun(d,r,v);assert.equal(resumed.resumedFrom,r.id);assert.equal(nextStage(resumed),'editor');assert.equal(JSON.stringify(r),before);
 await pipeline(resumed,v.text,options,async(stage)=>assert.equal(stage,'editor'));assert.equal(nextStage(resumed),undefined);assert.equal(JSON.stringify(r),before);assert.throws(()=>resumeRun(d,{...r,status:'completed'},v));
});

test('Dispatcher forwards cookies only to its configured origin, never follows redirects',async()=>{
 let sent;const request=async(url,options)=>{sent={url,options};return new Response('{}',{status:202});};
 assert.equal(createRunDispatcher({headers:{host:'attacker.example',cookie:'secret'}},{production:'own.example',request}),null);
 const send=createRunDispatcher({headers:{host:'own.example',cookie:'test-session'}},{production:'own.example',request});await send('run');assert.equal(sent.url,'https://own.example/api/runs/run/advance');assert.equal(sent.options.headers.Cookie,'test-session');assert.equal(sent.options.redirect,'error');
});

test('Cold hosted requests continue separate stages, reject duplicate workers, and resume only the editor after failure',async()=>{
 const master=randomBytes(32).toString('base64url'),session=newSession(master),blob=storage(),store=createCloudStore(session.id,master,blob);await store.initialize();
 const connection={provider:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com',model:'deepseek-chat',jsonMode:true};await store.setCredential('test-key',connection.model,connection);
 let calls=0,failEditor=true,block,unblock;const pending=[];let origin;
 const fetcher=async(url,opts)=>{calls++;const payload=JSON.parse(JSON.parse(opts.body).messages[1].content);let result;
 if(payload.catalog){await new Promise(resolve=>{unblock=resolve;if(!block)resolve();});result=demoAnalysis(SAMPLE_TEXT);}
 else if(payload.findings?.[0]?.review){if(failEditor)throw Error('simulated interruption');result={edits:payload.findings.map(f=>({findingId:f.id,explanation:'Test',proposal:'Test',meaning:'uncertain',meaningExplanation:'Needs review'}))};}
 else result={reviews:payload.findings.map(f=>({findingId:f.id,verdict:'supported',explanation:'Test',counterarguments:[],evidence:[],checks:{context:'Test',exception:'Test',applicability:'Test',freshness:'Test'},doubts:[]}))};
 return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));};
 const headers=()=>({'Content-Type':'application/json','x-kruzhivo-client':'1',Origin:origin,Cookie:session.cookie.split(';')[0]});
 let dispatches=0;const dispatcher=async id=>{dispatches++;const r=await fetch(base+'/api/runs/'+id+'/advance',{method:'POST',headers:headers(),body:'{}'});assert.equal(r.status,202);};
 const server=http.createServer((req,res)=>createHostedHandler({getMaster:()=>master,getAdminToken:()=>null,authRequired:false,storage:blob,fetcher,getDispatcher:()=>dispatcher,schedule:p=>pending.push(p)})(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;origin=base.replace('http:','https:');
 const post=async(path,body={})=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:headers(),body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,202,JSON.stringify(data));return data;};
 try{
 const db=await store.read(),doc=db.documents[2];block=true;const started=await post('documents/'+doc.id+'/runs',{versionId:doc.versions[0].id,mode:'api'});
 while(!unblock)await new Promise(r=>setTimeout(r,5));await post('runs/'+started.id+'/advance');assert.equal(calls,1);unblock();block=false;
 for(let i=0;i<pending.length;i++)await pending[i];
 const failed=(await store.read()).documents.find(d=>d.id===doc.id).runs.at(-1);assert.equal(failed.status,'failed');assert.equal(failed.stages.analyst,'completed');assert.equal(failed.stages.reviewer,'completed');assert.equal(failed.stages.editor,'failed');assert.equal(dispatches,2);assert.equal(calls,3);
 const saved=JSON.stringify(failed);failEditor=false;const resumed=await post('runs/'+failed.id+'/resume');for(let i=0;i<pending.length;i++)await pending[i];
 const runs=(await store.read()).documents.find(d=>d.id===doc.id).runs;assert.equal(JSON.stringify(runs.find(r=>r.id===failed.id)),saved);assert.equal(runs.at(-1).id,resumed.id);assert.equal(runs.at(-1).status,'completed');assert.equal(calls,4);assert.equal(runs.at(-1).resumedFrom,failed.id);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Recovery uses the active stage lease instead of total run age and expires abandoned stages',async()=>{
 const blob=storage(),store=createCloudStore('stage-recovery','x'.repeat(43),blob);await store.initialize();
 let runId;await store.change(db=>{const d=db.documents[2],r=newRun(d,d.versions[0],'demo',[],[],'');r.createdAt=new Date(Date.now()-900000).toISOString();r.execution={token:'stage',expiresAt:Date.now()+60000};r.stages.analyst='completed';r.stages.reviewer='running';d.runs.push(r);runId=r.id;});
 const active=await store.recover();assert.equal(active.documents[2].runs.at(-1).status,'running');
 await store.change(db=>{db.documents[2].runs.at(-1).execution.expiresAt=Date.now()-1;});const expired=await store.recover();const r=expired.documents[2].runs.find(r=>r.id===runId);assert.equal(r.status,'failed');assert.equal(r.stages.analyst,'completed');assert.equal(r.stages.reviewer,'failed');
});
