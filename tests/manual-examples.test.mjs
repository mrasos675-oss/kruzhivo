import test from 'node:test';
import assert from 'node:assert/strict';
import { manualExample } from '../server/examples.mjs';
import { newRun } from '../server/store.mjs';
import { roleAllowed } from '../server/account-auth.mjs';
const fields={problem:'Неопределённый срок',proposal:'Указать точный срок',criterion:'Срок выражен числом дней',verified:true,sourceIds:['s']};
test('Manual example remains unverified and excluded from analysis',()=>{
 const e=manualExample(fields,{role:'expert',displayName:'Эксперт'});
 assert.equal(e.verified,false);assert.deepEqual(e.sourceIds,[]);assert.equal(e.criterion,fields.criterion);assert.equal(e.proposal,fields.proposal);
 assert.deepEqual(newRun({id:'d',runs:[]},{id:'v'},'api',[],[e],'test').examples,[]);
});
test('Manual example validates fields and expert rights',()=>{
 for(const key of ['problem','proposal','criterion'])for(const value of ['',null,42,'x'.repeat(10001)])assert.throws(()=>manualExample({...fields,[key]:value},{role:'expert'}));
 for(const role of ['official','admin'])assert.throws(()=>manualExample(fields,{role}),e=>e.status===403);
 assert.equal(roleAllowed({role:'expert'},'POST','/api/examples'),true);
 assert.equal(roleAllowed({role:'expert'},'PATCH','/api/examples/test'),true);
 assert.equal(roleAllowed({role:'expert'},'POST','/api/documents'),false);
});

test('HTTP manual example persists as draft and rejects incomplete input',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createApp}=await import('../server/index.mjs');
 const dir=await mkdtemp(join(tmpdir(),'manual-example-')),app=await createApp({dataDir:dir,account:{id:'expert-test',role:'expert',displayName:'Эксперт'}});
 try{
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.server.address().port}`,post=b=>fetch(base+'/api/examples',{method:'POST',headers:{origin:base,'content-type':'application/json','x-kruzhivo-client':'1'},body:JSON.stringify(b)});
  assert.equal((await post({manual:true,problem:'Проблема'})).status,400);
  const response=await post({...fields,manual:true});assert.equal(response.status,201);const {id}=await response.json();
  const db=await (await fetch(base+'/api/bootstrap')).json(),e=db.examples.find(x=>x.id===id);assert.ok(e);assert.equal(e.verified,false);assert.equal(e.criterion,fields.criterion);assert.deepEqual(e.sourceIds,[]);
  assert.equal(db.examples.length,1);
 }finally{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
