import test from 'node:test';
import assert from 'node:assert/strict';
import { inferNpa, regions } from '../public/npa-intake.js';
import { extractDocx, zipFiles } from '../server/files.mjs';

test('Extracts the full multiline title and municipal details from a DOCX', () => {
 const lines=['АДМИНИСТРАЦИЯ','ВОЛОВСКОГО МУНИЦИПАЛЬНОГО ОКРУГА','ТУЛЬСКОЙ ОБЛАСТИ','П О С Т А Н О В Л Е Н И Е','Об утверждении стандарта','внутреннего муниципального финансового контроля','1. Утвердить стандарт','Приложение'];
 const xml='<w:document><w:body>'+lines.map(text=>'<w:p><w:r><w:t>'+text+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>';
 const text=extractDocx(zipFiles({'word/document.xml':xml}));
 assert.deepEqual(text.split('\n'),lines);
 assert.deepEqual(inferNpa(text),{title:'Об утверждении стандарта внутреннего муниципального финансового контроля',kind:'Постановление',level:'Муниципальный',region:'Тульская область',municipality:'Воловский муниципальный округ'});
 assert.equal(new Set(regions).size,89);
});

test('Leaves unknown metadata blank', () => {
 assert.deepEqual(inferNpa('АДМИНИСТРАЦИЯ\n1. Текст документа'),{title:'',kind:'',level:'',region:'',municipality:''});
});
