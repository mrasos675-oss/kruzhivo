import vm from 'node:vm';
import {expertShowcase} from '../public/expert-showcase.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathFor} from '../public/portal-router.js';
import {expertDashboard} from '../public/dashboard.js';
import { documentKinds } from '../public/document-kinds.js';
import { moscowTime } from '../shared/report-format.mjs';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('Saved decisions and expert transfers render in the document journal with Moscow timestamps',()=>{
 const d={runs:[{id:'r',findings:[{id:'f'}]}],actionLog:[{createdAt:'2026-11-20T12:00:00Z',author:'Специалист',action:'confirmed',runId:'r',findingId:'f'}]};
 const context={state:{expertCases:[{id:'case',runId:'r',createdAt:'2026-11-20T12:05:00Z',requestedBy:'Специалист'}]},date:moscowTime,esc:String,A:(href,title)=>`<a href="${href}">${title}</a>`,d};
 vm.createContext(context);vm.runInContext(extract('function documentActionLog','function historyPage'),context);
 const html=vm.runInContext('documentActionLog(d)',context);
 assert.match(html,/Подтвердил замечание/);assert.match(html,/Передал документ эксперту/);assert.match(html,/15:00:00/);assert.match(html,/15:05:00/);
 assert.match(html,/#run\/r\/0/);assert.match(html,/#expert-case\/case/);assert.equal((html.match(/МСК/g)||[]).length,2);
});
test('Findings awaiting action are yellow while successful analysis and confirmed conclusions are complete',()=>{
 const context={state:{expertCases:[]},esc:String,labels:{},r:{id:'r',status:'completed',findings:[{}]}};
 vm.createContext(context);vm.runInContext(extract('function documentRunStatus','function runErrorText'),context);
 assert.match(vm.runInContext('documentRunStatus(r)',context),/class="status pending"/);
 context.r.findings=[];assert.match(vm.runInContext('documentRunStatus(r)',context),/class="status completed"/);
 context.r.findings=[{}];context.state.expertCases=[{runId:'r',status:'confirmed'}];assert.match(vm.runInContext('documentRunStatus(r)',context),/class="status completed"/);
});
test('New-check form and text entry select New check rather than My checks',()=>{
 const context={documentKinds,state:{upload:null,db:{documents:[],config:{configured:true}}},head:()=>'',stepper:()=>'',notice:()=>'',field:()=>'',esc:String,B:()=>'',A:()=>'',shell:(html,active)=>({html,active})};
 vm.createContext(context);vm.runInContext(extract('function npaFields','function npaCard')+extract('function uploadPage','function preparePage'),context);
 for(const paste of [false,true]){context.paste=paste;const page=vm.runInContext('uploadPage(paste)',context);assert.equal(page.active,'upload');assert.match(page.html,/id="upload-form"/);for(const removed of ['load-sample','эталонный','API','подготовленный сценарий'])assert.ok(!page.html.includes(removed));assert.match(page.html,/upload-panel/);assert.match(page.html,/Продолжить/);}
});
test('Primary navigation includes legal base without extra sections; profiles remain accessible through avatars',()=>{
 const state={account:{role:'official'},db:{profile:{fullName:'Иван Иванов'},config:{hosted:true}}};
 const context={state,esc:String,B:(action,label)=>'<button data-action="'+action+'">'+label+'</button>',A:(href,label)=>'<a href="'+href+'">'+label+'</a>',accessButton:()=>''};
 vm.createContext(context);vm.runInContext(extract('function shell(','function workflowProgress'),context);
 for(const role of ['official','expert']){
  state.account.role=role;const page=vm.runInContext("shell('', 'sources')",context);
  assert.ok(!page.includes('Другие разделы'));assert.ok(!page.includes('sidebar-more'));
  const nav=page.match(/<nav class="nav" aria-label="Основная навигация">([\s\S]*?)<\/nav>/)[1];
  assert.match(nav,/href="#sources" class="active"/);assert.ok(!nav.includes('#profile'));
  assert.match(page,/href="#profile" class="sidebar-person"/);assert.match(page,/class="mobile-profile" href="#profile"/);
  assert.ok(!page.includes('undefined'));assert.ok(!page.includes('Учебные документы'));
  const topbar=page.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  for(const text of ['header-search-form','События','Иван Иванов','Выйти','Для слабовидящих'])assert.ok(!topbar.includes(text));
  assert.match(page,/<div class="sidebar-footer"><button data-action="logout">Выйти<\/button><\/div><\/aside>/);
  const mobile=page.match(/<nav id="mobile-nav"[\s\S]*?<\/nav>/)[0];assert.match(mobile,/href="#sources"/);assert.ok(!mobile.includes('#profile'));
 }
 state.account.role='official';const checks=vm.runInContext("shell('', 'history')",context),sidebar=checks.match(/<aside class="sidebar"[^>]*>([\s\S]*?)<\/aside>/)[1];
 assert.ok(!sidebar.includes('href="#history"'));assert.ok(!sidebar.includes('href="#experts"'));assert.match(checks,/<nav class="actions queue-tabs" aria-label="Мои проверки">/);assert.match(sidebar,/href="#documents" class="active"/);
 state.account.role='admin';assert.ok(!vm.runInContext("shell('','methodology')",context).includes('href="#sources"'));
});
test('History cards remain in document flow rather than using the sticky decision toolbar',()=>{
 const context={state:{db:{documents:[{id:'doc',name:'Документ',versions:[{id:'v',number:1,createdAt:'date',fileName:'text'}],runs:[]}]}},head:()=>'<h1>История</h1>',notice:()=>'',shell:x=>x,esc:String,date:String,A:()=>'',B:()=>'',sourceDownload:()=>''};
 context.field=()=>'';vm.createContext(context);vm.runInContext(extract('function actionHelp','function sourceDownload')+extract('function documentRunStatus','function reportPage'),context);const html=vm.runInContext("historyPage('doc')",context);
 assert.match(html,/<h1>История<\/h1>.*class="history-list"/s);assert.match(html,/class="card history-item"/);assert.ok(!html.includes('review-actions'));assert.match(html,/class="actions history-return"/);
});

test('Own-document submission stays API-only and an unavailable connection never falls back to prepared answers',()=>{
 const d={id:'own',name:'Собственный документ',sample:false,versions:[{id:'v1',number:1,text:'1. Текст документа.'}],runs:[]};
 const context={state:{db:{documents:[d],config:{configured:false},profile:{}},runChoices:{docId:'another',versionId:'another',mode:'demo'}},head:()=>'',stepper:()=>'',parseDocumentStructure:()=>[{number:'1',text:'Текст документа.'}],esc:String,A:()=>'',B:()=>'',shell:(html)=>html};
 vm.createContext(context);vm.runInContext(extract('function preparePage','function relatedBlock')+extract('function runConfirmation','function modeCaption'),context);
 const prepare=vm.runInContext("preparePage('own','v1')",context);assert.match(prepare,/name="mode" value="api"/);assert.ok(!prepare.includes('value="demo"'));assert.ok(!prepare.includes('Учебный'));assert.match(prepare,/type="submit" class="btn primary" disabled/);
 let confirmation=vm.runInContext("runConfirmation('own','v1')",context);assert.match(confirmation,/name="mode" value="api"/);assert.match(confirmation,/проверка №1/);assert.match(confirmation,/type="submit" class="btn primary" disabled/);
 context.state.db.config.configured=true;confirmation=vm.runInContext("runConfirmation('own','v1')",context);assert.ok(!confirmation.includes('type="submit" class="btn primary" disabled'));assert.match(confirmation,/Начать проверку/);
});

test('My checks lists own records without sample panels, preserves names, and distinguishes no records from no search matches',()=>{
 const context={state:{search:'',db:{documents:[{id:'own',name:'Тест собственного текста <script>',sample:false,createdAt:'2026-11-16T12:00:00Z',versions:[{id:'v1'}],runs:[]},{id:'sample',name:'Hidden educational record',sample:true,versions:[{id:'sv'}],runs:[]}]}},currentRun:d=>d.runs.at(-1),labels:{},esc:value=>String(value??'').replace(/</g,'&lt;'),head:title=>'<h1>'+title+'</h1>',A:(href,label)=>'<a href="'+href+'">'+label+'</a>',B:(_action,label)=>'<button>'+label+'</button>',shell:html=>html};
 vm.createContext(context);context.field=()=>'';context.sourceDownload=()=>'';context.isArchived=()=>false;context.factorCount=n=>String(n);vm.runInContext(extract('function actionHelp','function sourceDownload')+extract('function documentRunStatus','function reportPage')+extract('function dashboard()','function uploadPage'),context);let html=vm.runInContext('dashboard()',context);
 assert.match(html,/Тест собственного текста &lt;script>/);assert.ok(!html.includes('Hidden educational record'));assert.ok(!html.includes('sample-documents'));assert.ok(!html.includes('Учебные документы'));assert.ok(!html.includes('data-action="new"'));assert.match(html,/history-document-details/);assert.match(html,/Не запущена/);assert.match(html,/#prepare\/own\/v1/);
 context.state.search='does-not-match';html=vm.runInContext('dashboard()',context);assert.match(html,/Ничего не найдено/);assert.ok(!html.includes('Проверок пока нет'));
 context.state.db.documents=[];context.state.search='';html=vm.runInContext('dashboard()',context);assert.match(html,/Проверок пока нет/);assert.ok(!html.includes('id="document-search"'));
});

test('History groups by document identity, preserves all version and run links and excludes the sample library from the global list',()=>{
 const doc={id:'one',name:'Одинаковое название',sample:false,versions:[{id:'v1',number:1,createdAt:'2026-11-15T10:00:00Z'},{id:'v2',number:2,createdAt:'2026-11-16T10:00:00Z'}],runs:[{id:'old',versionId:'v1',number:1,status:'completed',createdAt:'2026-11-15T11:00:00Z',findings:[{}]},{id:'latest',versionId:'v2',number:1,status:'completed',createdAt:'2026-11-16T11:00:00Z',findings:[]}]};
 const documents=[doc,{...doc,id:'two',versions:[{id:'second-v1',number:1,createdAt:'2026-11-17T10:00:00Z'}],runs:[]},{...doc,id:'sample',name:'Sample-only-name',sample:true}],before=JSON.stringify(documents),links=[];
 const context={state:{db:{documents}},head:()=>'<h1>История проверок</h1>',shell:x=>x,esc:String,labels:{},factorCount:n=>n+' факторов',isArchived:(_d,r)=>r.id==='old',B:(_action,label)=>'<button>'+label+'</button>',A:(href,label)=>{links.push(href);return '<a href="'+href+'">'+label+'</a>';},sourceDownload:(d,v)=>'<a href="/download/'+d.id+'/'+v.id+'">Скачать</a>'};
 context.field=()=>'';vm.createContext(context);vm.runInContext(extract('function actionHelp','function sourceDownload')+extract('function documentRunStatus','function reportPage'),context);let html=vm.runInContext('historyPage()',context);
 assert.equal((html.match(/class="card history-item"/g)||[]).length,2);assert.ok(!html.includes('Sample-only-name'));for(const href of ['#results/latest','/api/runs/latest/report.docx','#rerun/one/v2','#prepare/two/second-v1'])assert.ok(links.includes(href));assert.ok(html.includes('/download/one/v2'));assert.ok(html.indexOf('history-action-panel')<html.indexOf('history-document-details'));assert.match(html,/Новый анализ выбранной сохранённой версии/);assert.match(html,/после замечаний коллег/);assert.match(html,/<span class="action-help" hidden>/);assert.ok(!html.includes('aria-label="Пояснение к действию"'));context.state.historySelection={one:{versionId:'v1',runId:'old'}};html=vm.runInContext('historyPage()',context);assert.match(html,/#results\/old/);assert.match(html,/\/api\/runs\/old\/report.docx/);assert.match(html,/#rerun\/one\/v1/);assert.ok(html.includes('/download/one/v1'));assert.equal(JSON.stringify(documents),before);assert.ok(html.includes('Архив'));assert.ok(!html.includes('Каждый запуск хранится отдельно'));assert.equal(JSON.stringify(documents),before);
 html=vm.runInContext("historyPage('one')",context);assert.equal((html.match(/class="card history-item"/g)||[]).length,1);assert.match(html,/class="history-document-details" open/);
 context.state.db.documents=[];html=vm.runInContext('historyPage()',context);assert.match(html,/Проверок пока нет/);
});

test('Signed-in users can open the landing and its sections from both cabinet logos without losing their account',()=>{
 let token='home';const output={innerHTML:''};const state={account:{role:'official'},db:null};
 const context={state,currentToken:()=>token,pathFor,$:()=>output,paintApp:html=>{output.innerHTML=html;},landingPage:()=>'<main>Landing</main>'};
 vm.createContext(context);vm.runInContext(extract('const route=','const date =')+extract('function expertHome()','function aiConnectionCard()'),context);
 for(const role of ['official','expert']){state.account.role=role;const account=state.account;for(const next of ['home','about','features','support','become-expert','contacts']){token=next;vm.runInContext('render()',context);assert.match(output.innerHTML,/Landing/);assert.equal(state.account,account);}token='login';assert.equal(vm.runInContext('route()[0]',context),role==='expert'?'experts':'overview');}
 context.esc=String;context.navForUser=()=>[];context.B=()=>'';context.A=()=>'';context.accessButton=()=>'';state.db={profile:{fullName:'Имя'},config:{hosted:true}};
 vm.runInContext(extract('function shell(','function workflowProgress'),context);
 for(const role of ['official','expert']){state.account.role=role;const html=vm.runInContext("shell('')",context);assert.equal((html.match(/href="#home" class="brand"/g)||[]).length,2);if(role==='expert'){assert.match(html,/href="#experts"[^>]*>Кабинет эксперта/);assert.match(html,/<span class="nav-label">Главная<\/span>/);assert.doesNotMatch(html,/Очередь/);}}
});

test('Expert home lists accessible unfinished cases and conclusions retain completed cases',()=>{
 let token='experts';const output={innerHTML:''},cases=[{id:'demo',name:'Учебное дело',isDemo:true,status:'reviewing'},{id:'real',role:'expert',name:'Реальное дело',isDemo:false,status:'waiting',createdAt:new Date().toISOString()},{id:'work',role:'expert',name:'Дело в работе',status:'reviewing'},{id:'done',name:'Готовое дело',status:'confirmed'}];
 const context={expertShowcase,state:{account:{role:'expert'},db:{profile:{fullName:'Эксперт'}},expertCases:cases},currentToken:()=>token,pathFor,route:()=>[token],$:()=>output,paintApp:html=>{output.innerHTML=html;},head:()=>'<h1>Кабинет эксперта</h1>',profileSummary:()=>'<section>Профиль</section>',expertOverview:expertDashboard,viewOptions:()=>({}),shell:(html)=>html,fitFields:()=>{},B:(_action,label)=>label,A:(_href,label)=>label,expertList:rows=>'<section>Expert list '+rows.map(c=>c.name).join(' ')+'</section>'};
 vm.createContext(context);vm.runInContext(extract('function expertHome()','function aiConnectionCard()'),context);
 for(const page of ['experts','overview','upload']){token=page;vm.runInContext('render()',context);assert.doesNotMatch(output.innerHTML,/Профиль/);assert.match(output.innerHTML,/Реальное дело/);assert.match(output.innerHTML,/Дело в работе/);assert.doesNotMatch(output.innerHTML,/Учебное дело|Готовое дело|Как начать работу|Запросов экспертизы/);}
 token='expert-done';vm.runInContext('render()',context);
 assert.match(output.innerHTML,/Реальное дело Дело в работе Готовое дело/);
 assert.match(output.innerHTML,/История проверок/);assert.doesNotMatch(output.innerHTML,/Учебное дело/);
 context.esc=String;context.accessButton=()=>'';context.state.db.config={hosted:true};context.state.demoLogin=true;
 vm.runInContext(extract('function shell(','function workflowProgress'),context);
 const menu=()=>vm.runInContext("shell('')",context);
 assert.match(menu(),/data-expert-queue-dot\s*>/);
 assert.doesNotMatch(menu(),/Сменить роль/);
 cases[1].status='reviewing';
 assert.match(menu(),/data-expert-queue-dot hidden>/);
 context.state.account.role='official';token='experts';vm.runInContext('render()',context);assert.match(output.innerHTML,/Expert list/);
 assert.match(expertDashboard(cases,{mode:'demo'}),/Демонстрационные показатели/);
});
