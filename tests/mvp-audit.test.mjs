import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocumentStructure } from '../shared/document-structure.mjs';
import { moscowTime,methodReference,nextPendingIndex,missingBasisCount } from '../shared/report-format.mjs';
import { seed } from '../server/store.mjs';
import { CATALOG,SAMPLE_TEXT } from '../server/catalog.mjs';
import { reportDocx,extractDocx } from '../server/files.mjs';
import { createExpertReview } from '../server/expert-review.mjs';
import { createApp } from '../server/index.mjs';

test('Structure is recognized inside one line; reference and Moscow time are explicit; next pending wraps safely',()=>{
 const rows=parseDocumentStructure('1. Первый пункт. 2.4. Второй пункт. 2.5. Третий пункт.');assert.deepEqual(rows.map(x=>x.number),['1','2.4','2.5']);assert.equal(rows[1].text,'Второй пункт.');
 assert.equal(parseDocumentStructure('Первый абзац\nВторой абзац').length,2);assert.match(moscowTime('2026-11-16T19:44:35Z'),/22:44:35 \(МСК\)/);assert.match(methodReference('F01',CATALOG),/«а» п. 3/);
 const r={findings:[{decision:{status:'pending',basis:''}},{decision:{status:'rejected',basis:''}},{decision:{status:'modified',basis:'Норма'}}]};assert.equal(nextPendingIndex(r,2),0);assert.equal(missingBasisCount(r),1);r.findings[0].decision.status='confirmed';assert.equal(nextPendingIndex(r,2),-1);
});
test('Word keeps UI numbers when grouped, translates statuses, includes author and both edited versions',()=>{
 const doc=seed().documents[0],r=doc.runs[0];r.createdAt='2026-11-16T19:44:35Z';r.findings[2].decision={...r.findings[2].decision,status:'modified',proposal:'Редакция специалиста',comment:'Пояснение автора',systemOriginal:{proposal:'Исходная редакция'},revision:1};r.findings[0].decision.status='rejected';
 const text=extractDocx(reportDocx(doc,doc.versions[0],r,{fullName:'Автор отчёта',organization:'Учебная организация',position:'Специалист'}));
 for(const value of ['Замечание 3','Замечание 1','Исходная редакция','Редакция специалиста','Пояснение автора','Автор отчёта','22:44:35 (МСК)','Не передавались','пп. «а» п. 3'])assert.ok(text.includes(value),value);
 for(const token of ['supported','contested','limited','context:','prepared','skipped'])assert.ok(!text.includes(token),token);
});
test('Concurrent expert requests deduplicate atomically and snapshots show specialist decisions',async()=>{
 let db={expertCases:[]};let q=Promise.resolve();const store={read:()=>structuredClone(db),change(fn){const promise=q.then(()=>{const next=structuredClone(db),value=fn(next);db=next;return value;});q=promise.catch(()=>{});return promise;}};
 const service=createExpertReview(store,'owner'),doc=seed().documents[0],r=doc.runs[0];for(const f of r.findings)f.decision={...f.decision,status:'confirmed',revision:1};r.findings[0].decision={...r.findings[0].decision,status:'modified',comment:'Комментарий специалиста'};
 const [a,b]=await Promise.all([service.create(doc,doc.versions[0],r,{expertId:'expert',profile:{name:'Эксперт'},comment:'Проверьте основание'}),service.create(doc,doc.versions[0],r,{expertId:'expert',profile:{name:'Эксперт'}})]);assert.equal(a.id,b.id);assert.equal(db.expertCases.length,1);
 const c=await createExpertReview(store,'expert').get(a.id);assert.equal(c.run.findings[0].decision.comment,'Комментарий специалиста');assert.equal(c.requestComment,'Проверьте основание');assert.equal((await createExpertReview(store,'outsider').list()).length,0);
 await store.change(db=>{db.expertCases.push({...structuredClone(db.expertCases[0]),id:'empty-duplicate'});db.expertCases.push({...structuredClone(db.expertCases[0]),id:'signed-duplicate',conclusions:[{status:'confirmed',text:'Содержательное заключение'}]});});const result=await service.archiveEmptyDemoDuplicates();assert.equal(result.archived,2);assert.equal((await service.list())[0].id,'signed-duplicate');
});
test('HTTP saves modified decisions with revision checks, exports both formats and a run manifest',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kruzhivo-audit-')),app=await createApp({dataDir:dir,initialKey:''});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const base='http://127.0.0.1:'+app.server.address().port;
 const call=(path,data,method='POST')=>fetch(base+'/api/'+path,{method,headers:{origin:base,'x-kruzhivo-client':'1','content-type':'application/json'},body:JSON.stringify(data)});
 const doc=app.store.read().documents[0],r=doc.runs[0],f=r.findings[0];const saved=await call('runs/'+r.id+'/findings/'+f.id,{status:'modified',revision:0,explanation:'Изменённое объяснение',proposal:'Новая редакция',comment:'Пояснение',factorIds:['F01','F12'],basis:'Проверено специалистом'},'PUT');assert.equal(saved.status,200);const result=await saved.json();assert.equal(result.status,'modified');assert.deepEqual(result.factorIds,['F01','F12']);assert.ok(result.systemOriginal.explanation);
 assert.equal((await call('runs/'+r.id+'/findings/'+f.id,{status:'confirmed',revision:0},'PUT')).status,409);
 for(const format of ['pdf','docx']){const response=await fetch(base+'/api/runs/'+r.id+'/report.'+format);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>1000);}
 const manifest=await fetch(base+'/api/runs/'+r.id+'/manifest.json');assert.equal(manifest.status,200);const input=await manifest.json();assert.equal(input.documentHash,doc.versions[0].hash);assert.equal(input.document,SAMPLE_TEXT);assert.equal(input.mode,'demo');
 const canonical=await fetch(base+'/api/sample-documents/canonical.docx');assert.equal(canonical.status,200);assert.equal(extractDocx(Buffer.from(await canonical.arrayBuffer())),SAMPLE_TEXT);
});
test('The frontend preserves API mode, uses an explicit expert request form, and does not collect sex or age',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),profile=await readFile(new URL('../public/profile.js',import.meta.url),'utf8'),build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');assert.match(app,/Изменить и подтвердить/);assert.match(app,/comment:values.comment/);assert.match(app,/nextPendingIndex\(locate/);assert.match(app,/aria-busy/);assert.match(app,/Скачать отчёт/);assert.match(app,/report\.pdf/);assert.match(app,/report\.docx/);assert.ok(!profile.includes("'gender'"));assert.ok(!profile.includes("'ageGroup'"));assert.match(build,/report-format.mjs/);
});
