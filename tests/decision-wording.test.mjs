import test from 'node:test';
import assert from 'node:assert/strict';
import {withExpertDecision,readExpertDecisions} from '../public/expert-editor.js';
test('Conclusion decisions use agreed wording and retain comments when edited',()=>{
 let text=withExpertDecision('Заключение',1,'confirmed','');
 text=withExpertDecision(text,2,'modified','Уточнить срок.');
 text=withExpertDecision(text,3,'rejected','Исправление не требуется.');
 assert.match(text,/Замечание 1 — Предложенное исправление подтверждено/);
 assert.match(text,/Замечание 2 — Подтверждено с комментарием\nУточнить срок\./);
 assert.match(text,/Замечание 3 — Отклонено с комментарием\nИсправление не требуется\./);
 assert.equal(readExpertDecisions(text).size,3);
 assert.equal(readExpertDecisions('Замечание 1 — Подтверждено\n').get(1).status,'confirmed');
 assert.match(withExpertDecision(text,1,'confirmed','Проверено.'),/Подтверждено с комментарием\nПроверено\./);
});
