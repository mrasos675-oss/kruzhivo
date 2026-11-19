import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';
import { pipeline } from '../server/engine.mjs';
import { CATALOG } from '../server/catalog.mjs';
import { newRun, version } from '../server/store.mjs';
import { policySnapshot, methodology } from '../server/transparency.mjs';
import { normalizeConnection } from '../server/providers.mjs';
import { MATERIAL_LIBRARY } from '../server/materials.mjs';
import { QUALITY_CASES } from '../shared/quality-cases.mjs';
import { runDetailsContent, methodologyContent, materialsContent, qualityContent } from '../public/transparency.js';

const connection = normalizeConnection({ provider:'polza', model:'test/model' });
const emptyAnalysis = () => ({ findings:[], coverage:CATALOG.factors.map(f=>({factorId:f.id,status:'limited',note:'Недостаточно нормативных источников.'})),limitations:['Применимые нормы не предоставлены.'] });

test('Drive registry distinguishes supplied files from actually transmitted guidance and legal sources', () => {
  assert.equal(MATERIAL_LIBRARY.files.length,13);
  assert.equal(MATERIAL_LIBRARY.files.reduce((n,f)=>n+f.pages,0),453);
  assert.equal(MATERIAL_LIBRARY.files.filter(f=>f.usedInPrompts).length,5);
  assert.ok(MATERIAL_LIBRARY.files.every(f=>f.legalAuthority===false && f.readingLimitations && /^[a-f0-9]{64}$/.test(f.localOriginalSha256)));
  assert.equal(new Set(MATERIAL_LIBRARY.files.map(f=>f.id)).size,13);
  assert.equal(QUALITY_CASES.length,12); assert.ok(QUALITY_CASES.every(c=>!c.specialistApproved));
});

test('Snapshot is independent of current library objects and pipeline uses saved instructions', async () => {
  const snapshot=policySnapshot(connection),initial=policySnapshot(connection);
  assert.equal(snapshot.fingerprint,initial.fingerprint);
  snapshot.version='saved-test-policy';snapshot.methodology.version='saved-test-policy';snapshot.prompts.analyst='SAVED INSTRUCTION';
  snapshot.materials.files[0].name='Snapshot-only change';assert.notEqual(MATERIAL_LIBRARY.files[0].name,snapshot.materials.files[0].name);
  const text='1.1. Синтетический документ.',v=version(text),run=newRun({id:'d',runs:[]},v,'api',[],[],connection.model);
  run.aiPolicy=snapshot;let calls=0;
  await pipeline(run,text,{key:'secret-sentinel-key',connection,signal:new AbortController().signal,fetcher:async(_url,opts)=>{
    calls++;const body=JSON.parse(opts.body),payload=JSON.parse(body.messages[1].content);
    assert.equal(body.messages[0].content,'SAVED INSTRUCTION');
    assert.equal(payload.methodologicalContext.version,'saved-test-policy');
    assert.equal(payload.sources.length,0);assert.equal(payload.examples.length,0);
    assert.equal(payload.materials,undefined);assert.equal(payload.qualityCases,undefined);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emptyAnalysis())}}]});
  }},async()=>{});
  assert.equal(calls,1);assert.equal(run.aiPolicy.version,'saved-test-policy');assert.equal(run.aiTrace[0].promptVersion,'saved-test-policy');
  assert.equal(run.aiInputs[0].documentHash,v.hash);assert.equal(run.aiInputs[0].documentCharacters,text.length);
  assert.ok(!JSON.stringify(run).includes('secret-sentinel-key'));
});

test('HTTP run records policy before execution and stage inputs survive a fresh read', async t => {
  const dir=await mkdtemp(join(tmpdir(),'kruzhivo-transparency-'));let release,entered,background;
  const waiting=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const app=await createApp({dataDir:dir,initialKey:'private-test-key',initialConnection:connection,schedule:p=>{background=p;},fetcher:async()=>{
    entered();await gate;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emptyAnalysis())}}]});
  }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release();await background;await app.close();await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async(path,data)=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-kruzhivo-client':'1'},body:JSON.stringify(data)});assert.ok(r.ok);return r.json();};
  const doc=await post('documents',{name:'Тест',text:'1.1. Тестовый текст.'});
  let boot=await(await fetch(base+'/api/bootstrap')).json();const d=boot.documents.find(x=>x.id===doc.id);
  const started=await post(`documents/${doc.id}/runs`,{versionId:d.versions[0].id,mode:'api'});await waiting;
  boot=await(await fetch(base+'/api/bootstrap')).json();const r=boot.documents.find(x=>x.id===doc.id).runs.find(x=>x.id===started.id);
  assert.equal(r.aiPolicy.snapshotOrigin,'captured_at_creation');assert.equal(r.aiPolicy.materials.files.length,13);
  assert.equal(r.aiInputs.length,1);assert.ok(r.stageTimes.analyst.startedAt);assert.equal(r.stages.analyst,'running');
  assert.ok(!JSON.stringify(boot).includes('private-test-key'));
  const module=await fetch(base+'/transparency.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);assert.match(await module.text(),/export function runDetailsContent/);
  const methods=await(await fetch(base+'/api/methodology')).json();assert.equal(methods.qualityCases.length,12);assert.ok(!JSON.stringify(methods).includes('private-test-key'));
  release();await background;
  const finished=await(await fetch(base+'/api/bootstrap')).json();
  const stored=finished.documents.find(x=>x.id===doc.id).runs.find(x=>x.id===started.id);
  assert.equal(stored.status,'completed');assert.ok(stored.stageTimes.analyst.finishedAt);
});

test('Transparency screens escape all returned data and never substitute current policy into old runs', () => {
  const text='<img src=x onerror=alert(1)>',x={d:{name:text},v:{number:1,text,hash:'h'},r:{id:'r',mode:'api',model:text,stages:{analyst:'failed',reviewer:'not_started',editor:'not_started'},sources:[],examples:[],aiTrace:[{stage:'analyst',response:text,finishReason:'stop'}]}};
  const html=runDetailsContent(x);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/Инструкции для этого запуска не сохранены/);assert.ok(!html.includes(methodology().version));
  assert.match(methodologyContent(methodology()),/Как ИИ проверяет документ/);assert.match(materialsContent(MATERIAL_LIBRARY),/13|Нормотворчество/);assert.match(qualityContent(QUALITY_CASES),/не утверждены/);
  const unsafe=structuredClone(MATERIAL_LIBRARY);unsafe.files[0].url='javascript:alert(1)';assert.ok(!materialsContent(unsafe).includes('href="javascript:'));
});
