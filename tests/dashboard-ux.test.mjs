import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectPeriod,demoActivity,officialDashboard,expertDashboard} from '../public/dashboard.js';
import {loginPage} from '../public/login.js';
import {landingPage} from '../public/landing.js';
import {demoProfileFor} from '../server/profile.mjs';
import {seed} from '../server/store.mjs';
import {reportDocx,unzipEntry,extractDocx} from '../server/files.mjs';

test('Official counters distinguish AI runs from pending expert cases within the selected period',()=>{
 const at='2026-11-20T12:00:00Z',old='2025-01-01T12:00:00Z';
 const db={documents:[{id:'d',name:'Проверка показателей',createdAt:at,versions:[],runs:[{id:'r1',mode:'api',status:'running',createdAt:at,findings:[]},{id:'r2',mode:'api',status:'completed',createdAt:at,findings:[]},{id:'r3',mode:'api',status:'failed',createdAt:at,findings:[]}]}]};
 const cases=[{role:'official',status:'waiting',createdAt:at},{role:'official',status:'reviewing',createdAt:at},{role:'official',status:'confirmed',createdAt:at},{role:'official',status:'waiting',createdAt:old},{role:'expert',status:'waiting',createdAt:at},{role:'official',status:'waiting',isDemo:true,createdAt:at}];
 const html=officialDashboard(db,cases,{period:'custom',from:'2026-11-20',to:'2026-11-20'});
 assert.match(html,/ИИ: в работе \/ готово<\/p><strong>1 \/ 1<\/strong>/);
 assert.match(html,/Передано эксперту<\/p><strong>2<\/strong>/);
 assert.match(html,/Подтверждено экспертом<\/p><strong>1<\/strong>/);
});

test('Dashboard period filtering includes full dates, rejects reversed range, and separates illustrative from real data',()=>{
 const now=Date.parse('2026-11-16T12:00:00Z'),activity=demoActivity(now);assert.equal(selectPeriod(activity,{period:'month'},now).length,8);assert.equal(selectPeriod(activity,{period:'quarter'},now).length,23);assert.equal(selectPeriod(activity,{},now).length,24);
 assert.equal(selectPeriod([{createdAt:'2026-11-10T12:00:00'}],{period:'custom',from:'2026-11-10',to:'2026-11-10'},now).length,1);assert.equal(selectPeriod(activity,{period:'custom',from:'2026-11-16',to:'2026-11-01'},now).length,0);
 const db=seed(),before=JSON.stringify(db);const real=officialDashboard(db,[],{mode:'real'});for(const text of ['Проверить новый документ','В правовой базе нет проверенных источников','У вас пока нет проверок','Требуют внимания','Последние проверки','Проценты показывают ход работы','Учебные документы','Попробовать на эталонном регламенте'])assert.ok(!real.includes(text));assert.match(real,/id="dashboard-filter-form"/);assert.ok(!real.includes('Завершённые проверки'));assert.match(real,/Запуски проверок НПА/);assert.match(real,/>Загружено документов<\/p><strong>0</);assert.ok(!real.includes('Демонстрационные показатели'));
 const demo=officialDashboard(db,[],{mode:'demo'});assert.match(demo,/Демонстрационные показатели/);assert.match(demo,/>Загружено документов<\/p><strong>24</);assert.doesNotMatch(real + demo,/Рассмотренные замечания|gauge-card/);assert.match(demo,/Запуски проверок НПА/);assert.equal(JSON.stringify(db),before);
 assert.match(expertDashboard([],{mode:'real'}),/aria-label="[^"]*: 0 заключений/);
});

test('Landing introduces the service and a separate login has one form; demo identities cannot grant roles',()=>{
 const page=landingPage();assert.equal((page.match(/id="login-form"/g)||[]).length,0);assert.equal((loginPage().match(/id="login-form"/g)||[]).length,1);assert.ok(!loginPage().includes('loginRole'));assert.ok(!loginPage().includes('type="radio"'));for(const field of ['username','password'])assert.ok(loginPage().includes('name="'+field+'"'));assert.match(page,/entry-intro/);assert.match(page,/portal-illustration.svg/);
 assert.equal(demoProfileFor({id:'demo-official-v1',role:'official'}).fullName,'Иванов Иван Иванович');assert.equal(demoProfileFor({id:'real-user',role:'official'}),null);assert.equal(demoProfileFor({id:'demo-expert-v1',role:'expert'}).role,undefined);
});

