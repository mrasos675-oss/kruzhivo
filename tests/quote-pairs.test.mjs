import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteRange,documentWithPairs} from '../public/quote-pairs.js';
import {expertReviewPanel} from '../public/expert-editor.js';

test('Repeated quotes resolve only within their exact numbered point',()=>{
 const text='1. Первый риск.\n2. Первый риск. Второй риск.\n3. Конец.';
 const range=quoteRange(text,{quote:'Первый риск.',point:'2'});
 assert.equal(range.start,text.lastIndexOf('Первый риск.'));
 assert.equal(quoteRange(text,{quote:'Первый риск.'}),null);
 assert.equal(quoteRange(text,{quote:'Нет такой цитаты',point:'2'}),null);
 assert.equal(quoteRange('1. Риск. Риск.',{quote:'Риск.',point:'1'}),null);
 assert.equal(quoteRange(text,{quote:'Конец.',point:'2'}),null);
});

test('Overlapping and identical quotes retain separate finding identities and original text',()=>{
 const text='1. Первый риск и второй риск.';
 const findings=[{quote:'Первый риск и второй риск.',point:'1'},{quote:'второй риск',point:'1'},{quote:'второй риск',point:'1'}];
 const html=documentWithPairs(text,findings);
 assert.match(html,/data-quote-pairs="0 1 2"/);
 assert.equal(html.replace(/<span[^>]*>[^<]*<\/span>/g,'').replace(/<[^>]+>/g,''),text);
 assert.ok(!documentWithPairs('Риск. Риск.',[{quote:'Риск.'}]).includes('<mark'));
});

for(const role of ['official','expert']) test(`${role}: cards expose exact reverse links and ambiguous quotes explain unavailable transition`,()=>{
 const panel=expertReviewPanel({role,document:{text:'1. Риск один и риск два.\n2. Повтор. Повтор.'},run:{findings:[{point:'1',quote:'Риск один'},{point:'1',quote:'риск два'},{point:'2',quote:'Повтор.'}]},conclusions:[{status:'draft',text:''}]});
 assert.equal((panel.match(/data-show-quote/g)||[]).length,2);
 assert.match(panel,/data-finding-pair="1"/);
 assert.match(panel,/data-quote-pairs="1"/);
 assert.match(panel,/Переход недоступен/);
});
