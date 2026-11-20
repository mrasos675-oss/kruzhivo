import test from 'node:test';
import assert from 'node:assert/strict';
import { reportFilename, reportDisposition } from '../server/report-filename.mjs';
const v={number:2},r={number:3,createdAt:'2026-11-19T22:00:00Z'};
test('Report names preserve Cyrillic, distinguish documents, and use stable Moscow run date',()=>{
 const d={id:'one',name:'Порядок выдачи'};
 const name=reportFilename(d,v,r,'pdf');
 assert.match(name,/^Отчёт_Порядок выдачи_.*_v2_проверка3_2026-11-20.pdf$/);
 assert.notEqual(name,reportFilename({...d,id:'two'},v,r,'pdf'));
 const disposition=reportDisposition(d,v,r,'docx');
 assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]),name.replace(/pdf$/,'docx'));
 assert.ok(/^[\x20-\x7e]+$/.test(disposition));
});
test('Report names remove unsafe characters and bound UTF-8 filename size',()=>{
 const name=reportFilename({id:'two',name:'<>:"/\\|?*\r\n'+ 'Я'.repeat(500)},v,r,'docx');
 assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(name));
 assert.ok(Buffer.byteLength(name)<255);
 assert.match(reportFilename({id:'three',name:''},v,{...r,createdAt:null},'pdf'),/Отчёт_three/);
});