test('Word report contains styles, readable summary, exact quotes, decisions and source limitations',()=>{
 const doc=seed().documents[0],r=doc.runs[0],bytes=reportDocx(doc,doc.versions[0],r),text=extractDocx(bytes),xml=unzipEntry(bytes,'word/document.xml').toString(),styles=unzipEntry(bytes,'word/styles.xml').toString();
 assert.match(xml,/<w:tbl>/);assert.match(xml,/w:pStyle w:val="Title"/);assert.match(xml,/w:pStyle w:val="Heading1"/);assert.match(styles,/w:styleId="Quote"/);assert.match(styles,/w:line="288"/);assert.match(text,/ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ/);assert.match(text,/Правовое основание специалистом не заполнено/);for(const f of r.findings)assert.ok(text.includes(f.quote));
 assert.match(unzipEntry(bytes,'word/footer1.xml').toString(),/w:instr="PAGE"/);
});

test('Review navigation has explicit return routes and writing fields expand without internal scrolling',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');assert.match(app,/Назад к списку замечаний/);assert.match(app,/Назад к проверке/);assert.ok(!app.includes('Рабочее пространство /'));assert.match(app,/area.scrollHeight/);assert.match(css,/textarea\{resize:none;overflow-y:hidden/);assert.match(app,/source-samples/);assert.match(app,/Пример для ИИ/);
});


test('Expert statistics count own conclusions by confirmation date and preserve earlier conclusions while revising',()=>{
 const options={period:'custom',from:'2026-11-20',to:'2026-11-21'};
 const cases=[
  {role:'expert',createdAt:'2025-01-01',confirmedAt:'2026-11-20T12:00:00Z',status:'confirmed'},
  {role:'expert',createdAt:'2025-01-01',confirmedAt:'2026-11-21T12:00:00Z',status:'reviewing'},
  {role:'expert',createdAt:'2026-11-20',confirmedAt:'2025-01-01',status:'confirmed'},
  {role:'official',createdAt:'2026-11-20',confirmedAt:'2026-11-20',status:'confirmed'},
  {role:'expert',isDemo:true,createdAt:'2026-11-20',confirmedAt:'2026-11-20',status:'confirmed'},
  {role:'expert',createdAt:'2026-11-20',status:'waiting'}
 ];
 const html=expertDashboard(cases,options);
 assert.match(html,/id="my-conclusions-title">Мои заключения/);
 assert.match(html,/<strong>2<\/strong><span>заключений/);
 assert.match(html,/<div class="dashboard-charts"><section class="card activity-card"><h2>Мои заключения по неделям<\/h2>[\s\S]*?<\/section><section class="card activity-card"><h2>Запросы экспертизы<\/h2>/);
 assert.equal((html.match(/Мои заключения по неделям/g)||[]).length,1);
 assert.doesNotMatch(html,/<h2>Дела с готовым заключением<\/h2>/);
 assert.match(html,/Дел с готовым заключением<\/p><strong>1<\/strong>/);
 assert.match(html,/Количество подготовленных заключений, шт./);
 assert.match(html,/Запросов экспертизы<\/p><strong>2<\/strong>/);
 assert.match(html,/role="img" aria-label="[^"]*заключений/);
});

test('Expert statistics have a separate route after My cases in navigation',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/\['expert-done','Мои дела'\],\['expert-statistics','Моя статистика'\],\['methodology'/);
 assert.match(app,/page==='expert-statistics'&&state.account.role==='expert'/);
 const {pathFor,tokenFor}=await import('../public/portal-router.js');
 assert.equal(pathFor('expert-statistics'),'/expert/statistics');
 assert.equal(tokenFor('/expert/statistics'),'expert-statistics');
});
