import test from 'node:test';
import assert from 'node:assert/strict';
import {recentActions} from '../public/dashboard.js';
test('Recent actions use saved dates, exclude samples, escape names and link to results',()=>{
 const db={documents:[{id:'sample',sample:true,name:'Hidden',createdAt:'2026-11-20'}, {id:'doc',name:'<Документ>',createdAt:'2026-11-01',versions:[],runs:[{id:'run',createdAt:'2026-11-02',finishedAt:'2026-11-03',status:'completed',findings:[{decision:{savedAt:'2026-11-04'}}]}]}]};
 const html=recentActions(db);assert.ok(!html.includes('Hidden'));assert.ok(html.includes('&lt;Документ&gt;'));assert.ok(html.includes('href="#results/run"'));assert.ok(html.indexOf('Сохранено решение')<html.indexOf('Проверка завершена'));assert.equal((html.match(/<li>/g)||[]).length,2);assert.doesNotMatch(html,/Проверка запущена|Документ загружен/);
 assert.match(recentActions({documents:[]}),/Здесь появятся/);
});
