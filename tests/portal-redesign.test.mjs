import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathFor,tokenFor} from '../public/portal-router.js';
import {landingPage,registrationPage,infoPage} from '../public/landing.js';
import {loginPage} from '../public/login.js';
import {readExpertDecisions,withExpertDecision,highlightedDocument,expertReviewPanel,activateCaseTab} from '../public/expert-editor.js';
import {createApp} from '../server/index.mjs';
test('Landing separates login, labels pilot targets, escapes data and does not promise unsupported verification',()=>{const html=landingPage();assert.ok(!html.includes('id="login-form"'));assert.match(loginPage(),/id="login-form"/);for(const id of ['about','how','features','mission','support','technology','efficiency','practices','become-expert','contacts'])assert.ok(html.includes('id="'+id+'"'));assert.match(html,/Цели пилота 2027–2028/);assert.match(html,/pchelintsev.anton@vk.com/);assert.ok(!html.includes('0 000'));assert.match(html,/Приём PDF запланирован/);assert.match(html,/аккредитация проверяется вне системы/);assert.doesNotMatch(registrationPage('<script>','expert'),/<script>|<form/);assert.ok(!registrationPage().match(/name="consent"[^>]*checked/));assert.match(infoPage('restore'),/ещё не подключено/);});
test('Canonical routes roundtrip and legacy invitations and graph links remain valid',()=>{for(const token of ['home','login','register','restore','overview','documents','upload','paste','experts','profile','notifications','methodology','results/abc','run/abc/2','graph/abc','provision/abc/p2','expert-case/abc','expert-invite/abc/token','prepare/doc/version','rerun/doc/version','run-confirm/doc/version','history/doc','expert-done'])assert.equal(tokenFor(pathFor(token)),token);assert.equal(tokenFor('https://example.com/#graph/abc'),'graph/abc');assert.equal(tokenFor('https://example.com/#expert-invite/id/token'),'expert-invite/id/token');assert.equal(tokenFor('/unknown'),'not-found');});
test('Editing a finding preserves other expert decisions, own remarks and general conclusion in the existing text field',()=>{let text='Заключение эксперта\nВведение';text=withExpertDecision(text,2,'rejected','Пункт 2.6 уточняет срок.');text=withExpertDecision(text,1,'confirmed','Проверено основание.');text+='\n\nСОБСТВЕННЫЕ ЗАМЕЧАНИЯ\nЦитата: «текст»\n\nВЫВОД ЭКСПЕРТА\nОбщий вывод';text=withExpertDecision(text,2,'modified','Уточнить редакцию.');const records=readExpertDecisions(text);assert.equal(records.size,2);assert.equal(records.get(2).status,'modified');assert.equal(records.get(1).comment,'Проверено основание.');assert.match(text,/Введение/);assert.match(text,/СОБСТВЕННЫЕ ЗАМЕЧАНИЯ/);assert.match(text,/Общий вывод/);assert.ok(!text.includes('Пункт 2.6 уточняет срок.'));assert.throws(()=>withExpertDecision('',1,'unknown',''));});
test('Document highlights escape text, preserve overlapping sources and do not expose editor to officials',()=>{const html=highlightedDocument('abc <img src=x> def',[{quote:'abc <img src=x>'},{quote:'<img src=x>'},{quote:'absent'}]);assert.ok(!html.includes('<img'));assert.equal((html.match(/<mark /g)||[]).length,2);assert.match(html,/data-scroll-to="expert-finding-0"/);const c={role:'official',document:{text:'text'},run:{findings:[]},conclusions:[]};assert.ok(!expertReviewPanel(c).includes('data-expert-verdict'));});
test('Canonical UI routes and modules serve; unknown API endpoints still return 404',async t=>{const dir=await mkdtemp(join(tmpdir(),'kruzhivo-ui-'));const app=await createApp({dataDir:dir,initialKey:''});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();await rm(dir,{force:true,recursive:true});});const base='http://127.0.0.1:'+app.server.address().port;for(const path of ['/login','/register','/gov/new','/gov/checks/example/graph','/expert/review/example','/help','/notifications']){const r=await fetch(base+path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);}for(const path of ['/portal-router.js','/accessibility.js','/expert-editor.js','/shared/provision-graph.mjs','/portal.css'])assert.equal((await fetch(base+path)).status,200);assert.equal((await fetch(base+'/api/unknown')).status,404);});
test('Accessibility preferences, landmarks and initial skeleton are available without external resources',async()=>{const js=await readFile(new URL('../public/accessibility.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/portal.css',import.meta.url),'utf8'),html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');for(const term of ['localStorage.setItem','125','150','contrast','dark'])assert.ok(js.includes(term));assert.match(html,/skip-link/);assert.match(html,/loading-skeleton/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/focus-visible/);assert.match(css,/mobile-bottom/);});

test('Owner capability survives the separate login in memory and is consumed once without persistent storage',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const start=source.indexOf('async function applyAccessLink()'),end=source.indexOf('\nfunction showExpertInvitation',start),fn=source.slice(start,end);const token='A'.repeat(43),calls=[],state={pendingAccessLink:'#admin/'+token};const context={state,location:{hash:''},history:{replaceState(){}},pathFor,api:async(path,data)=>{calls.push({path,data});}};vm.createContext(context);assert.equal(await vm.runInContext(fn+';applyAccessLink()',context),'admin');assert.equal(calls[0].path,'admin/login');assert.equal(calls[0].data.token,token);assert.equal(state.pendingAccessLink,null);assert.equal(await vm.runInContext('applyAccessLink()',context),null);assert.ok(!fn.includes('localStorage'));
});

test('AI-agent connection controls respect owner and expert roles without exposing the saved key',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('function aiConnectionCard()'),end=source.indexOf('function settings()',start);
 const state={account:{role:'admin'},db:{config:{hosted:true,shared:true,canManage:true,configured:false,apiKey:'test-secret-never-display'}}};
 const context={state,esc:value=>String(value??'').replace(/</g,'&lt;'),B:(action,label)=>'<button data-action="'+action+'">'+label+'</button>'};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 let html=vm.runInContext('aiConnectionCard()',context);assert.match(html,/data-action="settings"/);assert.match(html,/Добавить API-ключ/);assert.ok(!html.includes('test-secret-never-display'));
 state.db.config.canManage=false;html=vm.runInContext('aiConnectionCard()',context);assert.ok(!html.includes('data-action="settings"'));assert.match(html,/администратор/);
 state.account.role='official';state.db.config.canManage=true;html=vm.runInContext('aiConnectionCard()',context);assert.equal(html,'');
 state.account.role='expert';state.db.config.canManage=true;html=vm.runInContext('aiConnectionCard()',context);assert.equal(html,'');
 state.account.role='admin';state.db.config.configured=true;state.db.config.model='<model>';html=vm.runInContext('aiConnectionCard()',context);assert.match(html,/Настроить API-подключение/);assert.match(html,/&lt;model>/);assert.ok(!html.includes('test-secret-never-display'));
});

test('Case tabs preserve unsaved conclusion and revision while switching panels',()=>{
 const draft={value:'Несохранённое заключение',dataset:{revision:'7'}},ids=['review','conclusion','discussion'];
 const buttons=ids.map(id=>({dataset:{caseTab:id},attrs:{},setAttribute(k,v){this.attrs[k]=v;},classList:{toggle(){}}}));
 const panels=ids.map(id=>({dataset:{casePanel:id},hidden:id!=='review',draft:id==='conclusion'?draft:null}));
 const root={querySelectorAll(selector){return selector==='[data-case-tab]'?buttons:panels;}};
 for(const id of ['conclusion','discussion','review','conclusion'])assert.equal(activateCaseTab(id,root),true);
 assert.equal(panels[1].hidden,false);assert.equal(panels[0].hidden,true);
 assert.equal(buttons[1].attrs['aria-selected'],'true');assert.equal(buttons[1].tabIndex,0);assert.equal(buttons[0].tabIndex,-1);
 assert.equal(panels[1].draft,draft);assert.equal(draft.value,'Несохранённое заключение');assert.equal(draft.dataset.revision,'7');
 assert.equal(activateCaseTab('invalid',root),false);assert.equal(panels[1].hidden,false);
});
