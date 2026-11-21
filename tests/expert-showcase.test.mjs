import test from 'node:test';
import assert from 'node:assert/strict';
import {expertShowcase} from '../public/expert-showcase.js';
import {createExpertReview} from '../server/expert-review.mjs';
import {version} from '../server/store.mjs';

test('Catalog excludes demo, archived, completed and non-expert cases; filters and escapes metadata',()=>{
 const base={id:'own',role:'expert',status:'waiting',name:'Порядок <субсидий>',level:'Региональный',territory:'Область <X>'};
 const cases=[base,...[{id:'foreign',role:'official'},{id:'demo',isDemo:true},{id:'archive',archivedAt:'2026-11-20'},{id:'done',status:'confirmed'},{id:'unknown',role:null}].map(c=>({...base,...c,name:c.id}))];
 const html=expertShowcase(cases);
 assert.match(html,/Порядок &lt;субсидий&gt;/);assert.match(html,/Область &lt;X&gt;/);assert.match(html,/Доступно документов: 1/);
 for(const id of ['foreign','demo','archive','done','unknown'])assert.ok(!html.includes('#expert-case/'+id));
 assert.match(expertShowcase(cases,{query:'ПОРЯДОК',level:'Региональный'}),/#expert-case\/own/);
 assert.doesNotMatch(expertShowcase(cases,{level:'Федеральный'}),/#expert-case\/own/);
 assert.match(expertShowcase([]),/Пока нет документов/);
 assert.match(expertShowcase([{...base,level:null,territory:null}]),/Не указан/);
});

test('Server list authorizes the assigned expert and carries document metadata in immutable snapshot',async()=>{
 let db={expertCases:[]};const store={read:async()=>structuredClone(db),change:async fn=>fn(db)};
 const owner=createExpertReview(store,'owner'),one=createExpertReview(store,'one'),two=createExpertReview(store,'two');
 const doc={name:'Регламент',kind:'Регламент',level:'Муниципальный',territory:'г. Волжский'};
 const run=id=>({id,status:'completed',mode:'api',findings:[],sources:[]});
 const own=await owner.create(doc,version('Текст'),run('a'),{expertId:'one'});
 await owner.create({...doc,name:'Чужое дело'},version('Текст'),run('b'),{expertId:'two'});
 await owner.create({...doc,name:'Без назначения'},version('Текст'),run('c'));
 doc.territory='Изменённый оригинал';
 const rows=await one.list();assert.equal(rows.length,1);assert.equal(rows[0].id,own.id);assert.equal(rows[0].level,'Муниципальный');assert.equal(rows[0].territory,'г. Волжский');
 await assert.rejects(two.get(own.id),e=>e.status===403);
 db.expertCases[0].archivedAt='2026-11-21';assert.deepEqual(await one.list(),[]);
});

test('Territory filters keep levels separate, escape values and narrow municipalities by region',()=>{
 const base={role:'expert',status:'waiting',name:'Документ'};
 const cases=[{...base,id:'r',level:'Региональный',territory:'Область А'},{...base,id:'m',level:'Муниципальный',territory:'Область А, Город <Б>'},{...base,id:'other',level:'Муниципальный',territory:'Область В, Город Г'},{...base,id:'legacy',level:'Муниципальный',territory:'Волжский'}];
 const regional=expertShowcase(cases,{level:'Региональный',region:'Область А'});
 assert.match(regional,/#expert-case\/r/);assert.doesNotMatch(regional,/#expert-case\/m/);assert.doesNotMatch(regional,/name="municipality"/);
 const municipal=expertShowcase(cases,{level:'Муниципальный',region:'Область А',municipality:'Город <Б>'});
 assert.match(municipal,/#expert-case\/m/);assert.doesNotMatch(municipal,/#expert-case\/(r|other|legacy)/);assert.match(municipal,/Город &lt;Б&gt;/);assert.doesNotMatch(municipal,/<option[^>]*>Город Г/);
 assert.match(expertShowcase(cases,{level:'Муниципальный',region:'__unknown__'}),/#expert-case\/legacy/);
 const federal=expertShowcase(cases,{level:'Федеральный',region:'Область А',municipality:'Город <Б>'});assert.doesNotMatch(federal,/name="region"|name="municipality"/);
 assert.doesNotMatch(expertShowcase(cases),/>Локальный</);assert.match(expertShowcase(cases),/expert-catalog-reset/);
});

test('Showcase offers pickup and links an already started case to my cases',()=>{
 const c={id:'pickup',role:'expert',status:'waiting',name:'НПА'};
 assert.match(expertShowcase([c]),/data-action="expert-start" data-case="pickup"/);
 assert.match(expertShowcase([c]),/>Взять в работу<\/button>/);
 const started=expertShowcase([{...c,status:'reviewing'}]);
 assert.match(started,/>В моих делах<\/a>/);
 assert.doesNotMatch(started,/data-action="expert-start"/);
});

test('Concurrent pickup and retries preserve one case and reject another expert or archived case',async()=>{
 const db={expertCases:[]};const store={read:async()=>structuredClone(db),change:async fn=>fn(db)};
 const owner=createExpertReview(store,'owner'),one=createExpertReview(store,'one'),two=createExpertReview(store,'two');
 const c=await owner.create({name:'НПА'},version('Текст'),{id:'pickup',status:'completed',mode:'api',findings:[],sources:[]},{expertId:'one',queued:true});
 const results=await Promise.allSettled([one.start(c.id),one.start(c.id),two.start(c.id)]);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','rejected']);
 assert.equal(results[2].reason.status,403);
 const started=db.expertCases[0].startedAt;
 await one.start(c.id);
 assert.equal(db.expertCases.length,1);assert.equal(db.expertCases[0].conclusions.length,1);
 assert.equal(db.expertCases[0].expertId,'one');assert.equal(db.expertCases[0].startedAt,started);
 assert.equal((await one.list())[0].status,'reviewing');assert.deepEqual(await two.list(),[]);
 db.expertCases[0].archivedAt='2026-11-21';
 await assert.rejects(one.start(c.id),e=>e.status===409);
 await assert.rejects(one.start('missing'),e=>e.status===404);
});
