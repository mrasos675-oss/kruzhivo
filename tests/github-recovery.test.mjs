import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fakeGithub} from './helpers/github.mjs';
import {createGithubStorage} from '../server/github-store.mjs';
import {recoverGithubHistory} from '../server/github-recovery.mjs';
import {createCloudStore} from '../server/cloud-store.mjs';
const master=randomBytes(32).toString('base64url'),account={id:'demo-official-v1',role:'official'},workspace='account-demo-official-v1-operations-v1';
function fixture(){const api=fakeGithub(),id=randomUUID(),vid=randomUUID(),rid=randomUUID(),bytes=Buffer.from('synthetic-original'),text='1. Синтетический текст.',hash=v=>createHash('sha256').update(v).digest('hex'),version={id:vid,number:1,text,hash:hash(text),createdAt:new Date().toISOString(),original:{fileId:randomUUID(),size:bytes.length,sha256:hash(bytes)}};
 const submitted={type:'submitted',runId:rid,data:{document:{id,name:'Тестовый документ',version},originalDocxBase64:bytes.toString('base64')}},result={type:'result',runId:rid,data:{documentId:id,versionId:vid,run:{id:rid,versionId:vid,status:'completed',createdAt:new Date().toISOString(),findings:[]}}};
 api.addArchive('reviews/'+rid+'/01-submission.json',submitted);api.addArchive('reviews/'+rid+'/02-result.json',result);
 const storage=createGithubStorage({token:'test',master,request:api.request,writeIntervalMs:0,cacheMs:0});return {api,storage,version,bytes,submitted,result};}
test('Archive recovery preserves original bytes and IDs, marks its limits, and never replaces later human decisions',async()=>{
 const f=fixture(),options={...f,master,token:'test',account,request:f.api.request};const r=await recoverGithubHistory(options);assert.equal(r.documents,1);assert.equal(r.runs,1);assert.equal(r.partial,true);
 const store=createCloudStore(workspace,master,f.storage);let db=await store.read();assert.equal(db.documents[0].versions[0].id,f.version.id);assert.equal(db.documents[0].runs[0].id,f.result.runId);assert.deepEqual(await store.originals.read(f.version),f.bytes);assert(db.archiveRecovery.partial);
 await store.change(db=>{db.documents[0].name='Новое решение сохранено';});await recoverGithubHistory(options);db=await store.read();assert.equal(db.documents[0].name,'Новое решение сохранено');assert.equal(db.documents.length,1);
});
test('A damaged archive is rejected before any runtime write',async()=>{
 const f=fixture();f.submitted.data.document.version.hash='invalid';f.api.archive=[];f.api.addArchive('reviews/'+f.submitted.runId+'/01-submission.json',f.submitted);f.api.addArchive('reviews/'+f.result.runId+'/02-result.json',f.result);
 await assert.rejects(recoverGithubHistory({...f,master,token:'test',account,request:f.api.request}),e=>e.status===503);assert.equal(f.api.refs.size,0);
});
test('Recovery preserves missing expert-case IDs as historical data, repairs only its own dangling links and keeps human decisions',async()=>{
 const f=fixture(),oldCase=randomUUID();f.result.data.run.expertCaseId=oldCase;f.api.archive=[];
 f.api.addArchive('reviews/'+f.submitted.runId+'/01-submission.json',f.submitted);f.api.addArchive('reviews/'+f.result.runId+'/02-result.json',f.result);
 const options={...f,master,token:'test',account,request:f.api.request};await recoverGithubHistory(options);
 const store=createCloudStore(workspace,master,f.storage);let r=(await store.read()).documents[0].runs[0];assert.equal(r.expertCaseId,undefined);assert.equal(r.historicalExpertCaseId,oldCase);
 await store.change(db=>{const r=db.documents[0].runs[0];r.expertCaseId=oldCase;r.findings=[{decision:{status:'modified',comment:'Позднее решение'}}];});
 assert.equal((await recoverGithubHistory(options)).repaired,1);r=(await store.read()).documents[0].runs[0];assert.equal(r.expertCaseId,undefined);assert.equal(r.findings[0].decision.comment,'Позднее решение');
 const newCase=randomUUID();await store.change(db=>{db.documents[0].runs[0].expertCaseId=newCase;});await recoverGithubHistory(options);assert.equal((await store.read()).documents[0].runs[0].expertCaseId,newCase);
});
