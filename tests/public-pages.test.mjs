import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {landingPage,registrationPage} from '../public/landing.js';
import {profilePage,expertOverview} from '../public/profile.js';
import {samplesPage,SAMPLE_DOCUMENTS} from '../public/samples.js';

test('Public page explains all four sections without fabricated platform totals; profile and samples escape text',()=>{
 const page=landingPage('<script>');for(const t of ['Экспертная поддержка','Современные технологии','Повышение эффективности','Лучшие практики','Воспользоваться','Зарегистрироваться'])assert.ok(page.includes(t));assert.ok(!page.includes('<script>'));assert.ok(!page.includes('0 000'));assert.ok(!page.includes('100%'));assert.ok(page.includes('minjust.gov.ru/ru/activity/govservices/12/'));
 assert.match(registrationPage(),/autocomplete="new-password"/);assert.match(profilePage({fullName:'<script>'},{role:'expert'}),/&lt;script&gt;/);assert.doesNotMatch(expertOverview([{isDemo:true,status:'confirmed'}]),/Учебных дел|Ваши реальные проверки/);assert.equal(SAMPLE_DOCUMENTS.length,4);assert.match(samplesPage(),/permit.docx/);
});

test('Legal base routes all three sections through the shared catalog and keeps run snapshots separate',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),render=source.slice(source.indexOf('function sourcesPage('),source.indexOf('\nfunction ',source.indexOf('function sourcesPage(')+1));
 const calls=[],context={state:{account:{role:'expert'},db:{sources:[],catalog:{}},methodology:{materials:{files:[]}}},locate:()=>null,shell:s=>s,legalBaseContent:options=>{calls.push(options);return 'Каталог';}};
 vm.createContext(context);vm.runInContext(render,context);
 for(const section of ['legal','samples','materials'])assert.equal(vm.runInContext("sourcesPage(undefined,'"+section+"')",context),'Каталог');
 assert.deepEqual(calls.map(x=>x.section),['legal','samples','materials']);assert.ok(calls.every(x=>x.role==='expert'&&x.sources===context.state.db.sources));
 assert.match(source,/installLegalLibrary\(\)/);
});
