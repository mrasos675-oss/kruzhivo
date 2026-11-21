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
