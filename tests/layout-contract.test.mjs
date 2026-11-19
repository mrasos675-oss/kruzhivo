import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';
import { currentRun, isArchived, quoteContext } from '../shared/review.mjs';
import { zipFiles } from '../server/files.mjs';

async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'kruzhivo-layout-')),app=await createApp({dataDir:dir});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,data,method='POST')=>{const response=await fetch(base+'/api/'+path,data===undefined?{}:{method,headers:{Origin:base,'x-kruzhivo-client':'1','Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,body:await response.json()};};
 return{app,dir,base,call,close:async()=>{await app.close();await rm(dir,{recursive:true,force:true});}};
}

test('Creating a version makes every previous result read-only, including direct API writes',async()=>{
 const f=await fixture();try{const db=(await f.call('bootstrap')).body,d=db.documents[0],r=d.runs[0],finding=r.findings[0];
 await f.call(`runs/${r.id}/findings/${finding.id}`,{status:'confirmed',revision:0,explanation:'Сохранённое решение'},'PUT');
 await f.call(`documents/${d.id}/versions`,{text:'Следующая редакция',comment:'Уточнение срока'});
 const attempted=await f.call(`runs/${r.id}/findings/${finding.id}`,{status:'rejected',revision:1,explanation:'Попытка изменения архива'},'PUT');
 assert.equal(attempted.status,403);const after=(await f.call('bootstrap')).body.documents[0];assert.equal(after.runs[0].findings[0].decision.status,'confirmed');assert.equal(after.versions[1].comment,'Уточнение срока');assert.ok(isArchived(after,after.runs[0]));assert.equal(currentRun(after),undefined);
 }finally{await f.close();}
});

test('Original DOCX roundtrips byte-for-byte and is not embedded in workspace JSON',async()=>{
 const f=await fixture();try{const bytes=zipFiles({'word/document.xml':'<w:document><w:body><w:p><w:r><w:t>Исходный документ &amp; данные</w:t></w:r></w:p></w:body></w:document>'});
 const uploaded=await f.call('extract',{fileName:'Регламент.docx',base64:bytes.toString('base64')});assert.equal(uploaded.status,200);assert.ok(uploaded.body.uploadId);
 const created=await f.call('documents',{name:'Загруженный регламент',text:uploaded.body.text,uploadId:uploaded.body.uploadId});assert.equal(created.status,201);
 const d=(await f.call('bootstrap')).body.documents.find(d=>d.id===created.body.id),v=d.versions[0];assert.ok(v.original.sha256);assert.equal(v.original.size,bytes.length);
 const response=await fetch(`${f.base}/api/documents/${d.id}/versions/${v.id}/original`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.match(response.headers.get('content-disposition'),/filename\*=UTF-8/);
 const replay=await f.call('documents',{name:'Повторное использование',text:uploaded.body.text,uploadId:uploaded.body.uploadId});assert.equal(replay.status,409);
 assert.ok(!(await readFile(join(f.dir,'workspace.json'),'utf8')).includes(bytes.toString('base64')));
 }finally{await f.close();}
});

test('DOCX token cannot be attached to a different text and old text-only versions stay downloadable',async()=>{
 const f=await fixture();try{const bytes=zipFiles({'word/document.xml':'<w:p>Оригинальный текст</w:p>'});const uploaded=(await f.call('extract',{fileName:'source.docx',base64:bytes.toString('base64')})).body;
 assert.equal((await f.call('documents',{name:'Подмена',text:'Другой текст',uploadId:uploaded.uploadId})).status,400);
 const d=(await f.call('bootstrap')).body.documents[0],v=d.versions[0];assert.equal((await fetch(`${f.base}/api/documents/${d.id}/versions/${v.id}/original`)).status,404);const response=await fetch(`${f.base}/api/documents/${d.id}/versions/${v.id}/text`);assert.equal(await response.text(),v.text);
 }finally{await f.close();}
});

test('Quote context chooses the referenced point when a phrase repeats',()=>{
 const text='1.1. Одинаковая формулировка.\n2.4. Одинаковая формулировка.\n2.5. Важное уточнение.';
 assert.deepEqual(quoteContext(text,'Одинаковая формулировка.','2.4'),{before:'1.1. Одинаковая формулировка.',selected:'2.4. Одинаковая формулировка.',after:'2.5. Важное уточнение.'});
});

test('Finding titles do not assign a demo risk solely because a point number repeats',async()=>{
 const {findingTitle}=await import('../shared/review.mjs');
 const catalog={factors:[{id:'F09',title:'Нормативные коллизии'}]};
 assert.equal(findingTitle({point:'2.4',factorId:'F09',quote:'Иная цитата из другого документа'},catalog),'Нормативные коллизии');
});
