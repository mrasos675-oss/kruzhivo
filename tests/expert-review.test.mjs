import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpertReview, expertDocx } from '../server/expert-review.mjs';
import { version, seed } from '../server/store.mjs';
import { unzipEntry } from '../server/files.mjs';
import { expertCase, overview, expertList } from '../public/cabinets.js';

function memory(){let db={expertCases:[]},q=Promise.resolve();return{read:async()=>structuredClone(db),change(fn){const job=q.then(()=>{const next=structuredClone(db),result=fn(next);db=next;return result;});q=job.catch(()=>{});return job;}};}
const run=()=>({id:'run-1',status:'completed',mode:'api',model:'test/model',findings:[],sources:[],coverage:[],limitations:['Нет нормативных источников.']});

test('Invitation authorizes a separate expert; owner and other visitors cannot sign or read another case',async()=>{
 const store=memory(),owner=createExpertReview(store,'owner'),expert=createExpertReview(store,'expert'),other=createExpertReview(store,'other');
 const v=version('1.1. Исходный текст.'),r=run(),invitation=await owner.create({name:'Тестовый проект'},v,r);
 assert.ok(!(await owner.get(invitation.id)).invitationHash);assert.equal((await other.list()).length,0);
 await assert.rejects(other.get(invitation.id),e=>e.status===403);await assert.rejects(owner.accept(invitation.id,invitation.token,{name:'X',registryNumber:'N'}),e=>e.status===409);
 await assert.rejects(expert.accept(invitation.id,'wrong',{name:'Эксперт',registryNumber:'N'}),e=>e.status===403);
 const rotated=await owner.invite(invitation.id);await assert.rejects(expert.accept(invitation.id,invitation.token,{name:'Эксперт',registryNumber:'N'}),e=>e.status===403);
 await expert.accept(invitation.id,rotated.token,{name:'Эксперт',registryNumber:'Заявленные реквизиты N'});
 await assert.rejects(other.accept(invitation.id,rotated.token,{name:'Другой',registryNumber:'N'}),e=>e.status===403);
 await assert.rejects(owner.save(invitation.id,'Текст',0),e=>e.status===403);await assert.rejects(owner.sign(invitation.id,0),e=>e.status===403);
 assert.equal((await expert.list())[0].role,'expert');assert.equal((await owner.list())[0].role,'official');
 await owner.message(invitation.id,'Посмотрите связанный пункт.');await expert.message(invitation.id,'Уточнение учтено.');
 assert.equal((await owner.get(invitation.id)).messages.length,2);
 v.text='Изменённый оригинал';r.limitations.push('Новая запись');const snapshot=await expert.get(invitation.id);assert.equal(snapshot.document.text,'1.1. Исходный текст.');assert.equal(snapshot.run.limitations.length,1);
});

test('Confirmation freezes an exact conclusion and document version, rejects stale revisions and preserves previous versions',async()=>{
 const store=memory(),owner=createExpertReview(store,'owner'),expert=createExpertReview(store,'expert'),v=version('Исходный документ');
 const {id,token}=await owner.create({name:'Проект'},v,run());await expert.accept(id,token,{name:'Иванов <script>',registryNumber:'123'});
 await assert.rejects(expert.sign(id,0),e=>e.status===400);await expert.save(id,'Первое заключение',0);
 await assert.rejects(expert.sign(id,0),e=>e.status===409);await expert.sign(id,1);
 const c=await owner.get(id),signed=c.conclusions[0];assert.equal(signed.status,'confirmed');assert.equal(signed.confirmation.documentHash,v.hash);assert.ok(signed.confirmedAt);assert.match(signed.confirmation.textHash,/^[a-f0-9]{64}$/);
 await assert.rejects(expert.save(id,'Перезапись',2),e=>e.status===409);await assert.rejects(expert.sign(id,2),e=>e.status===409);
 await expert.newDraft(id);await expert.save(id,'Второе заключение',0);await expert.sign(id,1);
 const after=await expert.get(id);assert.deepEqual(after.conclusions[0],signed);assert.equal(after.conclusions[1].number,2);
 const xml=unzipEntry(expertDocx(after,1),'word/document.xml').toString();assert.match(xml,/Первое заключение/);assert.ok(!xml.includes('Второе заключение'));assert.match(xml,/квалифицированной электронной подписи/);assert.ok(!xml.includes('<script>'));
 assert.ok(!expertCase(after).includes('<script>'));
});

