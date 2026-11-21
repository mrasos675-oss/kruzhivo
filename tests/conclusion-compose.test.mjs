import test from 'node:test';
import assert from 'node:assert/strict';
import {composeConclusion} from '../public/expert-editor.js';

test('Reforming replaces legacy duplicate outcomes and preserves expert decisions and own findings',()=>{
 const body='Черновик\n\nРАССМОТРЕНИЕ ЗАМЕЧАНИЙ\nЗамечание 1 — Подтверждено';
 const old=body+'\n\nВЫВОД ЭКСПЕРТА\nСтарый вывод\nРекомендации: старые\n\nСОБСТВЕННЫЕ ЗАМЕЧАНИЯ\nМоя оценка\n\nВЫВОД ЭКСПЕРТА\nДубликат';
 const text=composeConclusion(old,'Новый вывод','Новые рекомендации');
 assert.equal((text.match(/^ВЫВОД ЭКСПЕРТА$/gm)||[]).length,1);
 assert.ok(text.includes(body));assert.ok(text.includes('СОБСТВЕННЫЕ ЗАМЕЧАНИЯ\nМоя оценка'));
 assert.ok(!text.includes('Старый вывод'));assert.ok(!text.includes('Дубликат'));
 assert.equal(composeConclusion(text,'Новый вывод','Новые рекомендации'),text);
});

test('Header precedes ordered sections and is stable when reforming',()=>{
 const c={document:{name:'Тестовый НПА',number:3},requestedBy:'Автор',expertProfile:{name:'Эксперт'}};
 const text=composeConclusion('СОБСТВЕННЫЕ ЗАМЕЧАНИЯ\nОценка\n\nРАССМОТРЕНИЕ ЗАМЕЧАНИЙ\nЗамечание 1 — Подтверждено','Вывод','Совет',c);
 assert.ok(text.startsWith('НПА: Тестовый НПА\nВерсия НПА: 3\nАвтор-госслужащий: Автор\nЭксперт: Эксперт\n'));
 assert.ok(text.indexOf('РАССМОТРЕНИЕ')<text.indexOf('СОБСТВЕННЫЕ'));
 assert.ok(text.indexOf('СОБСТВЕННЫЕ')<text.indexOf('ВЫВОД ЭКСПЕРТА'));
 assert.equal(composeConclusion(text,'Вывод','Совет',c),text);
});
