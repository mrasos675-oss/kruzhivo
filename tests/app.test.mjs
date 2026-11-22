import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { createStore, newRun } from '../server/store.mjs';
import { extractDocx, zipFiles, reportDocx, unzipEntry } from '../server/files.mjs';
import { CATALOG, SAMPLE_TEXT, demoAnalysis } from '../server/catalog.mjs';
import { validateAnalysis, pipeline, completion } from '../server/engine.mjs';
const temp = () => mkdtemp(join(tmpdir(),'kruzhivo-test-'));
const zip = xml => zipFiles({'word/document.xml':xml});
const docXml = s => `<w:document><w:body><w:p><w:r><w:t>${s}</w:t></w:r></w:p></w:body></w:document>`;

test('DOCX extracts Cyrillic, paragraph breaks, escaped XML and numeric entities',()=>{
 assert.equal(extractDocx(zip(docXml('Привет &amp; &#x43C;&#1080;р'))),'Привет & мир');
 assert.equal(extractDocx(zip(docXml('Один')+docXml('Два'))),'Один\nДва');
});
test('DOCX rejects malformed, external chunks and oversize content without truncation',()=>{
 for(const b of [Buffer.from('not a zip'),zip('<!DOCTYPE x>'+docXml('x')),zip(docXml('x')+'<w:altChunk/>'),zip(docXml(''))]) assert.throws(()=>extractDocx(b));
 assert.throws(()=>extractDocx(zip(docXml('а'.repeat(80001)))),/не обрезан/);
});
test('Analyst rejects fabricated document and source quotations and incomplete coverage',()=>{
 const a=demoAnalysis(SAMPLE_TEXT);assert.equal(validateAnalysis(a,SAMPLE_TEXT,[]).coverage.length,12);
 const partial=validateAnalysis({...a,findings:a.findings.map((finding,i)=>i===0?{...finding,quote:'Выдуманная цитата'}:finding)},SAMPLE_TEXT,[]);
 assert.equal(partial.findings.length,a.findings.length-1);
 assert.ok(partial.findings.every(f=>SAMPLE_TEXT.includes(f.quote)));
 assert.match(partial.limitations.join(' '),/ручной сверки/);
 assert.throws(()=>validateAnalysis({...a,coverage:a.coverage.slice(1)},SAMPLE_TEXT,[]),/12 факторов/);
 assert.throws(()=>validateAnalysis({...a,findings:[{...a.findings[0],basis:[{sourceId:'fake',quote:'x',locator:'1'}]}]},SAMPLE_TEXT,[]),/Основание/);
});
test('Demo pipeline preserves a challenged finding and skips its edit',async()=>{
 const dir=await temp();try{const store=await createStore(dir);const d=store.read().documents[0];const r=newRun(d,d.versions[0],'demo',[],[],'');await pipeline(r,SAMPLE_TEXT,{signal:new AbortController().signal},async()=>{});assert.equal(r.findings.length,3);assert.equal(r.coverage.length,12);assert.equal(r.findings[1].review.verdict,'contested');assert.equal(r.findings[1].editor.status,'skipped');assert.equal(r.findings[0].decision.status,'pending');assert.equal(r.findings[0].editor.status,'prepared');}finally{await rm(dir,{recursive:true,force:true});}
});
test('Run snapshots exclude unverified or disabled sources and examples',()=>{
 const d={id:'d',runs:[]},v={id:'v'};const sources=[{id:'s',active:true,verified:true,text:'Текст',revision:'2026'},{id:'bad',active:true,verified:false,text:'Текст',revision:'2026'}];const examples=[{id:'good',active:true,verified:true,sourceIds:['s']},{id:'bad',active:true,verified:true,sourceIds:['bad']},{id:'pending',active:true,verified:false,sourceIds:['s']}];const r=newRun(d,v,'api',sources,examples,'deepseek-flash');assert.deepEqual(r.sources.map(s=>s.id),['s']);assert.deepEqual(r.examples.map(e=>e.id),['good']);sources[0].text='Изменён';assert.equal(r.sources[0].text,'Текст');
});
test('Three real stages use a mocked provider and validate all outputs without paid calls',async()=>{
 let calls=0;const dir=await temp();try{const store=await createStore(dir),d=store.read().documents[0],r=newRun(d,d.versions[0],'api',[{id:'test-source',active:true,verified:true,text:'Тестовая норма для синтетической проверки.',revision:'Тестовая редакция'}],[],'deepseek-flash');const fetcher=async(url,opts)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');const req=JSON.parse(opts.body),p=JSON.parse(req.messages[1].content);assert.equal(req.response_format.type,'json_object');let output;if(calls++===0)output={...demoAnalysis(SAMPLE_TEXT),findings:demoAnalysis(SAMPLE_TEXT).findings.map(f=>({...f,basis:[{sourceId:'test-source',locator:'Тестовый пункт',quote:'Тестовая норма'}]}))};else if(calls===2)output={reviews:p.findings.map((f,i)=>({findingId:f.id,verdict:i===1?'contested':'supported',explanation:'Сверено с контекстом',counterarguments:[],evidence:[],checks:{context:'Проверен',exception:'Нет данных',applicability:'Требует проверки',freshness:'Нет данных'},doubts:['Нет проверенных норм']}))};else output={edits:p.findings.map(f=>({findingId:f.id,explanation:'Проект',proposal:'Уточнить по проверенным основаниям.',meaning:'uncertain',meaningExplanation:'Не хватает источника'}))};return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));};await pipeline(r,SAMPLE_TEXT,{key:'test-only',model:'deepseek-flash',fetcher,signal:new AbortController().signal},async()=>{});assert.equal(calls,3);assert.equal(r.findings[1].editor.status,'skipped');assert.equal(r.findings[0].editor.meaning,'uncertain');}finally{await rm(dir,{recursive:true,force:true});}
});
test('Provider errors never include echoed key or response body',async()=>{
 await assert.rejects(completion('','',{key:'secret',signal:new AbortController().signal,fetcher:async()=>new Response('secret',{status:401})}),e=>/отклонил ключ/.test(e.message)&&!e.message.includes('secret'));
});
test('HTTP: security, decisions, conflicts, report, versions and persistence',async()=>{
 const dir=await temp();const app=await createApp({dataDir:dir,initialKey:'secret-test-key'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,data,method='POST',extra={})=>fetch(base+'/api/'+path,data===undefined?extra:{method,headers:{Origin:base,'x-kruzhivo-client':'1','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
 try{

 const boot=await(await call('bootstrap')).json();assert.equal(boot.config.configured,true);assert.ok(!JSON.stringify(boot).includes('secret-test-key'));
 const evil=await new Promise((resolve,reject)=>{http.get(base+'/api/bootstrap',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(evil,403);
 assert.equal((await fetch(base+'/api/settings',{method:'POST',body:'{}'})).status,403);
 assert.match((await fetch(base)).headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const d=boot.documents[0],r=d.runs[0],f=r.findings[0];
 const endpoint=`runs/${r.id}/findings/${f.id}`;
 assert.equal((await call(endpoint,{status:'rejected',revision:0},'PUT')).status,400);
 assert.equal((await call(endpoint,{status:'rejected',revision:0,explanation:'Уточнение в другом пункте'},'PUT')).status,200);
 assert.equal((await call(endpoint,{status:'confirmed',revision:0},'PUT')).status,409);
 const report=await call(`runs/${r.id}/report.docx`);assert.equal(report.status,200);assert.match(report.headers.get('content-type'),/wordprocessingml/);const text=extractDocx(Buffer.from(await report.arrayBuffer()));assert.match(text,/Уточнение в другом пункте/);assert.match(text,/ПРЕДВАРИТЕЛЬНЫЙ/);
 const vv=await(await call(`documents/${d.id}/versions`,{text:SAMPLE_TEXT})).json();assert.ok(vv.id);
 const rr=await(await call(`documents/${d.id}/runs`,{versionId:vv.id,mode:'demo'})).json();assert.ok(rr.id);
 for(let n=0;n<50;n++){const b=await(await call('bootstrap')).json();if(b.documents[0].runs.find(x=>x.id===rr.id).status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 const after=await(await call('bootstrap')).json();assert.equal(after.documents[0].runs[0].findings[0].decision.status,'rejected');assert.equal(after.documents[0].runs.at(-1).findings[0].decision.status,'pending');
 const own=await(await call('documents',{name:'Мой документ',text:'Произвольный текст'})).json();const ownDoc=(await(await call('bootstrap')).json()).documents.find(x=>x.id===own.id);assert.equal((await call(`documents/${own.id}/runs`,{versionId:ownDoc.versions[0].id,mode:'demo'})).status,422);
 const disk=await readFile(join(dir,'workspace.json'),'utf8');assert.ok(!disk.includes('secret-test-key'));assert.match(disk,/Уточнение в другом пункте/);
 assert.ok(unzipEntry(reportDocx(d,d.versions[0],r),'word/document.xml').length);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('Store does not overwrite on a failed transaction and survives restart',async()=>{
 const dir=await temp();try{const store=await createStore(dir);await assert.rejects(store.change(db=>{db.documents=[];throw Error('fail');}));assert.equal(store.read().documents.length,3);await store.change(db=>{db.documents[0].name='Сохранено';});const reopened=await createStore(dir);assert.equal(reopened.read().documents[0].name,'Сохранено');}finally{await rm(dir,{recursive:true,force:true});}
});

test('Verified source and example lifecycle affects only future runs',async()=>{
 const dir=await temp(),app=await createApp({dataDir:dir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,data,method='POST')=>{const res=await fetch(base+'/api/'+path,data===undefined?{}:{method,headers:{Origin:base,'x-kruzhivo-client':'1','Content-Type':'application/json'},body:JSON.stringify(data)});return {status:res.status,data:await res.json()};};
 try{const boot=(await call('bootstrap')).data,d=boot.documents[0],r=d.runs[0],f=r.findings[0];
 const source=await call('sources',{title:'Учебный источник для теста',url:'https://example.org/norm',revision:'Тестовая редакция',applicability:'Только автоматический тест',text:'Точный учебный текст',verified:false});assert.equal(source.status,201);
 await call(`runs/${r.id}/findings/${f.id}`,{status:'confirmed',explanation:'Учебное решение',revision:0},'PUT');
 const example=await call('examples',{runId:r.id,findingId:f.id});assert.equal(example.status,201);
 assert.equal((await call(`examples/${example.data.id}`,{verified:true},'PATCH')).status,400);
 await call(`sources/${source.data.id}`,{verified:true},'PATCH');
 assert.equal((await call(`examples/${example.data.id}`,{sourceIds:[source.data.id],applicability:'Учебная область',verified:true},'PATCH')).status,200);
 const b=(await call('bootstrap')).data,run=newRun(d,d.versions[0],'api',b.sources,b.examples,'deepseek-flash');assert.equal(run.sources.length,1);assert.equal(run.examples.length,1);
 await call(`sources/${source.data.id}`,{active:false},'PATCH');const after=(await call('bootstrap')).data;assert.equal(newRun(d,d.versions[0],'api',after.sources,after.examples,'deepseek-flash').examples.length,0);assert.equal(run.sources[0].active,true);assert.equal(after.documents[0].runs[0].sources.length,0);
 assert.equal((await call('documents',null)).status,400);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('Cancelled provider call preserves partial results and cannot complete later',async()=>{
 const dir=await temp();let entered=false;
 const app=await createApp({dataDir:dir,initialKey:'test-key',fetcher:async(_u,o)=>{entered=true;return new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});});}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,data)=>{const res=await fetch(base+'/api/'+path,data===undefined?{}:{method:'POST',headers:{Origin:base,'x-kruzhivo-client':'1','Content-Type':'application/json'},body:JSON.stringify(data)});return res.json();};
 try{const b=await call('bootstrap'),d=b.documents[0];const run=await call(`documents/${d.id}/runs`,{mode:'api',versionId:d.versions[0].id});for(let i=0;i<40&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true);await call(`runs/${run.id}/cancel`,{});for(let i=0;i<5;i++)await call('bootstrap');const after=await call('bootstrap'),result=after.documents[0].runs.find(r=>r.id===run.id);assert.equal(result.status,'cancelled');assert.equal(result.findings.length,0);assert.equal(after.documents[0].runs[0].status,'completed');}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('Export strips invalid XML controls and includes exact legal basis quotations',()=>{
 const a=demoAnalysis(SAMPLE_TEXT),r={status:'completed',createdAt:new Date().toISOString(),mode:'demo',number:1,findings:[{...a.findings[0],basis:[{sourceId:'s',locator:'п.1',quote:'Точная цитата нормы'}],decision:{status:'confirmed',explanation:'Тест\u0000',proposal:'',basis:''}}],coverage:[],limitations:[],sources:[{id:'s',title:'Учебный источник',revision:'Тестовая редакция',url:'https://example.org'}]};const xml=unzipEntry(reportDocx({name:'Тест'}, {number:1},r),'word/document.xml').toString();assert.ok(!xml.includes('\u0000'));assert.match(xml,/Точная цитата нормы/);assert.match(xml,/Тестовая редакция/);
});

test('HTTP: confirmed territory metadata preserves legacy filter values',async()=>{
 const dir=await temp();const app=await createApp({dataDir:dir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,data,method='POST',extra={})=>fetch(base+'/api/'+path,data===undefined?extra:{method,headers:{Origin:base,'x-kruzhivo-client':'1','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
 try{
  const legacy = await (await call('documents',{name:'Старый НПА',text:'Текст',level:'Муниципальный',territory:'Волжский'})).json();
  const metadataPath = 'documents/'+legacy.id+'/metadata';
  const municipal = {level:'Муниципальный',region:'Волгоградская область',municipality:'Волжский',source:'manual'};
  assert.equal((await call(metadataPath,{...municipal,region:''},'PATCH')).status,400);
  assert.equal((await call(metadataPath,{...municipal,level:'Федеральный'},'PATCH')).status,400);
  assert.equal((await call(metadataPath,municipal,'PATCH')).status,200);
  const savedLegacy = app.store.read().documents.find(d=>d.id===legacy.id);
  assert.deepEqual(savedLegacy.npaMetadata,{...municipal,sourceUrl:null});
  assert.equal(savedLegacy.territory,'Волжский');
  const created = await call('documents',{name:'Региональный НПА',text:'Текст',level:'Региональный',region:'Волгоградская область',source:'official',sourceUrl:'https://example.org/act'});
  assert.equal(created.status,201);
  const savedNew = app.store.read().documents.find(d=>d.name==='Региональный НПА');
  assert.equal(savedNew.territory,'Волгоградская область');
  assert.equal(savedNew.npaMetadata.sourceUrl,'https://example.org/act');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