test('Dashboard excludes seeded educational records and counts expert-confirmed conclusions separately',()=>{
 const db=seed(),html=overview(db,[]);assert.match(html,/>Загружено документов<\/p><strong>0</);assert.match(html,/>Подтверждено экспертом<\/p><strong>0</);
 const withConclusion=overview(db,[{id:'confirmed-case',role:'official',status:'confirmed',isDemo:false,createdAt:'2026-11-17T12:00:00Z'}]);assert.match(withConclusion,/>Подтверждено экспертом<\/p><strong>1</);assert.ok(!html.includes('У вас пока нет проверок'));
});

test('Expert case list has compact facts and actions without demo notices; records and role-specific detail routes remain intact',()=>{
 const cases=[{id:'old',name:'Документ <script>',createdAt:'2026-11-15T10:00:00Z',status:'reviewing',expertName:'Тестовый эксперт',isDemo:true,role:'official',version:1,messages:0},{id:'new',name:'Новый документ',createdAt:'2026-11-17T10:00:00Z',status:'confirmed',expertName:'Петров Алексей Сергеевич',isDemo:false,role:'official',version:2,messages:3}],before=JSON.stringify(cases);
 const html=expertList(cases);assert.ok(!html.includes('<script>'));assert.match(html,/Документ &lt;script&gt;/);assert.match(html,/#expert-case\/old/);assert.match(html,/#expert-case\/new/);assert.ok(html.indexOf('Новый документ')<html.indexOf('Документ &lt;script&gt;'));for(const text of ['Демонстрация экспертного модуля','Скрыть пустые дубликаты','Учебный документ','Вы — автор','сообщений:','Тестовый эксперт'])assert.ok(!html.includes(text));assert.match(html,/Эксперт назначен/);assert.match(html,/Петров Алексей Сергеевич/);assert.match(html,/Заключение готово/);assert.equal(JSON.stringify(cases),before);
 const filtered=expertList(cases,'reviewing');assert.match(filtered,/#expert-case\/old/);assert.ok(!filtered.includes('#expert-case/new'));assert.match(expertList(cases,'waiting'),/Нет дел с этим статусом/);assert.match(expertList([]),/Заключений пока нет/);
});

test('Expert workspace keeps a single findings list, tab panels, evidence and role-specific signing controls',()=>{
 const c={id:'case-ui',role:'expert',status:'reviewing',document:{name:'Документ <script>',number:1,text:'2.4. Цитата документа.'},expertProfile:{name:'Петров',registryNumber:'123'},messages:[],conclusions:[{number:1,status:'draft',revision:2,text:'Сохранённый черновик'}],run:{...run(),findings:[{factorId:'F01',point:'2.4',quote:'Цитата документа.',explanation:'Объяснение',review:{verdict:'supported',explanation:'Проверено',counterarguments:['Уточнение']},decision:{explanation:'Объяснение автора',proposal:'Редакция автора',comment:'Комментарий автора',basis:'Основание автора'},basis:[{quote:'Норма закона'}]}]}};
 const before=JSON.stringify(c),html=expertCase(c);
 assert.equal((html.match(/id="expert-finding-0"/g)||[]).length,1);
 assert.ok(!html.includes('Предварительный анализ ИИ ·'));
 for(const tab of ['review','conclusion','discussion']){assert.match(html,new RegExp('id="case-tab-'+tab+'" role="tab"'));assert.match(html,new RegExp('id="case-panel-'+tab+'" role="tabpanel"'));}
 assert.match(html,/data-case-panel="conclusion" tabindex="0" hidden/);
 assert.match(expertCase(c,{tab:'conclusion'}),/data-case-panel="conclusion" tabindex="0" >/);
 assert.match(html,/id="expert-draft-form"/);assert.match(html,/data-revision="2"/);
 for(const value of ['Редакция автора','Комментарий автора','Основание автора','Норма закона','Сохранённый черновик'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('<script>'));assert.equal(JSON.stringify(c),before);
 assert.ok(!expertCase({...c,role:'official'}).includes('id="expert-draft-form"'));
 const confirmed={...c,role:'official',conclusions:[{...c.conclusions[0],status:'confirmed',confirmedAt:'2026-11-17T12:00:00Z'}]};
 const next=expertCase(confirmed,{documentId:'doc-38'});
 assert.match(next,/data-action="version" data-doc="doc-38"/);
 assert.ok(!expertCase({...confirmed,role:'expert'},{documentId:'doc-38'}).includes('data-action="version"'));
 assert.ok(!expertCase({...c,role:'official'},{documentId:'doc-38'}).includes('data-action="version"'));
 assert.match(next,/Исходный текст и прежние заключения сохраняются/);

 assert.ok(!expertCase({...c,conclusions:[{...c.conclusions[0],status:'confirmed',confirmedAt:'2026-11-17T12:00:00Z'}]}).includes('id="expert-draft-form"'));
});


test('Transfer requires a saved explicit decision on every finding, including repeat requests',async()=>{
 const store=memory(),owner=createExpertReview(store,'owner'),v=version('Документ'),r=run();
 r.findings=[{decision:{status:'confirmed',revision:1}},{decision:{status:'pending',revision:0}}];
 for(let i=0;i<2;i++)await assert.rejects(owner.create({name:'Тест'},v,r),e=>e.status===409);
 assert.equal((await owner.list()).length,0);
 r.findings[1].decision={status:'rejected',revision:0};
 await assert.rejects(owner.create({name:'Тест'},v,r),e=>e.status===409);
 r.findings[1].decision.revision=1;
 const sent=await owner.create({name:'Тест'},v,r);
 const repeated=await owner.create({name:'Тест'},v,r);
 assert.equal(repeated.id,sent.id);assert.equal(repeated.existing,true);
 assert.equal((await owner.list()).length,1);
 r.findings[1].decision.status='pending';
 await assert.rejects(owner.create({name:'Тест'},v,r),e=>e.status===409);
});

test('Zero findings wait for explicit transfer and repeated transfer creates no duplicate',async()=>{
 const owner=createExpertReview(memory(),'owner'),r=run(),v=version('Без замечаний');
 assert.equal((await owner.list()).length,0);
 const sent=await owner.create({name:'Тест'},v,r);
 assert.equal((await owner.create({name:'Тест'},v,r)).id,sent.id);
 assert.equal((await owner.list()).length,1);
});


test('A new document version and analysis preserve the prior confirmed expert case',async()=>{
 const store=memory(),owner=createExpertReview(store,'owner'),expert=createExpertReview(store,'expert');
 const doc={id:'same-document',name:'Проект'},v1=version('Первая редакция',1),r1=run();
 const first=await owner.create(doc,v1,r1);await expert.accept(first.id,first.token,{name:'Эксперт',registryNumber:'123'});
 await expert.save(first.id,'Заключение по первой версии',0);await expert.sign(first.id,1);
 const before=await owner.get(first.id),v2=version('Исправленная редакция',2,'updated.docx'),r2={...run(),id:'run-2'};
 const second=await owner.create(doc,v2,r2),after=await owner.get(first.id),next=await owner.get(second.id);
 assert.deepEqual(after,before);assert.notEqual(first.id,second.id);assert.equal(next.document.number,2);assert.equal(next.document.text,v2.text);assert.equal(next.run.id,r2.id);assert.equal(after.document.hash,v1.hash);assert.equal(after.conclusions[0].confirmation.runId,r1.id);
});
