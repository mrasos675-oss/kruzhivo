import { renderApp, renderAnalysis } from '/app-render.js';
import { installActionHelp } from '/action-help.js';
import { renderProvisionMap, installProvisionMap } from '/provision-map.js';
import { documentKinds } from '/document-kinds.js';
import {legalBaseContent,installLegalLibrary} from '/legal-base.js';
import {installExpertEditor,readExpertDecisions} from '/expert-editor.js';
import {currentToken,pathFor,tokenFor,navigate,upgradeLinks,canonicalize} from '/portal-router.js';
import {accessButton,installAccessibility} from '/accessibility.js';
import { relatedProvisions } from '/shared/provision-graph.mjs';
import { ruStatus, moscowTime, methodReference, findingNumber, nextPendingIndex, findingLimitation, documentAssessmentLabel, findingReviewSummary } from '/shared/report-format.mjs';
import { renderReport } from '/shared/report-view.mjs';
import { parseDocumentStructure } from '/shared/document-structure.mjs';
import { landingPage, registrationPage, infoPage } from '/landing.js';
import { profilePage, expertOverview } from '/profile.js';
import { SAMPLE_DOCUMENTS } from '/samples.js';
import { loginPage } from '/login.js';
import { dashboardFilters } from '/dashboard.js';
import { overview, expertList, expertShowcase, invitationForm, expertCase } from '/cabinets.js';
import { methodologyContent, runDetailsContent, qualityContent } from '/transparency.js';
import { currentRun, isArchived, hasSavedDecision, proposalForDecision, findingTitle, quoteContext } from '/review.mjs';
const paintApp=html=>renderApp(document.getElementById('app'),html);
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { db:null, search:'', exampleSearch:'', upload:null, draft:null, dirty:false, menu:false, sidebarCollapsed:false, busy:false, error:'', exportFile:null, exportError:'', conflict:false, preserveHash:null };
const plural=(n,a,b,c)=>n%100>=11&&n%100<=14?c:n%10===1?a:n%10>=2&&n%10<=4?b:c;
const factorCount=n=>`${n} ${plural(n,'возможный фактор','возможных фактора','возможных факторов')}`;
const findingCount=n=>`${n} ${plural(n,'замечание','замечания','замечаний')}`;
const labels = {pending:'Не рассмотрено',modified:'Изменено',confirmed:'Подтверждено',rejected:'Отклонено',running:'Проверка выполняется',completed:'Проверка завершена',failed:'Проверка не завершена',cancelled:'Проверка остановлена',queued:'Ожидание',skipped:'Не требуется',not_started:'Не выполнен'};
const verdicts = {supported:'Выдержала перепроверку',contested:'Есть возражение',insufficient:'Недостаточно данных'};
const route=()=>{const token=currentToken();return (token==='login'&&state.account?(state.account.role==='admin'?'methodology':state.account.role==='expert'?'experts':'overview'):token).split('/');};
const date = moscowTime;
const B = (action,text,kind='',attrs='') => `<button type="button" class="btn ${kind}" data-action="${action}" ${attrs}>${text}</button>`;
const A = (href,text,kind='',attrs='') => `<a class="btn ${kind}" href="${href}" ${attrs}>${text}</a>`;
const notice = (title,text='',kind='') => `<div class="notice ${kind}"><h3>${esc(title)}</h3>${text?`<p>${esc(text)}</p>`:''}</div>`;
const responsiveText=(text,mobile)=>mobile?`<span class="desktop-text">${esc(text)}</span><span class="mobile-text">${esc(mobile)}</span>`:esc(text);
const head = (title,subtitle='',mobileSubtitle='') => `<div class="page-head"><h1 tabindex="-1">${esc(title)}</h1>${subtitle?`<p class="subhead">${responsiveText(subtitle,mobileSubtitle)}</p>`:''}</div>`;
const field = (name,title,value='',options={}) => `<label class="field"><span>${esc(title)}</span>${options.area?`<textarea name="${name}" rows="${options.rows||2}" maxlength="${options.max||10000}" ${options.readonly?'readonly':''} ${options.required?'required':''} placeholder="${esc(options.placeholder||'')}">${esc(value)}</textarea>`:`<input name="${name}" type="${options.type||'text'}" ${options.type==='password'?'autocomplete="off" autocapitalize="none" spellcheck="false"':''} maxlength="${options.max||180}" value="${esc(value)}" ${options.readonly?'readonly':''} ${options.required?'required':''} placeholder="${esc(options.placeholder||'')}">`}</label>`;
const card = (title,text,href='',extra='',mobileText='') => `<${href?'a':'section'} ${href?`href="${href}"`:''} class="card doc-row ${href?'card-link':''}"><h2>${esc(title)}</h2><p class="meta">${responsiveText(text,mobileText)}</p>${extra}</${href?'a':'section'}>`;
const status = value => `<span class="status ${value}">${esc(labels[value]||value)}</span>`;
const factor = id => state.db.catalog.factors.find(f=>f.id===id);
const titleOf = f => findingTitle(f,state.db.catalog);
function locate(id) { for(const d of state.db.documents) { const r=d.runs.find(r=>r.id===id); if(r)return {d,r,v:d.versions.find(v=>v.id===r.versionId)}; } return null; }
function target() { const [,id,n]=route(),x=locate(id); if(!x)return null; const index=Math.max(0,Math.min(Number(n)||0,x.r.findings.length-1));return {...x,index,f:x.r.findings[index]}; }
const meta = x => `${x.d.name} · v.${x.v.number} · запуск №${x.r.number}`;
function counts(r){const c={confirmed:0,modified:0,rejected:0,pending:0};for(const f of r.findings)c[f.decision.status]=(c[f.decision.status]||0)+1;return c;}
function summary(r){const c=counts(r);return `Рассмотрено ${c.confirmed+c.modified+c.rejected} из ${r.findings.length} · Подтверждено ${c.confirmed} · Изменено ${c.modified} · Отклонено ${c.rejected} · Не рассмотрено ${c.pending}`;}
async function api(path,data,method='POST') {
  const options = data===undefined ? {} : {
    method, headers:{'Content-Type':'application/json','x-kruzhivo-client':'1'}, body:JSON.stringify(data)
  };
  const bounded = /^runs\/[^/]+\/status$/.test(path) || path.startsWith('auth/') || ['bootstrap','methodology','expert-cases'].includes(path);
  const controller = bounded ? new AbortController() : null;
  const timer = controller && setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    try {
      response = await fetch('/api/'+path, controller ? {...options, signal:controller.signal} : options);
    } catch (error) {
      if(!bounded)throw error;
      throw Error(controller.signal.aborted ? 'Сервер не ответил вовремя. Попробуйте ещё раз.' : 'Не удалось связаться с сервером. Попробуйте ещё раз.');
    }
    if(response.status===401){state.account=null;state.db=null;state.expertCase=null;}
    let json;
    try { json = await response.json(); }
    catch { throw Error('Не удалось получить ответ сервера. Попробуйте ещё раз.'); }
    if(!response.ok)throw Object.assign(Error(json.error||'Не удалось выполнить действие.'),{status:response.status});
    return json;
  } finally { if(timer)clearTimeout(timer); }
}
async function refresh({sessionOnly=false,knownSession}={}) {
  const session=knownSession||await api('auth/session');
  if(state.account?.id!==session.user?.id)state.expertCase=null;
  state.account = session.user;
  state.demoLogin = session.demoLogin === true;
  state.pilotMode = session.pilotMode === true;
  if(state.caseHistory?.accountId!==session.user?.id)state.caseHistory=null;
  if (sessionOnly||!session.user) {
    state.db = null;
    state.expertCase = null;
    return;
  }

  const [database, expertCases] = await Promise.all([
    api('bootstrap'),
    session.user.role === 'admin' ? { cases: [] } : api('expert-cases')
  ]);
  state.db = database;
  state.account = database.account || session.user;
  state.expertCases = expertCases.cases;
  const [page, id] = route();
  if (page === 'expert-case') state.expertCase = await api('expert-cases/' + id);
  if (page === 'case-history')await loadCaseHistory();
}
let toastTimeout;
function toast(message) { $('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('#toast').classList.remove('visible'),5000); }
function clearDraft() {state.draft=null;state.dirty=false;state.conflict=false;state.rejectReason='';}
function modal(title,body,actions='') {const dialog=$('#modal');dialog.innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="modal-close" data-action="modal-close" aria-label="Закрыть">×</button></div><div class="modal-body">${body}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}`;if(!dialog.open)dialog.showModal();fitFields(dialog);}
function closeModal() {$('#modal').close();$('#modal').innerHTML='';}
function leave(proceed) { if(!state.dirty){return proceed();}state.pendingLeave=proceed;modal('Несохранённое решение',notice('В полях остался черновик','Сохраните решение или подтвердите переход без сохранения.'),B('modal-close','Остаться в черновике')+B('discard','Перейти без сохранения','danger')); }
function go(token,keepDraft=false){const proceed=()=>{if(!state.account&&['login','register'].includes(token)){if(isAccessLink())state.pendingAccessLink=location.hash;if(currentToken().startsWith('expert-invite/'))state.authReturn=currentToken();}if(!keepDraft)clearDraft();state.error='';state.menu=false;navigate(token);};if(keepDraft)proceed();else leave(proceed);}
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
let lastRouteURL=location.href;
function routeChanged(){if(isAccessLink()){if(!state.account){render();return;}void perform(async()=>{const action=await applyAccessLink();await refresh();render();if(action==='admin')settings();});return;}const token=currentToken();lastRouteURL=location.href;state.menu=false;
 if(state.account&&(!state.db||['overview','documents','results','experts','expert-done','expert-statistics','run-details'].includes(token.split('/')[0]))&&!['home','login','register'].includes(token)&&!pathFor(token).startsWith('/#')){
   if(state.busy){render();return;}
   void perform(async()=>{await refresh();render();});
   return;
 }
 render();const section=document.getElementById(token);if(section){section.scrollIntoView({behavior:'smooth'});if(token==='expert-official-info')section.focus({preventScroll:true});}else{window.scrollTo(0,0);document.querySelector('main')?.focus({preventScroll:true});}}
window.addEventListener('portalroute',routeChanged);
window.addEventListener('popstate',()=>{if(state.dirty){const target=location.href;history.replaceState(null,'',lastRouteURL);leave(()=>{clearDraft();history.pushState(null,'',target);routeChanged();});}else routeChanged();});
window.addEventListener('hashchange',()=>{if(isAccessLink()){routeChanged();return;}const token=currentToken();history.replaceState(null,'',lastRouteURL);go(token);});
function shell(content,active='documents',crumb='Документы',{checksNavigation=true}={}){
 const administrator=state.account?.role==='admin',expert=state.account?.role==='expert',home=administrator?'methodology':expert?'experts':'overview',name=state.db.profile?.fullName||state.account?.displayName||'';
 const primary=administrator?[['methodology','Работа ИИ агентов']]:expert?[['experts','Главная'],['expert-done','Мои дела'],['expert-statistics','Моя статистика'],['methodology','Работа ИИ агентов'],['sources','Правовая база']]:[['overview','Главная'],['upload','Новая проверка'],['documents','Мои проверки'],['methodology','Работа ИИ агентов'],['sources','Правовая база']];
 const navActive=!administrator&&!expert&&['history','experts','case-history'].includes(active)?'documents':active;
 const checksTabs=checksNavigation&&!administrator&&!expert&&['documents','history','experts','case-history'].includes(active)?'<nav class="actions queue-tabs" aria-label="Мои проверки">'+[['documents','Мои проверки'],['experts','Экспертные заключения'],['case-history','История проверок']].map(([id,title])=>A('#'+id,title,active===id?'primary':'',active===id?'aria-current="page"':'')).join('')+'</nav>':'';
 const waiting=(state.expertCases||[]).some(c=>!c.isDemo&&c.status==='waiting');
 const queueDot=id=>id==='expert-done'?`<span class="expert-queue-dot" data-expert-queue-dot ${waiting?'':'hidden'}><span class="sr-only">Есть новые проверки</span></span>`:'';
 const nav=items=>items.map(([id,title])=>`<a href="#${id}" class="${[navActive===id?'active':'',id==='upload'?'nav-new-check':''].filter(Boolean).join(' ')}" ${navActive===id?'aria-current="page"':''}>${expert?'':`<span class="nav-icon" aria-hidden="true">${({overview:'⌂',upload:'＋',documents:'▤',methodology:'?',sources:'§',experts:'▤','expert-done':'✓','expert-statistics':'▥'})[id]||'•'}</span>`}<span class="nav-label">${title}</span>${queueDot(id)}</a>`).join('');
 return `<div class="shell ${state.sidebarCollapsed?'sidebar-collapsed':''} ${state.menu?'menu-open':''}"><aside class="sidebar" id="workspace-sidebar">${B('sidebar-toggle','<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>','compact sidebar-toggle','aria-label="'+(state.sidebarCollapsed?'Развернуть панель':'Свернуть панель')+'" title="'+(state.sidebarCollapsed?'Развернуть панель':'Свернуть панель')+'" aria-expanded="'+!state.sidebarCollapsed+'" aria-controls="workspace-sidebar"')}<a href="#home" class="brand">КружИИво<span class="brand-caption">Антикоррупционная экспертиза</span></a><a href="#${administrator?'methodology':'profile'}" class="sidebar-person" aria-label="Открыть профиль">${state.db.profile?.avatar?`<img src="${esc(state.db.profile.avatar)}" alt="" class="sidebar-avatar">`:'<span class="sidebar-avatar avatar-placeholder" aria-hidden="true">'+esc(name.slice(0,1))+'</span>'}<span><strong>${esc(name)}</strong><small>${administrator?'Администратор':expert?'Независимый эксперт':'Государственный служащий'}</small></span>${state.account.role==='official'?'<svg class="profile-edit-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg><span class="sr-only">Редактировать профиль</span>':''}</a><nav class="nav" aria-label="Основная навигация">${nav(primary)}</nav>${state.db.config.hosted&&!state.db.config.canManage?'':B('settings','Настройки API','text-button')}<div class="sidebar-footer">${B('logout','Выйти','text-button sidebar-logout')}</div></aside><main class="main" id="main-content" tabindex="-1"><div class="mobile-top"><a href="#home" class="brand">КружИИво</a>${!administrator?`<a class="mobile-profile" href="#profile" aria-label="Открыть мой профиль">${state.db.profile?.avatar?`<img src="${esc(state.db.profile.avatar)}" alt="">`:`<span aria-hidden="true">${esc(name.slice(0,1))}</span>`}</a>`:''}${B('menu',state.menu?'Закрыть меню':'Меню','compact','aria-expanded="'+state.menu+'" aria-controls="mobile-nav"')}</div><header class="topbar"><nav class="breadcrumbs" aria-label="Хлебные крошки">${state.account.role==='official'&&active==='overview'?'<span aria-current="page">Кабинет государственного служащего</span>':`<a href="#${home}">${expert?'Кабинет эксперта':'Главная'}</a>${crumb!=='Главная'?' / <span aria-current="page">'+esc(crumb)+'</span>':''}`}</nav><div class="topbar-tools">${accessButton()}</div></header><nav id="mobile-nav" class="mobile-nav ${state.menu?'open':''}" aria-label="Все разделы">${B('menu','Закрыть меню','compact')}<div class="stack">${nav(primary)}</div><div class="mobile-nav-footer">${B('logout','Выйти','text-button')}</div></nav><div class="content">${state.error?`<div class="error-message" role="alert">${notice('Действие не выполнено',state.error,'error')}</div>`:''}${checksTabs}${content}</div><nav class="mobile-bottom" aria-label="Быстрый переход">${primary.map(([id,title],i)=>`<a href="#${id}" ${navActive===id?'aria-current="page"':''}><span aria-hidden="true">${({overview:'⌂',upload:'＋',documents:'▤',methodology:'?',sources:'§',experts:'▤','expert-done':'✓','expert-statistics':'▥'})[id]||'•'}</span>${title}${queueDot(id)}</a>`).join('')}</nav></main></div>`;
}
function workflowProgress(r,showNotice=true){const c=(state.expertCases||[]).find(c=>c.runId===r.id)||(r.expertCaseId?{status:'waiting'}:null),stage=r.status==='running'?1:c?.status==='confirmed'?3:r.status==='completed'?2:1;return '<ol class="case-progress" aria-label="Этапы проверки">'+['Документ принят','Анализ ИИ',!c?'Передача эксперту':c.status==='waiting'?'Ожидает эксперта':'Проверка экспертом','Заключение готово'].map((t,i)=>'<li '+(i===stage?'aria-current="step"':i<stage?'class="done"':'')+'>'+(i<stage?'✓ ':i+1+' ')+t+'</li>').join('')+'</ol>'+(showNotice?'<p class="notice">Госслужащий рассматривает выводы ИИ и замечания к проекту НПА. Независимый эксперт готовит своё заключение.</p>':'')+(r.status==='completed'&&!c?'<p class="muted">Анализ ИИ завершён. '+(state.pilotMode?'Дело появится в общей очереди экспертов. Если передачу не удалось подтвердить, отправьте его с этой страницы.':'Рассмотрите замечания и подтвердите передачу эксперту.')+'</p>':'');}
function notificationsPage(){const events=state.db.documents.flatMap(d=>d.runs.map(r=>({at:r.finishedAt||r.createdAt,title:d.name,text:labels[r.status],href:'#results/'+r.id}))).concat((state.expertCases||[]).map(c=>({at:c.createdAt,title:c.name,text:({waiting:'Ожидает эксперта',reviewing:'Проверяет эксперт',confirmed:'Заключение готово'})[c.status],href:'#expert-case/'+c.id}))).sort((a,b)=>new Date(b.at)-new Date(a.at));return shell(head('События проверок','Сводка сохранённых событий; почтовые уведомления пока не подключены.')+'<div class="stack">'+(events.map(e=>card(e.title,date(e.at)+' · '+e.text,e.href)).join('')||notice('Событий пока нет','После загрузки документа здесь появится ход проверки.'))+'</div>','notifications','События');}
function runConfirmation(docId,versionId){
 const d=state.db.documents.find(d=>d.id===docId),v=d?.versions.find(v=>v.id===versionId);if(!v)return missing();
 const n=d.runs.filter(r=>r.versionId===v.id).length+1;
 const choice=state.runChoices,mode=choice?.docId===d.id&&choice.versionId===v.id?choice.mode:'api',unavailable=mode==='api'&&!state.db.config.configured;
 return shell(`<div class="upload-workflow">${head('Отправка на проверку')}${stepper(3)}<form id="send-run-form" class="card upload-panel" data-doc="${d.id}" data-version="${v.id}"><div class="document-summary"><h2>${esc(d.name)}</h2><p>Выбрана версия ${v.number} · проверка №${n}</p><p class="muted">${v.original?'DOCX':'Текст'} · версия ${v.number}</p></div><input type="hidden" name="mode" value="${esc(mode)}">${mode==='demo'?'<p class="workflow-unavailable">Учебный документ: будут показаны подготовленные ответы без вызова модели.</p>':'<p class="submission-caption">Документ и проверенные источники будут переданы модели для анализа. '+(state.pilotMode?'После анализа документ и результаты автоматически поступят в общую очередь экспертов.':'После анализа вы сможете рассмотреть замечания и направить документ эксперту.')+'</p>'}<label class="radio submission-consent"><input name="permission" type="checkbox" required>${state.pilotMode?'Подтверждаю право передать документ на анализ ИИ и в общую очередь экспертов':'Подтверждаю право передать документ на проверку'}</label>${unavailable?'<p class="workflow-unavailable" role="status">Проверка временно недоступна. Администратору нужно подключить модель.</p>':''}<div class="workflow-footer">${A('#prepare/'+d.id+'/'+v.id,'← Назад','workflow-cancel')}<button type="submit" class="btn primary" ${unavailable?'disabled':''}>Начать проверку</button></div></form></div>`,'upload','Отправка документа');
}

function modeCaption(r) {return r.mode==='demo'?'<p class="mode-caption">Демонстрационные данные · подготовленные ответы, без запроса к модели.</p>':`<p class="mode-caption">Анализ через ${esc(r.model)}. Итоговое решение принимает специалист.</p>`;}
function missing() {return shell(head('Экран не найден')+A('#documents','К документам'));}
function dashboard(){return historyPage();}

function uploadPage(paste=false,docId='') {
 const u=state.upload||{name:'',text:'',fileName:'',uploadId:null},d=state.db.documents.find(d=>d.id===docId),v=d?.versions.at(-1);
 return shell(`<div class="upload-workflow">${head(d?'Новая версия документа':'Новая проверка',d?d.name+' · версия '+(v.number+1):'')}${stepper(1)}<form id="upload-form" class="card upload-panel" data-doc="${esc(docId)}" data-paste="${paste}"><div class="upload-mode" role="group" aria-label="Способ добавления документа">${[false,true].map(text=>B('upload-switch',text?'Вставить текст':'Загрузить файл','',`data-doc="${esc(docId)}" data-paste="${text}" aria-pressed="${paste===text}"`)).join('')}</div>${paste?field('text','Текст документа',u.text,{area:true,rows:8,max:80000,required:true,placeholder:'Вставьте текст документа целиком'}):`<div id="upload-zone" class="upload-zone clean-upload-zone" role="group" aria-label="Загрузка документа"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg><h2>${esc(u.fileName||'Перетащите документ сюда')}</h2><label class="btn" for="docx-input">${u.uploadId?'Выбрать другой файл':'Выбрать файл'}</label><input id="docx-input" class="sr-only" type="file" accept=".docx" aria-label="Выбрать DOCX" aria-describedby="file-status"><p id="file-status" class="muted" role="status">${esc(u.uploadId?'Файл загружен · '+u.text.length.toLocaleString('ru-RU')+' символов':'DOCX · до 3 МБ')}</p></div>`}${field('name','Название документа',d?.name||u.name,{required:true,readonly:!!d,placeholder:'Введите название'})}${d?'':`<label class="field"><span>Вид документа</span><select name="kind" required><option value="">Выберите вид документа</option>${documentKinds.map(kind=>`<option ${u.kind===kind?'selected':''}>${esc(kind)}</option>`).join('')}</select></label><label class="field"><span>Уровень НПА (если известен)</span><select name="level"><option value="">Не указан</option>${['Федеральный','Региональный','Муниципальный','Локальный'].map(level=>`<option ${u.level===level?'selected':''}>${level}</option>`).join('')}</select></label>${field('territory','Территория действия (если применимо)',u.territory||'',{max:200,placeholder:'Например, Волгоградская область'})}`}${d?'<details class="version-comment"><summary>Добавить комментарий к версии</summary>'+field('comment','Комментарий',u.comment||'',{area:true,max:2000})+'</details>':''}<div class="workflow-footer">${A(d?'#history/'+d.id:'#documents','Отмена','workflow-cancel')}<button type="submit" class="btn primary" ${!paste&&!u.uploadId?'disabled':''}>Продолжить →</button></div></form></div>`,'upload',d?'Новая версия':'Новая проверка');
}
function preparePage(docId,versionId,rerun=false) {
 const d=state.db.documents.find(d=>d.id===docId),v=d?.versions.find(v=>v.id===versionId)||d?.versions.at(-1);if(!v)return missing();
 const n=d.runs.filter(r=>r.versionId===v.id).length+1,isFixture=!state.pilotMode&&d.sample&&state.db.documents.some(doc=>doc.sample&&doc.runs.some(run=>run.mode==='demo')&&doc.versions.some(version=>version.text===v.text)),points=parseDocumentStructure(v.text);
 return shell(`<div class="upload-workflow">${head(rerun?'Повторить проверку':'Проверьте документ')}${stepper(2)}<form id="run-form" class="card upload-panel" data-doc="${d.id}" data-version="${v.id}"><div class="document-summary"><h2>${esc(d.name)}</h2><p><strong>Проверяется версия ${esc(v.number)} · ${esc(v.fileName||'Вставленный текст')}</strong></p><p class="muted">${v.original?'DOCX':'Текст'} · ${v.text.length.toLocaleString('ru-RU')} символов · ${points.length} пунктов${rerun?' · запуск №'+n:''}</p></div>${v.number>1?notice('Новый цикл проверки','Анализ будет выполнен для указанной версии. Исходный файл, прежние результаты, решения автора и заключения эксперта сохраняются.'):''}<details class="document-preview"><summary>Посмотреть текст документа</summary><div class="structure-list">${points.map(point=>`<p><strong>${esc(point.number)}</strong> ${esc(point.text)}</p>`).join('')}</div><div class="actions">${B('edit-structure','Изменить текст','compact',`data-doc="${d.id}" data-version="${v.id}"`)}</div></details>${isFixture?'<fieldset class="fixture-mode"><legend>Учебный документ</legend><label class="radio"><input type="radio" name="mode" value="demo" checked>Подготовленные ответы без обращения к модели</label><label class="radio"><input type="radio" name="mode" value="api" '+(!state.db.config.configured?'disabled':'')+'>Проверить документ моделью</label></fieldset>':'<input type="hidden" name="mode" value="api">'}${!state.db.config.configured&&!isFixture?'<p class="workflow-unavailable" role="status">Проверка временно недоступна. Администратору нужно подключить модель.</p>':''}<div class="workflow-footer">${d.sample?A('#documents','← Назад','workflow-cancel'):B('edit-structure','← Назад','workflow-cancel',`data-doc="${d.id}" data-version="${v.id}"`)}<button type="submit" class="btn primary" ${!isFixture&&!state.db.config.configured?'disabled':''}>Продолжить →</button></div></form></div>`,rerun?'documents':'upload','Проверка данных');
}

function relatedBlock(r,f){
 const rows=relatedProvisions(r.provisionGraph,f.id);
 return '<section class="card related-provisions"><h3>Связанные пункты</h3>'+(!r.provisionGraph?'<p>Граф отсутствует в этом старом запуске.</p>'+A('#graph/'+r.id,'Построить граф связей','compact'):!rows.length?'<p class="muted">Прямые ссылки для этого замечания не найдены. Это не исключает смысловых связей.</p>':rows.map(e=>'<p>'+A('#provision/'+r.id+'/'+e.node.id,'п. '+esc(e.node.number),'compact')+' — '+esc(e.type)+(e.direction==='outgoing'?' (ссылка из рассматриваемого пункта)':'')+': «'+esc(e.node.text)+'»</p>').join(''))+'</section>';
}
function graphWarning(r,f){
 return relatedProvisions(r.provisionGraph,f.id).some(e=>e.type==='уточняет'&&e.direction==='incoming')?'<div class="notice graph-warning" role="note"><h3>В другом пункте найдено возможное уточнение</h3><p>Прочитайте связанные пункты перед решением: они могут менять оценку замечания. Связь выделена по словам и ссылкам, а не является правовым выводом.</p></div>':'';
}
function graphPage(id) {
 const x=locate(id);
 if(!x)return missing();
 const g=x.r.provisionGraph;
 const heading=`<a class="check-results-back" href="#results/${id}">← Результаты проверки</a>${head('Граф связей',meta(x))}`;
 const page=body=>shell(`<div class="check-results provision-graph">${heading}${body}</div>`,'documents','Граф связей',{checksNavigation:false});
 if(!g)return page(notice('Граф для этого запуска ещё не построен','Постройте его по сохранённому тексту документа.')+B('graph-build','Построить граф','primary',`data-run="${id}"`));

 return page(renderProvisionMap(x.r,{esc,findingCount}));
}
function provisionPage(id,nodeId){
 const x=locate(id),n=x?.r.provisionGraph?.nodes.find(n=>n.id===nodeId);if(!n)return missing();
 const {r}=x;return shell(head('Пункт '+n.number,meta(x))+A('#graph/'+id,'← Назад к графу','compact')+'<section class="quote"><h2>п. '+esc(n.number)+'</h2><p class="provision-text">'+esc(n.text)+'</p></section><div class="actions">'+r.findings.map((f,i)=>n.findingIds.includes(f.id)?A('#run/'+id+'/'+i,'Замечание '+(i+1)+': '+esc(titleOf(f))):'').join('')+'</div>','documents','Пункт документа');
}

function expertRequestAction(r, expertCase=(state.expertCases||[]).find(item=>item.runId===r.id)) {
 const caseId=expertCase?.id||r.expertCaseId;
 return caseId ? '<span class="status">Передано эксперту</span>'+A('#expert-case/'+caseId,'Открыть дело') : B('expert-create','Передать эксперту','',`data-run="${r.id}" ${r.status!=='completed'||r.findings.some(f=>!['confirmed','modified','rejected'].includes(f.decision?.status)||!hasSavedDecision(f))?'disabled title="Сохраните решение по каждому замечанию"':''}`);
}

function expertVersionNotice(d,r){
 const c=(state.expertCases||[]).find(c=>c.runId===r.id&&c.status==='confirmed');
 if(!c||state.account?.role!=='official')return '';
 return `<section class="card stack"><h2>Получено заключение эксперта</h2><p>Заключение и замечания доступны отдельно. Подготовьте новую версию НПА с учётом рассмотренных предложений и запустите её проверку. Прежние версии, результаты и заключения сохраняются.</p><div class="actions">${B('expert-conclusion-open','Открыть заключение','primary',`data-case="${c.id}"`)}${B('version','Добавить новую версию','',`data-doc="${d.id}"`)}</div></section>`;
}
function resultsPage(id) {
 const x=locate(id);
 if(!x)return missing();
 const {d,r,v}=x;
 if(r.status==='running')return runningPage(x);
 if(['failed','cancelled'].includes(r.status))return errorPage(x);

 const total=r.findings.length, c=counts(r), reviewed=total-c.pending, archived=isArchived(d,r);
 const filter=state.findingFilter?.runId===id?state.findingFilter.status:'all';
 const expertCase=(state.expertCases||[]).find(item=>item.runId===r.id);
 const expertStatus=({waiting:'Ожидает эксперта',reviewing:'На проверке у эксперта',confirmed:'Заключение готово'})[expertCase?.status]
   || (r.expertCaseId?'Передано эксперту':'Анализ ИИ завершён');
 const filters=[
   ['all','Все замечания',total],
   ['pending','Не рассмотрены',c.pending],
   ['confirmed','Подтверждены',c.confirmed],
   ['modified','Изменены',c.modified],
   ['rejected','Отклонены',c.rejected],
 ];
 const rows=r.findings.map((f,i)=>{
   if(filter!=='all'&&f.decision.status!==filter)return '';
   return `<li><a class="result-finding" href="#run/${r.id}/${i}">
     <span class="result-finding-number" aria-label="Замечание ${i+1}">${i+1}</span>
     <span class="result-finding-content"><strong>${esc(titleOf(f))}</strong><small>${esc(f.point)}</small>${documentAssessmentLabel(f)?`<small>${esc(documentAssessmentLabel(f))}</small>`:''}</span>
     ${status(f.decision.status)}
     <span class="result-arrow" aria-hidden="true">→</span>
   </a></li>`;
 }).join('');

 return shell(`<div class="check-results">
   <a class="check-results-back" href="#documents">← Мои проверки</a>
   ${head(d.name,`Версия ${v.number} · запуск №${r.number}`)}${expertVersionNotice(d,r)}
   <section class="card check-results-overview" aria-label="Итоги проверки">
     <div class="check-results-summary">
       <strong>${total?findingCount(total):'Замечания не предложены'}</strong>
       ${total?`<span class="muted">Рассмотрено ${reviewed} из ${total}</span>`:''}
       <span class="status ${expertCase?.status==='confirmed'?'confirmed':'running'}">${expertStatus}</span>
       ${archived?'<span class="status">Архив · только чтение</span>':''}
       ${r.mode==='demo'?'<span class="status">Учебный режим</span>':''}
     </div>
     <div class="actions check-results-actions">
       ${A('#report/'+r.id,'Отчёт','primary')}
       ${A('#graph/'+r.id,'Граф связей')}
       ${total?A('#run/'+r.id+'/'+Math.max(0,nextPendingIndex(r)),archived?'Посмотреть замечания':'Рассмотреть замечания'):''}
       ${r.status==='completed'?expertRequestAction(r,expertCase):''}
     </div>
   </section>
   <section class="check-results-findings" aria-labelledby="check-results-findings-title">
     <div class="check-results-list-head">
       <h2 id="check-results-findings-title">Замечания</h2>
       ${total?`<label class="check-results-filter"><span class="sr-only">Фильтр по статусу замечания</span>
         <select id="finding-status-filter" data-run="${esc(id)}">${filters.map(([value,title,count])=>`<option value="${value}" ${filter===value?'selected':''}>${title} (${count})</option>`).join('')}</select></label>`:''}
     </div>
     ${rows?`<ol class="check-results-list">${rows}</ol>`:`<p class="check-results-empty muted">${total?'Нет замечаний с выбранным статусом.':'Сводка по факторам и ограничения доступны в отчёте ИИ.'}</p>`}
   </section>
   <details class="check-results-details"><summary>Материалы проверки</summary><div class="actions">
     ${A('#history/'+d.id,'История документа','compact')}
     ${A('#sources/'+r.id,'Источники проверки','compact')}
     ${A('#run-details/'+r.id,'Состав запуска','compact')}
   </div></details>
 ${documentActionLog(d)}</div>`,'documents','Результаты проверки',{checksNavigation:false});
}

function runningPage(x) {const {r,d}=x;return shell(`${head('Проверяем документ',meta(x))}${stepper(3)}<p class="step-caption">Шаг 3 из 3 · Анализ текста</p><div class="stack">${notice('Проверка выполняется','Ход этой проверки обновляется каждые 30 секунд. Анализ продолжается на сервере.')}<div class="card run-progress" data-analysis-run="${r.id}">${[['analyst','Аналитик — 12 факторов'],['reviewer','Проверяющий — поиск возражений'],['editor','Редактор — проект правки']].map(([k,n])=>`<p>${r.stages[k]==='completed'?'✓':r.stages[k]==='running'?'●':'○'} ${n} · ${esc(labels[r.stages[k]]||'Выполняется')}</p>`).join('')}</div><div class="actions">${A('#documents','К документам')}${A(`#run-details/${r.id}`,'Состав и ход проверки')}${B('cancel','Остановить проверку','danger',`data-run="${r.id}"`)}</div></div>${modeCaption(r)}`,'documents','Проверяем документ');}
function errorPage(x) {return shell(`${head('Проверка не завершена',meta(x))}<div class="stack">${notice(labels[x.r.status],runErrorText(x.r),'error')}${x.r.findings.length?notice('Частичные результаты сохранены',`Завершённые этапы вернули ${x.r.findings.length} замечания. Завершённые этапы можно сохранить и продолжить проверку с прерванного этапа.`):''}<div class="actions">${x.d.runs.at(-1)?.id===x.r.id?B('resume-run','Продолжить проверку','primary',`data-run="${x.r.id}"`):''}${A(`#rerun/${x.d.id}/${x.v.id}`,'Начать заново')}${A('#documents','К документам')}${A(`#report/${x.r.id}`,'Отчёт')}${A(`#run-details/${x.r.id}`,'Состав и ход проверки')}</div></div>`,'documents','Проверка не завершена');}
function findingReviewSummaryHtml(finding) {
 const lines=findingReviewSummary(finding);
 return lines.length ? `<section class="card" aria-label="Итоги перепроверки">${lines.map(([label,value])=>`<p><strong>${esc(label)}</strong> · ${esc(value)}</p>`).join('')}</section>` : '';
}
function decisionDraft(x) {if(state.draft?.runId===x.r.id&&state.draft?.findingId===x.f.id)return state.draft;const f=x.f;return {runId:x.r.id,findingId:f.id,revision:f.decision.revision,explanation:hasSavedDecision(f)?f.decision.explanation:(f.review?.documentAssessment?.status==='partial'?f.review.documentAssessment.summary:f.editor?.explanation||f.explanation),proposal:proposalForDecision(f),factorIds:f.decision.factorIds||[f.factorId],comment:f.decision.comment||'',basis:f.decision.basis||''};}
function capture(form) {state.draft={...Object.fromEntries(new FormData(form)),factorIds:new FormData(form).getAll('factorIds'),runId:form.dataset.run,findingId:form.dataset.finding,revision:Number(form.dataset.revision)};state.dirty=true;const label=$('#save-note');if(label){label.textContent='Есть несохранённые изменения';label.classList.add('dirty');}document.querySelectorAll('[data-action="example-start"]').forEach(b=>{b.disabled=true;});}
function basisHtml(f,r) {return f.basis.length?f.basis.map(b=>{const source=r.sources.find(s=>s.id===b.sourceId);return `<div class="card"><h3>${esc(source?.title||'Источник')}</h3><p>${esc(b.locator)} · ${esc(source?.revision)}</p><blockquote>${esc(b.quote)}</blockquote></div>`;}).join(''):'<p class="muted">Не заполнено. Укажите проверенные реквизиты нормы; текст проекта сам по себе не является правовым основанием.</p>';}
function machineEvidence(f,r) {return `<details class="machine"><summary>Цитаты и выводы: Аналитик · Проверяющий · Редактор</summary><div class="machine-content"><h3>Аналитик · ${esc(f.factorId)} / ${esc(factor(f.factorId)?.title)}</h3><p>${esc(f.explanation)}</p><h3>Основание Аналитика</h3>${basisHtml(f,r)}<h3>Проверяющий${f.review?' · '+esc(verdicts[f.review.verdict]):''}</h3>${f.review?`<p>${esc(f.review.explanation)}</p>${f.review.evidence.map(q=>`<blockquote>${esc(q)}</blockquote>`).join('')}${f.review.sourceEvidence?.length?'<h3>Источники перепроверки</h3>'+basisHtml({basis:f.review.sourceEvidence},r):''}${Object.entries(f.review.checks).map(([k,t])=>`<div class="check"><span>${({context:'Другие пункты',exception:'Исключения',applicability:'Применимость',freshness:'Актуальность'})[k]}</span><span>${esc(t)}</span></div>`).join('')}<ul>${[...f.review.counterarguments,...f.review.doubts].map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'<p>Перепроверка ещё не завершена.</p>'}<h3>Редактор</h3>${f.editor?.status==='prepared'?`<p>${esc(f.editor.explanation)}</p><blockquote>${esc(f.editor.proposal)}</blockquote><p><strong>${({preserved:'Смысл сохранён',changed:'Смысл меняется',uncertain:'Сохранение смысла не подтверждено'})[f.editor.meaning]}.</strong> ${esc(f.editor.meaningExplanation)}</p>${f.editor.meaningChecks?Object.entries(f.editor.meaningChecks).map(([key,check])=>`<div class="check"><span>${({rights:'Права',obligations:'Обязанности',deadlines:'Сроки',conditions:'Условия',exceptions:'Исключения',competence:'Компетенция'})[key]}</span><span>${esc(({preserved:'Сохранены',changed:'Меняются',uncertain:'Не подтверждено'})[check.status])}. ${esc(check.explanation)}</span></div>`).join(''):''}`:`<p>${esc(f.editor?.reason||'Этап не завершён.')}</p>`}</div></details>`;}
function coverage(r) {return `<details class="coverage"><summary>Охват ${r.coverage.length}/12 факторов и ограничения</summary><div class="coverage-body">${r.coverage.map(c=>`<div class="check"><span>${esc(c.factorId)}</span><div><h3>${esc(factor(c.factorId)?.title)}</h3><p>${esc(c.note)}</p></div></div>`).join('')}${r.limitations.map(t=>`<p class="muted">${esc(t)}</p>`).join('')}</div></details>`;}
function navigateFinding(offset) {const x=target(),index=x?.index+offset;if(!x||index<0||index>=x.r.findings.length)return;if(state.dirty){toast('Сначала сохраните решение. Несохранённые правки остаются в полях.');return;}go('run/'+x.r.id+'/'+index);}
function runPage(id) {const x=target();if(!x?.f)return locate(id)?resultsPage(id):missing();const{d,r,v,f,index}=x,archive=isArchived(d,r),editable=!archive&&r.status==='completed',draft=decisionDraft(x),aiDraft=f.editor?.proposal&&!hasSavedDecision(f),q=quoteContext(v.text,f.quote,f.point),c=counts(r);return shell(`${head('Проверка документа',meta(x))}${workflowProgress(r,false)}<div class="summary-row"><p>Замечание ${index+1} из ${r.findings.length} · ${summary(r)}</p>${A(`#report/${r.id}`,'Отчёт')}</div>${archive?`<div class="stack">${notice('Архивный результат','Только чтение. Для нового решения создайте отдельный запуск.')}<div></div></div>`:''}<div class="review-grid"><div><section class="quote"><h3>Проект регламента · п. ${esc(f.point)}</h3><p class="doc-label">${esc(d.name.toUpperCase())}</p>${q.before?`<p>${esc(q.before)}</p>`:''}<p class="selected">${esc(q.selected)}</p>${q.after?`<p>${esc(q.after)}</p>`:''}<small>Контекст из сохранённой версии документа. Правовое основание проверяется отдельно.</small></section><details class="machine"><summary>Полный текст и исходный файл</summary><div class="full-text">${esc(v.text)}</div><div class="actions">${sourceDownload(d,v)}</div></details></div><div><div class="finding-heading"><h2>${String(index+1).padStart(2,'0')} / ${esc(titleOf(f))}</h2>${status(f.decision.status)}${f.review?.verdict==='contested'?'<p class="mode-caption">Проверяющий нашёл возражение. Изучите материалы проверки перед решением.</p>':''}</div>${findingReviewSummaryHtml(f)}${editable?`<form id="decision-form" class="review-fields" data-run="${r.id}" data-finding="${f.id}" data-revision="${draft.revision}">${field('explanation','Объяснение (предложено системой, можно изменить)',draft.explanation,{area:true,rows:2})}${aiDraft&&f.editor.requiresLegalReview?notice('Проект редактора','Перед заменой текста сверьте формулировку с применимыми нормами.'):''}${field('proposal',aiDraft?'Предлагаемая редакция (проект ИИ, можно изменить)':'Предлагаемая редакция',draft.proposal,{area:true,rows:2})}${field('basis','Проверенное правовое основание',draft.basis,{area:true,rows:2,placeholder:'Укажите норму и её применимость; классификация по Методике приведена отдельно.'})}${B('basis-pick','Выбрать основание из правовой базы','compact')}${field('comment','Комментарий специалиста',draft.comment||'',{area:true,rows:2,max:3000})}<details><summary>Классификация специалиста</summary><p class="muted">Можно выбрать несколько факторов. Исходная классификация системы сохраняется.</p>${state.db.catalog.factors.map(factor=>`<label class="radio"><input name="factorIds" type="checkbox" value="${factor.id}" ${(draft.factorIds||[f.factorId]).includes(factor.id)?'checked':''}>${esc(factor.title)} · ${esc(methodReference(factor.id,state.db.catalog))}</label>`).join('')}</details></form>`:`<div class="review-fields">${card('Объяснение специалиста',f.decision.explanation||(f.decision.status==='pending'?'Решение специалиста не принято.':'Объяснение не указано.'))}${card('Предлагаемая редакция',proposalForDecision(f)||'Правка не предложена')}${card('Правовое основание',f.decision.basis||'Не заполнено — требуется проверка')}</div>`}${notice('Классификация по Методике',methodReference(f.factorId,state.db.catalog))}${notice('Ограничение вывода',findingLimitation(f))}${machineEvidence(f,r)}${relatedBlock(r,f)}</div></div>${graphWarning(r,f)}<div class="actions review-actions">${editable?B('cancel-decision-edit','Отменить','','title="Отменить несохранённые изменения"')+B('confirm','Подтвердить и сохранить',f.review?.verdict==='contested'?'':'primary')+B('confirm-modified','Изменить и подтвердить',f.review?.verdict==='contested'?'':'')+B('reject','Отклонить','danger'):''}<span class="review-navigation" role="group" aria-label="Переход между замечаниями">${B('previous-finding','←','compact','aria-label="Предыдущее замечание" title="Предыдущее замечание" '+(index===0?'disabled':''))}${B('next-finding','→','compact','aria-label="Следующее замечание" title="Следующее замечание" '+(index===r.findings.length-1?'disabled':''))}</span>${A(`#results/${r.id}`,'← Назад к списку замечаний')}</div><p id="save-note" class="save-note ${state.dirty?'dirty':''}">${state.dirty?'Есть несохранённые изменения':editable?'Решение сохраняется только после нажатия кнопки. Исходный документ автоматически не изменяется.':'Сохранённый результат доступен только для чтения.'}</p>${state.conflict?notice('В другой вкладке уже сохранено новое решение','Ваш черновик остаётся в полях. Скопируйте нужный текст перед обновлением.','error')+B('reload-decision','Загрузить сохранённое решение'):''}${editable&&['confirmed','modified'].includes(f.decision.status)?`<div class="actions">${B('example-start','Сохранить как пример','',state.dirty?'disabled':'')}</div>`:''}${modeCaption(r)}`,'documents','Проверка документа');}
function rejectPage() {const x=target();if(!x?.f)return missing();if(isArchived(x.d,x.r)||x.r.status!=='completed')return runPage(x.r.id);return shell(`${head('Отклонить замечание',`Пункт ${x.f.point} · ${titleOf(x.f)}`)}<form id="reject-form" class="stack">${notice('Решение останется в истории','Предложенная правка не применяется. Причина отклонения включается в отчёт.')}<div class="actions">${['Уточнено в другом пункте — укажите пункт: ','Есть правовое основание — укажите норму: ','Не является коррупциогенным фактором: ','Иное: '].map(reason=>B('reject-reason',esc(reason),'compact',`data-reason="${esc(reason)}"`)).join('')}</div>${field('reason','Причина отклонения *',state.rejectReason||'',{area:true,rows:4,required:true,max:10000})}<div class="actions"><button type="submit" class="btn primary">Сохранить отклонение</button>${B('reject-back','Назад')}</div></form>`,'documents','Отклонить замечание');}
function actionHelp(text) {return `<span class="action-help" hidden>${esc(text)}</span>`;}
function sourceDownload(d,v) {return A(`/api/documents/${d.id}/versions/${v.id}/${v.original?'original':'text'}`,v.original?'Скачать исходный DOCX':'Скачать сохранённый текст','', 'download')+actionHelp(v.original?'Исходный DOCX — загруженный оригинал выбранной версии '+v.number+'.':'Сохранённый текст выбранной версии '+v.number+'.');}
function documentRunStatus(r){
 const c=r&&(state.expertCases||[]).find(c=>c.runId===r.id);
 const [kind,icon,text]=!r?['draft','○','Не запущена']:r.status==='failed'?['failed','!','Ошибка проверки']:c?.status==='confirmed'?['completed','✓','Получено заключение']:c||r.expertCaseId?['queued','↗','Передано эксперту']:r.status==='completed'?(r.findings?.length?['pending','!','Есть замечания']:['completed','✓','Анализ ИИ завершён']):['running','○',labels[r.status]||r.status];
 return `<span class="status ${esc(kind)}"><span aria-hidden="true">${icon}</span> ${esc(text)}</span>`;
}
function runErrorText(r){
 const reason=/цитата.*не найдена/i.test(r.error||'')?'Не удалось подтвердить цитату модели в исходном тексте. Проверка точности цитат остановила этот запуск.':r.error||'Не удалось завершить проверку. Попробуйте повторить запуск.';
 return reason+' Ошибка относится к этому запуску, а не является характеристикой НПА.';
}
function documentActionLog(d){
 const events=(d.actionLog||[]).map(e=>({...e,href:'#run/'+e.runId+'/'+Math.max(0,d.runs.find(r=>r.id===e.runId)?.findings.findIndex(f=>f.id===e.findingId)??0),title:({confirmed:'Подтвердил замечание',modified:'Изменил замечание',rejected:'Отклонил замечание',pending:'Вернул замечание на рассмотрение'})[e.action]||'Сохранил решение'}));
 for(const c of state.expertCases||[])if(d.runs.some(r=>r.id===c.runId))events.push({id:c.id,createdAt:c.createdAt,author:c.requestedBy||'Автор не записан',title:'Передал документ эксперту',href:'#expert-case/'+c.id});
 events.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 return `<section class="card stack"><h2>Журнал действий</h2><p class="muted">Сохранённые действия по всем версиям документа. Ранее не записанные события не восстанавливаются.</p>${events.length?'<ol class="stack">'+events.map(e=>`<li><time datetime="${esc(e.createdAt)}">${esc(date(e.createdAt))}</time><p>${esc(e.author)} · ${esc(e.title)}</p>${A(e.href,'Открыть запись','compact')}</li>`).join('')+'</ol>':'<p>Сохранённых действий пока нет.</p>'}</section>`;
}
function historyPage(docId){
 const all=state.db.documents.filter(d=>docId?d.id===docId:!d.sample),query=docId?'':(state.search||'').trim().toLocaleLowerCase('ru-RU');
 const docs=all.filter(d=>d.name.toLocaleLowerCase('ru-RU').includes(query)).sort((a,b)=>new Date(b.runs.at(-1)?.createdAt||b.versions.at(-1)?.createdAt||b.createdAt)-new Date(a.runs.at(-1)?.createdAt||a.versions.at(-1)?.createdAt||a.createdAt));
 const timestamp=iso=>new Date(iso).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const captions={running:'Выполняется',queued:'В очереди',completed:'Завершена',failed:'Ошибка проверки',cancelled:'Остановлена'};
 const cards=docs.map(d=>{const selected=state.historySelection?.[d.id],latestVersion=d.versions.find(v=>v.id===selected?.versionId)||d.versions.at(-1),latestRun=selected?d.runs.find(r=>r.id===selected.runId&&r.versionId===latestVersion.id):d.runs.filter(r=>r.versionId===latestVersion.id).at(-1);
 return `<section class="card history-item"><div class="history-document-head"><div class="history-document-title"><p class="history-document-label">Название НПА</p><h2>${esc(d.name)}</h2><p class="muted">Версий: ${d.versions.length} · проверок: ${d.runs.length}</p></div>${documentRunStatus(latestRun)}</div><div class="history-action-panel"><p aria-live="polite">Выбрано: версия ${latestVersion.number}${latestRun?' · проверка №'+latestRun.number:' · без запуска'}</p>${latestRun?.status==='failed'?'<p class="history-run-error">'+esc(runErrorText(latestRun))+'</p>':''}<div class="actions">${latestRun?A('#results/'+latestRun.id,'Открыть результат','compact'):''}${latestRun&&['completed','failed','cancelled'].includes(latestRun.status)?reportDownloads(latestRun.id):''}${A((latestRun?'#rerun/':'#prepare/')+d.id+'/'+latestVersion.id,latestRun?'Повторить проверку':'Запустить проверку','compact')}${actionHelp('Новый анализ выбранной сохранённой версии. Чтобы проверить изменённый текст, добавьте новую версию.')}${B('version','Добавить новую версию','compact',`data-doc="${d.id}"`)}${actionHelp('Добавьте новую версию, если текст изменился, например после замечаний коллег. Предыдущая версия и результаты сохранятся.')}${sourceDownload(d,latestVersion)}</div></div><details class="history-document-details" ${docId?'open':''}><summary>Версии и проверки</summary><div class="history-versions">${[...d.versions].reverse().map(v=>{const runs=d.runs.filter(r=>r.versionId===v.id).slice().reverse();return `<section class="history-version"><div class="history-version-head"><h3>Версия ${v.number}</h3><time datetime="${esc(v.createdAt)}">${esc(timestamp(v.createdAt))} · МСК</time></div>${v.comment?'<p class="history-version-comment">'+esc(v.comment)+'</p>':''}${runs.length?'<ol class="history-runs">'+runs.map(r=>`<li class="history-run"><div class="history-run-info"><h4>Проверка №${r.number}</h4><p>${esc(timestamp(r.createdAt||v.createdAt))} · ${isArchived(d,r)?'Архив · только чтение': 'Текущая'}${r.mode==='demo'?' · Подготовленные ответы':''}</p></div><div class="history-run-state">${documentRunStatus(r)}<p>${r.status==='completed'?factorCount(r.findings?.length||0):''}</p></div><div class="history-run-actions">${B('history-select',latestRun?.id===r.id?'Выбрано':'Выбрать','compact',`data-doc="${d.id}" data-version="${v.id}" data-run="${r.id}" aria-pressed="${latestRun?.id===r.id}"`)}</div>${r.error?'<p class="history-run-error">'+esc(runErrorText(r))+'</p>':''}</li>`).join('')+'</ol>':'<p class="history-not-started">Эта версия ещё не проверялась.</p>'}<div class="history-version-actions">${B('history-select','Выбрать версию '+v.number,'compact',`data-doc="${d.id}" data-version="${v.id}" data-run="${runs[0]?.id||''}" aria-pressed="${latestVersion.id===v.id}"`)}</div></section>`;}).join('')}</div></details></section>`;
 }).join('');
 const search=!docId&&all.length?'<label class="checks-search"><span class="sr-only">Поиск по названию документа</span><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" id="document-search" value="'+esc(state.search||'')+'" placeholder="Найти документ" autocomplete="off"></label>':'';
 const count=!docId&&all.length?'<p class="checks-count">'+(query?'Найдено '+docs.length+' из '+all.length:'Всего: '+all.length)+'</p>':'';
 const empty='<div class="card checks-empty"><h2>'+(query?'Ничего не найдено':'Проверок пока нет')+'</h2><p>'+(query?'Попробуйте изменить поисковый запрос.':'Добавьте документ через раздел «Новая проверка».')+'</p></div>';
 return shell(`<section class="history-page"><div class="checks-page-header">${head('Мои проверки',docId?docs[0]?.name||'Документ не найден':'')}${search}</div>${count}<div class="history-list">${cards||empty}</div>${docId?'<div class="actions history-return">'+A('#documents','← К моим проверкам','workflow-cancel')+'</div>':''}</section>`,'documents','Мои проверки');
}
function reportDownloads(id) {
 const path='/api/runs/'+encodeURIComponent(id);
 return '<details class="report-downloads"><summary class="btn compact">Скачать отчёт</summary><div class="actions">'+A(path+'/report.pdf','PDF','compact','download')+A(path+'/report.docx','Word','compact','download')+'</div></details>';
}
function reportPage(id) {
  const x = locate(id);
  if (!x) return missing();
  const { d, r, v } = x;
  const tools = `<div class="report-toolbar">
    ${A('#results/' + r.id, '← Назад к проверке', 'compact')}
    ${reportDownloads(r.id)}
  </div>`;
  const nextStep = r.status === 'completed' && !isArchived(d,r) ? `<section class="card report-next-step no-report-print" aria-label="Следующий шаг"><h2>Следующий шаг</h2><p>${esc(d.name)} · версия ${esc(v.number)}</p><p>Решения по замечаниям не изменяют исходный текст автоматически.</p><div class="actions">${B('report-repeat','Повторить проверку','primary',`data-run="${esc(r.id)}"`)}${expertRequestAction(r)}</div></section>` : '';
  return shell(tools + nextStep + renderReport(d, v, r, state.db.profile, r.aiPolicy?.catalog || state.db.catalog), 'documents', 'Отчёт');
}

function exportPage(id,ready=false) {if(state.exportErrorRun!==id)state.exportError='';const x=locate(id);if(!x)return missing();const file=state.exportFile?.id===id?state.exportFile:null;if(ready&&!file)return exportPage(id);return shell(`${head(ready?'Отчёт подготовлен':state.exportError?'Не удалось сформировать Word':'Экспорт отчёта',ready?'Word (.docx)':'Формат Word (.docx)')}<div class="stack">${state.exportError?notice('Отчёт и решения сохранены',state.exportError,'error'):''}${ready?notice('Файл доступен для сохранения','Отчёт включает решения и ограничения выбранной проверки.'):notice('Состав документа','Название и версия регламента · номер запуска · цитаты · объяснения · решения специалиста · правовые основания и ограничения.')}${!ready?notice('Статусы сохраняются в отчёте','Если остались нерассмотренные предложения, Word будет помечен как предварительный. Незаполненные основания будут отмечены.'):''}<div class="actions">${ready?A(file.url,'Скачать отчёт (Word)','primary',`download="${esc(file.name)}"`):B('export-file',state.exportError?'Повторить':'Сформировать файл','primary',`data-run="${id}"`)}${A(`#report/${id}`,'Вернуться к отчёту')}${ready?A('#documents','К документам'):''}</div></div>`,'documents',ready?'Отчёт подготовлен':'Экспорт отчёта');}
function sourcesPage(runId,section='legal') {
 const x=locate(runId),sources=x?x.r.sources:state.db.sources,canEdit=false;
 if(!x&&section==='materials'&&!state.methodology)return shell(head('Учебные материалы')+methodologyPlaceholder(),'sources','Правовая база');
 if(!x)return shell(legalBaseContent({section,sources,decisions:state.expertCases,catalog:state.db.catalog,library:state.methodology?.materials,role:state.account?.role}),'sources','Правовая база');
 return shell(head(x?'Источники этого запуска':'Правовая база',x?meta(x):'Нормативные источники, учебные документы и методические материалы')+`<div class="stack">${notice('Правовые основания требуют проверки','Непроверенные и отключённые записи не используются в новых запусках. Изменения базы не меняют сохранённые результаты.')}${x?card('Текст документа',`${x.d.name} · v.${x.v.number}. Используется для цитат и контекста, не заменяет норму права.`,'',`<div class="actions">${sourceDownload(x.d,x.v)}</div>`):''}${sources.map(s=>`<section class="card stack tight"><h2>${esc(s.title)}</h2><p class="muted">${s.scope==='project'?'Общая база проекта · ':''}${s.active?'Включён':'Отключён'} · ${s.verified?'Проверен экспертом':'Ожидает проверки'} · ${esc(s.revision)}</p><p>${esc(s.applicability)}</p><a class="source-link" href="${esc(s.url)}" target="_blank" rel="noreferrer">Открыть оригинал источника</a><details><summary>Текст источника</summary><p>${esc(s.text)}</p></details><div class="actions">${!x?A('/api/sources/'+s.id+'/download','Скачать сохранённый текст','','download'):''}${canEdit?B('source-edit','Редактировать','',`data-source="${s.id}"`)+(!s.verified?B('source-verify','Подтвердить проверку','',`data-source="${s.id}"`):'')+B('source-toggle',s.active?'Исключить из новых проверок':'Включить','',`data-source="${s.id}"`):''}</div></section>`).join('')||card('Источники пока не добавлены','Эксперт может наполнить общую нормативную базу.')}<div class="actions">${x?A('#results/'+x.r.id,'К результатам','primary'):canEdit?B('source-new','Добавить источник','primary'):''}</div><details class="coverage"><summary>Рабочий каталог · 12 факторов</summary><p class="muted">${esc(state.db.catalog.note)}</p><div class="coverage-body">${state.db.catalog.factors.map(f=>`<p>${esc(f.id)} / ${esc(f.title)} · п. ${esc(f.locator)}</p>`).join('')}</div><a href="${esc(state.db.catalog.source)}" class="source-link" target="_blank" rel="noreferrer">Методика · открыть источник</a></details></div>`,'sources',x?'Источники проверки':'Правовая база');
}

function newExamplePage() {if(state.account?.role!=='expert'&&!state.account?.local)return missing();return shell(`${head('Добавить пример','Новый пример для ИИ')}<form id="new-example-form" class="stack">${notice('Черновик для проверки','Пример не используется в анализе до проверки правового основания и применимости.')}${field('problem','Проблема','',{area:true,required:true,max:3000})}${field('proposal','Способ исправления','',{area:true,required:true,max:10000})}${field('criterion','Критерий проверки','',{area:true,required:true,max:3000})}<div class="actions"><button type="submit" class="btn primary">Сохранить черновик</button>${A('#examples','Отмена')}</div></form>`,'examples','Добавить пример');}
function examplesPage() {const examples=state.db.examples.filter(e=>[e.title,e.quote,e.explanation,e.applicability,e.origin].join(' ').toLowerCase().includes(state.exampleSearch.toLowerCase()));return shell(`${head('Примеры для ИИ','Отдельные разобранные замечания для последующих проверок')}${state.account?.role==='expert'||state.account?.local?'<div class="actions">'+A('#example-new','Добавить пример','primary')+'</div>':''}<section class="card examples-explanation"><p><strong>История проверок</strong> хранит все запуски и их результаты.</p><p><strong>Пример для ИИ</strong> — одно решение специалиста, которое отдельно сохранено вместе с основанием и областью применения. После проверки его можно передавать модели как аналогию для похожих случаев.</p><p>Это необязательный инструмент настройки методики, а не ещё один список проверенных документов.</p></section><div class="stack">${notice('Применимость требует проверки','Непроверенные и отключённые примеры исключены из анализа.')}<label class="field"><span>Поиск по примерам</span><input id="example-search" aria-label="Поиск по примерам" value="${esc(state.exampleSearch)}" placeholder="Пункт, фактор или ключевое слово"></label></div><div class="example-list">${examples.map(e=>card(e.title,`${!e.active?'Отключён':e.verified?'Проверен':'Ожидает проверки'} · автор: ${e.author} · ${e.verified&&e.active?'используется в новых проверках':'в анализе не используется'}`,`#example/${e.id}`)).join('')||card(state.db.examples.length?'Ничего не найдено':'Пока нет примеров',state.db.examples.length?'Измените поисковый запрос.':'Нажмите «Добавить пример» (для эксперта) или сохраните подтверждённое решение. Затем проверьте основания и применимость.')}</div><div class="actions review-actions">${A('#methodology','Назад к работе ИИ агентов')}</div>`,'examples','Примеры для ИИ');}
function examplePage(id,edit=false,disable=false) {const e=state.db.examples.find(e=>e.id===id);if(!e)return missing();if(disable)return shell(`${head('Отключить пример','Запись останется в библиотеке')}<div class="stack">${notice('Пример не будет использоваться в анализе','История решений сохраняется. Запись можно снова включить после проверки.')}<div class="actions">${B('example-disable','Отключить','primary',`data-example="${id}"`)}${A(`#example/${id}`,'Отмена')}</div></div>`,'examples','Отключить пример');const available=state.db.sources.filter(s=>s.active&&s.verified);return shell(`${head(edit?'Изменить пример':'Пример решения',e.title)}<div class="stack">${notice(!e.active?'Пример отключён':e.verified?'Проверен специалистом':'Ожидает проверки',e.verified&&e.active?'Включён в новые проверки.':'Запись не используется в анализе.')}${edit?`<form id="example-form" class="form-layout" data-example="${id}">${field('explanation','Объяснение',e.explanation,{area:true,rows:4,required:true})}${field('applicability','Контекст и область применения',e.applicability,{area:true,rows:3,required:true})}<section class="card stack tight"><h3>Связанные проверенные источники</h3>${available.map(s=>`<label class="radio"><input type="checkbox" name="sourceIds" value="${s.id}" ${e.sourceIds.includes(s.id)?'checked':''}>${esc(s.title)} · ${esc(s.revision)}</label>`).join('')||'<p>Сначала добавьте и проверьте источник.</p>'}</section>${notice('После изменения нужна повторная проверка','До подтверждения запись исключена из анализа.')}<label class="radio"><input type="checkbox" name="verified" ${!available.length?'disabled':''}>Подтверждаю основание и применимость</label><div class="actions"><button type="submit" class="btn primary">Сохранить изменения</button>${A(`#example/${id}`,'Отмена')}</div></form>`:`${card('Контекст и цитата',e.origin+'\n'+e.quote)}${card('Объяснение',e.explanation)}${card('Контекст и область применения',e.applicability)}${card('Предлагаемая редакция',e.proposal||'Правка не предложена')}${e.criterion?card('Критерий проверки',e.criterion):''}${card('Правовое основание',e.sourceIds.map(id=>{const s=state.db.sources.find(s=>s.id===id);return s?`${s.title} · ${s.revision}`:'Источник не найден';}).join('\n')||'Не заполнено. Запись исключена из анализа.')}<div class="actions">${A(`#example-edit/${id}`,'Изменить','primary')}${e.active?A(`#example-disable/${id}`,'Отключить'):B('example-enable','Включить','',`data-example="${id}"`)}${A('#examples','Назад')}</div>`}</div>`,'examples',edit?'Изменить пример':'Пример решения');}
function saveExamplePage(id,index) {const x=locate(id),f=x?.r.findings[Number(index)];if(!f||f.decision.status!=='confirmed')return missing();return shell(`${head('Сохранить как пример','Решение текущей проверки')}<form id="save-example-form" class="stack" data-run="${id}" data-finding="${f.id}" data-revision="${f.decision.revision}">${notice('Сохранение не подтверждает основание','Запись будет создана со статусом «Ожидает проверки» и не попадёт в анализ автоматически.')}${field('applicability','Контекст и область применения','Муниципальные административные регламенты',{area:true,rows:3,required:true,max:3000})}${card('Правовое основание',f.decision.basis||'Не заполнено — требуется проверка')}<div class="actions"><button type="submit" class="btn primary">Сохранить на проверку</button>${A(`#report/${id}`,'Назад')}</div></form>`,'examples','Сохранить как пример');}
function fileErrorPage() {return shell(`${head(state.fileError?.title||'Файл не подготовлен')}<div class="stack">${notice(state.fileError?.title||'Не удалось прочитать файл',state.fileError?.message||'Выберите DOCX или вставьте текст.','error')}<div class="actions">${B('retry-upload','Выбрать DOCX','primary')}${B('error-paste','Вставить текст')}${A('#documents','К документам')}</div></div>`,'documents','Добавление документа');}
async function loadCaseHistory(){
 const accountId=state.account?.id;
 if(!accountId)return;
 state.caseHistory={accountId,loading:true};
 try{
   const {cases}=await api('expert-cases/history');
   if(state.account?.id===accountId)state.caseHistory={accountId,cases};
 }catch(error){
   if(state.account?.id===accountId)state.caseHistory={accountId,error:error.message};
 }
}
function caseHistoryPage(){
 const history=state.caseHistory;
 if(!history){
   void loadCaseHistory().then(()=>{if(currentToken()==='case-history')render();});
 }
 const entries=history?.cases?.map(c=>card(
   c.name,c.unlinked?'Старое дело без привязки к аккаунту.':[
     c.kind,c.version?'Версия '+c.version:null,'Учебное дело · только просмотр'
   ].filter(Boolean).join(' · '),
   c.unlinked?'':'#expert-case/'+c.id
 )).join('');
 const content=history?.error?notice('Не удалось загрузить историю',history.error,'error')+B('retry-case-history','Повторить','compact'):
   !history||history.loading?'<p role="status">Загружаем историю…</p>':entries||card('В истории пока нет учебных дел','Здесь появятся архивные дела, в которых вы участвовали.');
 return shell(head('История проверок','Учебные экспертные дела')+`<div class="stack">${content}</div>`,'case-history','История проверок');
}
function expertHome(){
 return shell(head('НПА на экспертизу','Документы, доступные вам для проведения экспертизы')+expertShowcase(state.expertCases||[],state.expertCatalog||{}),'experts','Главная');
}
function expertConclusionsPage(){
 const cases=(state.expertCases||[]).filter(c=>!c.isDemo);
 return shell(head('Мои дела')+`<div class="stack">
   <div class="actions">${B('refresh-expert-cases','Обновить список','compact')}${A('#case-history','История проверок','compact')}</div>
   ${expertList(cases,state.queueFilter||'all')}
 </div>`,'expert-done','Мои дела');
}
function needsMethodology(){
 const page=currentToken();
 return ['methodology','materials','source-materials','quality'].includes(page) ||
   state.account?.role==='admin'&&!['home','login','register'].includes(page)&&!pathFor(page).startsWith('/#');
}
function loadMethodology(){
 if(state.methodology)return Promise.resolve(state.methodology);
 state.methodologyRequest ||= api('methodology').then(data=>{
   state.methodology=data;
   state.methodologyError='';
   return data;
 }).catch(error=>{
   state.methodologyError=error.message;
   return null;
 }).finally(()=>{state.methodologyRequest=null;});
 return state.methodologyRequest;
}
function methodologyPlaceholder(){
 return state.methodologyError
   ? notice('Не удалось загрузить материалы',state.methodologyError,'error')+B('retry-methodology','Повторить','compact')
   : '<p role="status" class="muted">Загружаем материалы…</p>';
}
function render() {if(!state.account||['home','login','register'].includes(currentToken())||pathFor(currentToken()).startsWith('/#')){const page=currentToken();paintApp(page==='register'?registrationPage(state.error,new URLSearchParams(location.search).get('role')==='expert'?'expert':'official'):page==='login'?loginPage(state.error,state.demoLogin):['restore','privacy','terms'].includes(page)?infoPage(page):page==='not-found'?'<main id="main-content" class="login-screen"><h1>Страница не найдена</h1><a href="/">На главную</a></main>':landingPage(state.error));return;}if(!state.db)return;
 if(needsMethodology()&&!state.methodology&&!state.methodologyRequest&&!state.methodologyError){
   void loadMethodology().then(()=>{if(state.db&&needsMethodology())render();});
 }
 if(currentToken()==='case-history'){
 paintApp(caseHistoryPage());return;
 }if(state.account.role==='admin'){paintApp(shell(head('Администрирование')+aiConnectionCard()+(state.methodology?methodologyContent(state.methodology):methodologyPlaceholder()),'methodology','Работа ИИ агентов'));fitFields();return;}if(!state.db.profile?.fullName||route()[0]==='profile'){if(currentToken().startsWith('expert-invite/'))state.profileReturn=currentToken();paintApp(shell(profilePage(state.db.profile,state.account,state.error),'profile','Мой профиль'));return;}const [page,id,n]=route();if(state.account.role==='expert'&&!['overview','experts','expert-case','expert-invite','sources','source-samples','source-materials','source-decisions','case-history','samples','methodology','materials','quality','profile','notifications','expert-done','expert-statistics','examples','example','example-new','example-edit','example-disable','example-saved'].includes(page)){paintApp(expertHome());return;}const html=page==='expert-statistics'&&state.account.role==='expert'?shell(head('Моя статистика')+expertOverview(state.expertCases||[],viewOptions()),'expert-statistics','Моя статистика'):page==='notifications'?notificationsPage():page==='run-confirm'?runConfirmation(id,n):page==='expert-done'&&state.account.role==='expert'?expertConclusionsPage():page==='overview'&&state.account.role==='expert'?expertHome():page==='overview'?shell(overview(state.db,state.expertCases||[],viewOptions()),'overview','Кабинет'):page==='experts'?(state.account.role==='expert'?expertHome():shell(head('Экспертные заключения')+expertList(state.expertCases||[],state.queueFilter||'all'),'experts','Экспертные заключения')):page==='expert-invite'?shell(head('Приглашение эксперта')+invitationForm(id,n,state.account?.displayName),'experts','Приглашение'):page==='expert-case'?expertPage(id):page==='methodology'?shell(head('Работа ИИ агентов')+aiConnectionCard()+(state.methodology?methodologyContent(state.methodology):methodologyPlaceholder())+'<section class="card stack tight examples-explanation"><h2>Новые примеры для ИИ</h2><p>Пополняемая база разобранных замечаний, которые специалист разрешил использовать как аналогии. До проверки правового основания и применимости новые примеры не используются в анализе.</p><div class="actions">'+A('#examples','Открыть')+'</div></section>','methodology','Работа ИИ агентов'):page==='source-decisions'?sourcesPage(undefined,'decisions'):page==='materials'||page==='source-materials'?sourcesPage(undefined,'materials'):page==='quality'?shell(head('Контрольные примеры')+`<div class="actions">${A('#methodology','Назад к работе ИИ агентов')}</div>`+(state.methodology?qualityContent(state.methodology.qualityCases):methodologyPlaceholder()),'methodology','Контрольные примеры'):page==='run-details'?(locate(id)?shell(head('Состав и ход проверки')+`<div class="actions">${A('#results/'+id,'Назад к результатам')}</div>`+runDetailsContent(locate(id)),'documents','Состав запуска'):missing()):page==='samples'||page==='source-samples'?sourcesPage(undefined):page==='upload'?uploadPage(false):page==='paste'?uploadPage(true):page==='version'?uploadPage(false,id):page==='version-text'?uploadPage(true,id):page==='prepare'?preparePage(id,n):page==='rerun'?preparePage(id,n,true):page==='graph'?graphPage(id):page==='provision'?provisionPage(id,n):page==='results'?resultsPage(id):page==='run'?runPage(id):page==='reject'?rejectPage():page==='history'?historyPage(id):page==='report'?reportPage(id):page==='export'?exportPage(id):page==='export-ready'?exportPage(id,true):page==='sources'?sourcesPage(id):page==='example-new'?newExamplePage():page==='examples'?examplesPage():page==='example'?examplePage(id):page==='example-edit'?examplePage(id,true):page==='example-disable'?examplePage(id,false,true):page==='save-example'?saveExamplePage(id,n):page==='example-saved'?shell(head('Пример сохранён')+notice('Запись ожидает проверки','До проверки правового основания и применимости пример не используется в анализе.')+`<div class="actions review-actions">${A('#example/'+id,'Открыть пример','primary')}${A('#examples','К примерам')}</div>`,'examples','Пример сохранён'):page==='file-error'?fileErrorPage():dashboard();paintApp(html);fitFields();}
function aiConnectionCard(){
 if(state.account?.role!=='admin')return '';
 const cfg=state.db.config,canManage=cfg.hosted?state.account?.role==='admin'&&cfg.canManage===true:state.account?.role==='official';
 return (cfg.storage?.recoveryAvailable?'<section class="card stack tight"><h2>Восстановление документов</h2><p>Документы и результаты прежних проверок можно восстановить из сохранённого архива. Уже существующие документы останутся без изменений. Профили, поздние решения, экспертные дела и прежнее API-подключение в этот архив не входят.</p><div class="actions">'+B('storage-recover','Восстановить документы из архива')+'</div></section>':'')+'<section class="card stack tight"><h2>API-подключение</h2><p>'+esc(cfg.configured?'Общее подключение настроено. Три агента используют выбранную модель.':'API-ключ пока не подключён. Для анализа своего документа нужно настроить подключение.')+'</p>'+(cfg.configured?'<p class="muted">Модель: '+esc(cfg.model||cfg.connection?.model||'не указана')+'</p>':'')+(canManage?'<div class="actions">'+B('settings',cfg.configured?'Настроить API-подключение':'Добавить API-ключ','primary')+'</div><p class="muted">Ключ сохраняется на сервере. В настройках можно выбрать провайдера, указать ID модели и добавить или удалить общий ключ.</p>':'<p class="muted">Общий API-ключ добавляет и изменяет администратор. Сохранённый ключ не показывается пользователям.</p>')+'</section>';
}
function settings() {
 const cfg=state.db.config;
 if(cfg.shared&&!cfg.canManage){modal('Общее подключение ИИ',notice(cfg.configured?'API подключён для всех посетителей':'Общий API ещё не настроен',cfg.configured?'Можно запускать реальные проверки. Ключ скрыт; расходы оплачивает владелец подключения.':'Владелец подключения должен один раз сохранить API-ключ.')+(cfg.configured?card('Выбранная модель',cfg.model):'')+notice('Настройки доступны владельцу','Посетители по обычной ссылке не могут увидеть, заменить или отключить ключ.'));return;}
 const preset=cfg.providers.find(p=>p.id==='polza'),c=cfg.configured?cfg.connection:cfg.shared&&cfg.personalConfigured?cfg.personalConnection:{...cfg.connection,...preset,provider:'polza',model:''};
 modal('Подключение ИИ',`<form id="settings-form" class="stack">${notice(cfg.shared?'Общее подключение для всех':'Личное подключение',cfg.shared?'Ключ хранится на сервере в зашифрованном виде без срока истечения. Все посетители по ссылке могут использовать его для проверок. Расходы списываются с этого ключа. Менять настройки может только владелец. Удаление общего ключа отключит его у всех посетителей.':cfg.hosted?'Ключ шифруется на сервере и доступен только вашему рабочему пространству. Он не возвращается в интерфейс и действует до ручного отключения.':'Ключ хранится в памяти локального сервера до перезапуска.')}${notice('Статус подключения',cfg.configured?'Подключение сохранено. Ключ не проверялся запросом к провайдеру.':'Выберите провайдера, вставьте ID модели из его кабинета и API-ключ. Адрес и формат для Польза AI заполняются автоматически.')}<label class="field"><span>Провайдер</span><select name="provider">${cfg.providers.map(p=>`<option value="${esc(p.id)}" ${p.id===c.provider?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label><div id="custom-api-fields" class="stack tight" ${c.provider!=='custom'?'hidden':''}>${field('baseUrl','Базовый адрес API',c.baseUrl,{type:'url',max:1000,required:true,readonly:c.provider!=='custom',placeholder:'https://api.example.com/v1'})}<label class="field"><span>Формат API</span><select name="protocol" ${c.provider!=='custom'?'disabled':''}>${cfg.protocols.map(p=>`<option value="${esc(p.id)}" ${p.id===c.protocol?'selected':''}>${esc(p.title)}</option>`).join('')}</select></label></div>${field('model','ID модели',c.model,{required:true,max:200,placeholder:'Например: deepseek/deepseek-v4.1-flash-1017'})}<small>Скопируйте точный ID текстовой модели из кабинета выбранного провайдера.</small>${field('key','API-ключ','',{type:'password',max:8192,placeholder:cfg.configured?'Пусто — оставить текущий ключ':'Введите ключ выбранного провайдера'})}<div id="api-workspace-field" ${c.protocol!=='anthropic'?'hidden':''}>${field('workspaceId','Workspace ID — если требуется',c.workspaceId||'',{max:100})}</div><details><summary>Параметры совместимости</summary><div class="stack tight"><label class="radio"><input type="checkbox" name="jsonMode" ${c.jsonMode?'checked':''}>Запрашивать JSON-режим API</label><small>Если API не поддерживает этот параметр, отключите его. Проверка ответа JSON в приложении остаётся включённой.</small><label id="api-token-budget" class="field" ${c.protocol==='anthropic'?'':'hidden'}><span>Максимум токенов (требуется Anthropic)</span><input type="number" name="maxTokens" min="1" value="${c.maxTokens??8192}" required ${c.protocol==='anthropic'?'':'disabled'}></label></div></details><small>Документ и проверенные источники передаются выбранному провайдеру. При смене сервиса введите его ключ заново. Сохранение не выполняет платный запрос. Очистка cookies лишит доступа к рабочему пространству.</small><label class="radio"><input type="checkbox" name="clear">${cfg.shared?'Удалить общий ключ у всех':'Удалить подключённый ключ'}</label><button type="submit" class="btn primary">Сохранить настройки</button></form>`);
}
function updateProtocolFields(form,protocol) {
 const anthropic=protocol==='anthropic';
 $('#api-workspace-field').hidden=!anthropic;
 $('#api-token-budget').hidden=!anthropic;
 form.elements.maxTokens.disabled=!anthropic;
}
function updateProviderForm(form) {
 const provider=form.elements.provider.value,preset=state.db.config.providers.find(p=>p.id===provider);
 $('#custom-api-fields').hidden=provider!=='custom';
 form.elements.baseUrl.value=preset.baseUrl; form.elements.baseUrl.readOnly=provider!=='custom';
 form.elements.protocol.value=preset.protocol; form.elements.protocol.disabled=provider!=='custom';
 form.elements.model.value='';
 form.elements.key.value=''; form.elements.key.placeholder='Введите ключ выбранного провайдера';
 form.elements.jsonMode.checked=provider!=='custom';
 updateProtocolFields(form,preset.protocol);
}
function sourceForm(source=null) {if(state.account?.role!=='expert')return;modal(source?'Редактировать источник':'Добавить нормативный источник',`<form id="source-form" class="source-editor stack" data-source="${esc(source?.id||'')}"><p class="library-note">Источник будет доступен всем пользователям. В анализ включаются только проверенные источники.</p><section class="source-editor-section"><h3>Реквизиты</h3>${field('title','Название',source?.title||'',{required:true,max:250,placeholder:'Название нормативного акта'})}<div class="source-editor-grid">${field('url','Ссылка на оригинал',source?.url||'',{required:true,type:'url',max:2000,placeholder:'https://…'})}${field('revision','Редакция и дата действия',source?.revision||'',{required:true,max:250,placeholder:'Дата и сведения о редакции'})}</div></section><section class="source-editor-section"><h3>Содержание и применимость</h3>${field('applicability','Область применения',source?.applicability||'',{required:true,area:true,rows:2,max:3000,placeholder:'Территория, круг лиц, предмет регулирования и ограничения'})}${field('text','Точный текст используемых норм',source?.text||'',{required:true,area:true,rows:7,max:30000})}</section><div class="source-editor-confirm"><label class="radio"><input type="checkbox" name="verified">Я проверил текст, редакцию и применимость</label><p class="library-note">Без этой отметки источник сохраняется для последующей проверки. Изменение содержания требует повторного подтверждения.</p></div><button type="submit" class="btn primary">${source?'Сохранить изменения':'Добавить источник'}</button></form>`);}
function resetUpload(docId='') {state.upload={name:'',text:'',fileName:'',uploadId:null,comment:'',docId};state.fileError=null;}
function readUploadForm() {const form=$('#upload-form');if(!form)return;state.upload={...(state.upload||{}),...Object.fromEntries(new FormData(form)),docId:form.dataset.doc};}
async function loadFile(file) {if(!file)return;readUploadForm();const docId=state.upload?.docId||'';try{if(file.size>3*1024*1024)throw Error('Максимальный размер DOCX — 3 МБ.');if(!file.name.toLowerCase().endsWith('.docx'))throw Error('Добавьте DOCX или вставьте текст. PDF и сканы пока не поддерживаются.');const status=$('#file-status');if(status)status.textContent='Подготавливаем текст…';const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);const data=await api('extract',{fileName:file.name,base64:btoa(binary)});state.upload={...state.upload,...data,name:state.upload.name||(data.text.split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!/^(УЧЕБНЫЙ ПРИМЕР|Демонстрационный документ)/i.test(s))||file.name.replace(/\.docx$/i,'')).slice(0,180),docId,uploadMessage:`${file.name} · ${data.text.length.toLocaleString('ru-RU')} символов. Текст и оригинал подготовлены.`};render();}catch(error){state.fileError={title:/нет текста|пуст/i.test(error.message)?'В документе нет текста':'Файл не подготовлен',message:error.message,docId};state.upload.uploadId=null;go('file-error');}}
async function saveDecision(statusValue,reason='') {const x=target();if(!x?.f||isArchived(x.d,x.r))throw Error('Архивный запуск доступен только для чтения.');if(['confirmed','modified'].includes(statusValue))capture($('#decision-form'));const draft=decisionDraft(x);await api(`runs/${x.r.id}/findings/${x.f.id}`,{status:statusValue,revision:draft.revision,explanation:statusValue==='rejected'?reason:draft.explanation,proposal:statusValue==='rejected'?'':draft.proposal,basis:draft.basis,comment:draft.comment||'',factorIds:draft.factorIds},'PUT');clearDraft();await refresh();toast('Решение сохранено');const next=nextPendingIndex(locate(x.r.id).r,x.index);go(next>=0?`run/${x.r.id}/${next}`:`report/${x.r.id}`);}
async function exportFile(id) {state.exportError='';try{const response=await fetch(`/api/runs/${id}/report.docx`);if(!response.ok){const body=await response.json();throw Error(body.error||'Повторите формирование файла.');}if(!response.headers.get('content-type')?.includes('wordprocessingml'))throw Error('Сервер не вернул документ Word. Повторите попытку.');const blob=await response.blob();if(!blob.size)throw Error('Получен пустой файл. Повторите попытку.');if(state.exportFile)URL.revokeObjectURL(state.exportFile.url);const encodedName=response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];if(!encodedName)throw Error('Сервер не вернул имя отчёта. Повторите попытку.');const name=decodeURIComponent(encodedName);state.exportFile={id,url:URL.createObjectURL(blob),name};go('export-ready/'+id);}catch(error){state.exportError=error.message;state.exportErrorRun=id;render();}}
async function refreshExpertCases(){
 const accountId=state.account?.id;
 const {cases}=await api('expert-cases');
 if(state.account?.id!==accountId)return false;
 const changed=JSON.stringify(cases)!==JSON.stringify(state.expertCases);
 state.expertCases=cases;
 const waiting=cases.some(c=>!c.isDemo&&c.status==='waiting');
 for(const dot of document.querySelectorAll('[data-expert-queue-dot]'))dot.hidden=!waiting;
 return changed;
}
const handlers={
 'history-select':b=>{state.historySelection={...state.historySelection,[b.dataset.doc]:{versionId:b.dataset.version,runId:b.dataset.run||null}};render();},
 'retry-case-history':async()=>{await loadCaseHistory();render();},
 'expert-catalog-level':b=>{const form=b.closest('form');state.expertCatalog={query:form.elements.query.value,level:b.dataset.level,region:'',municipality:''};render();},
 'expert-catalog-clear-query':()=>{state.expertCatalog={...state.expertCatalog,query:''};render();},
 'expert-catalog-reset':()=>{state.expertCatalog={};render();},
 'refresh-expert-cases':async()=>{await refreshExpertCases();render();},
 'demo-login':async b=>{
   state.error='';
   const session=await api('auth/demo-login',{role:b.dataset.role});
   await refresh({knownSession:session});
   if(!state.account || state.account.id!==session.user?.id)throw Error('Не удалось открыть выбранный кабинет. Попробуйте войти ещё раз.');
   navigate(state.account.role==='admin'?'methodology':state.account.role==='expert'?'experts':'overview',{replace:true});
 },

 'queue-filter':b=>{state.queueFilter=b.dataset.filter;render();},
 'graph-build':async b=>{await api('runs/'+b.dataset.run+'/provision-graph',{});await refresh();render();},
 'edit-structure':b=>{const d=state.db.documents.find(d=>d.id===b.dataset.doc),v=d.versions.find(v=>v.id===b.dataset.version);state.upload={docId:d.id,name:d.name,text:v.text,fileName:'Вставленный текст',uploadId:null,comment:'Исправлены текст или нумерация перед проверкой'};go('version-text/'+d.id);},
 'retry-methodology':async()=>{state.methodologyError='';await loadMethodology();render();},
 'show-methodology':async()=>{const data=await loadMethodology();if(!data)throw Error(state.methodologyError);modal('Работа ИИ агентов',methodologyContent(data));},
 'sample-start':async b=>{const sample=b.dataset.sample==='canonical'?{title:'Эталонный учебный регламент',text:state.db.sampleText}:SAMPLE_DOCUMENTS.find(x=>x.id===b.dataset.sample);if(!sample)throw Error('Пример не найден.');let doc=state.db.documents.find(d=>d.sample&&d.name===sample.title&&d.versions.at(-1).text===sample.text);if(!doc){const created=await api('documents',{name:sample.title,text:sample.text});await refresh();doc=state.db.documents.find(d=>d.id===created.id);}go('prepare/'+doc.id+'/'+doc.versions.at(-1).id);},
 'basis-pick':()=>{capture($('#decision-form'));const sources=state.db.sources.filter(s=>s.active&&s.verified);modal('Выбор проверенного основания',sources.length?sources.map(source=>'<section class="card stack tight"><h3>'+esc(source.title)+'</h3><p>'+esc(source.revision)+'</p><details><summary>Показать текст</summary><p class="sample-text">'+esc(source.text)+'</p></details>'+B('basis-use','Выбрать цитату','compact',`data-source="${esc(source.id)}"`)+'</section>').join(''):notice('Нет проверенных источников','Классификация по Методике показана отдельно. Добавьте проверенный источник или укажите обоснование вручную.'));},
 'basis-use':b=>{const source=state.db.sources.find(s=>s.id===b.dataset.source);modal('Цитата правового основания',`<form id="basis-select-form" class="stack" data-source="${esc(source.id)}"><h3>${esc(source.title)}</h3><p>${esc(source.revision)}</p><details><summary>Текст источника</summary><p class="sample-text">${esc(source.text)}</p></details>${field('quote','Скопируйте точную цитату применимой нормы','',{area:true,required:true,max:8000})}<button type="submit" class="btn primary">Использовать основание</button></form>`);},
 new:()=>leave(()=>{resetUpload();go('upload');}),
 'expert-conclusion-open':b=>{state.expertTab={caseId:b.dataset.case,tab:'conclusion'};go('expert-case/'+b.dataset.case);},
 version:b=>leave(()=>{resetUpload(b.dataset.doc);go('version/'+b.dataset.doc);}),
 'sidebar-toggle':button=>{state.sidebarCollapsed=!state.sidebarCollapsed;$('.shell').classList.toggle('sidebar-collapsed',state.sidebarCollapsed);const label=state.sidebarCollapsed?'Развернуть панель':'Свернуть панель';button.setAttribute('aria-label',label);button.title=label;button.setAttribute('aria-expanded',String(!state.sidebarCollapsed));},
 menu:()=>{state.menu=!state.menu;$('.shell').classList.toggle('menu-open',state.menu);$('#mobile-nav').classList.toggle('open',state.menu);const button=$('[data-action="menu"]');button.textContent=state.menu?'Закрыть меню':'Меню';button.setAttribute('aria-expanded',String(state.menu));if(state.menu)$('#mobile-nav [data-action="menu"]')?.focus();else button.focus();},
 settings,'modal-close':closeModal,
 logout:()=>leave(async()=>{await api('auth/logout',{});location.replace('/login');}),
 'expert-open':b=>{closeModal();go('expert-case/'+b.dataset.case);},
 'report-version':b=>{closeModal();go(b.getAttribute('href').slice(1));},
 'report-repeat':b=>{
  const x=locate(b.dataset.run);if(!x)return;
  modal('Какую версию проверить?',`<p>${esc(x.d.name)} · версия ${esc(x.v.number)}</p><p>Принятые замечания не внесены в исходный текст автоматически. Выберите сохранённую версию или добавьте исправленный документ.</p><div class="actions">${A('#rerun/'+x.d.id+'/'+x.v.id,'Проверить сохранённую версию','primary','data-action="report-version"')}${A('#version/'+x.d.id,'Загрузить исправленный документ','','data-action="report-version"')}${A('#version-text/'+x.d.id,'Вставить исправленный текст','','data-action="report-version"')}</div>`);
 },
 'expert-create':async b=>{
 const x=locate(b.dataset.run),experts=state.db.config.experts||[],pending=counts(x.r).pending;
 if(x.r.findings.some(f=>!['confirmed','modified','rejected'].includes(f.decision?.status)||!hasSavedDecision(f))){toast('Сначала сохраните решение по каждому замечанию.');return;}
 const existing=(state.expertCases||[]).find(c=>c.runId===x.r.id);
 if(existing){go('expert-case/'+existing.id);return;}
 const transferSummary=`<p><strong>${esc(x.d.name)}</strong> · версия документа ${esc(String(x.v.number))} · проверка № ${esc(String(x.r.number||x.r.id))}</p><p>Передаются снимок документа, результаты этой проверки ИИ и сохранённые решения специалиста. Последующие изменения не меняют переданный снимок.</p>`;
 if(state.pilotMode&&!x.r.findings.length){const c=await api('expert-cases',{runId:x.r.id});await refresh();go('expert-case/'+c.id);return;}
 if(state.pilotMode){
   modal('Отправить в очередь экспертов',`<form id="expert-assign-form" class="stack" data-run="${x.r.id}">
     ${transferSummary}<p>Дело появится в общей очереди кабинета эксперта.</p>
     ${field('comment','Сопроводительный комментарий','',{area:true,max:3000})}
     <button type="submit" class="btn primary">Отправить в очередь</button>
   </form>`);
   return;
 }
 modal('Запрос независимой экспертизы',`<form id="expert-assign-form" data-run="${x.r.id}" class="stack">${transferSummary}<label class="field"><span>Приглашённый эксперт</span><select name="expertAccountId">${experts.map(e=>`<option value="${esc(e.id)}">${esc(e.displayName)} · ${esc(e.username)}</option>`).join('')}<option value="">Создать персональную ссылку приглашения</option></select></label>${field('comment','Сопроводительный комментарий','',{area:true,max:3000})}<p class="muted">Регистрация аккаунта не подтверждает аккредитацию. Это демонстрация экспертного модуля этапа 3.</p><button class="btn primary" type="submit">Передать эксперту</button></form>`);},
 'expert-start':async b=>{try{await api('expert-cases/'+b.dataset.case+'/start',{});}catch(error){if([403,404,409].includes(error.status)){await refresh();throw new Error('Дело уже недоступно. Витрина обновлена.');}throw error;}await refresh();render();},
 'expert-invite':async b=>showExpertInvitation(await api('expert-cases/'+b.dataset.case+'/invite',{})),
 'storage-recover':async()=>{const result=await api('storage/recover',{});await refresh();render();toast('Восстановлено документов: '+result.documents+', проверок: '+result.runs+'. '+result.notice);},
 'expert-refresh':async b=>{if(state.dirty){toast('Сначала сохраните черновик заключения.');return;}state.expertCase=await api('expert-cases/'+b.dataset.case);await refresh();render();},
 'expert-sign':async b=>{const form=$('#expert-draft-form'),c=state.expertCase,records=readExpertDecisions(form?.elements.text.value||'');if(c.run.findings.some((f,i)=>!records.has(i+1))){toast('Рассмотрите все замечания перед завершением.');return;}if(state.dirty||form?.elements.text.value!==c.conclusions.at(-1).text){toast('Сначала сохраните черновик заключения.');return;}modal('Отправить заключение?',notice('После отправки изменить эту версию будет нельзя','Будут зафиксированы сохранённый текст, автор и время подтверждения. Это подтверждение внутри системы, а не квалифицированная электронная подпись.'),B('modal-close','Вернуться')+B('expert-sign-confirm','Отправить','primary',`data-case="${b.dataset.case}" data-revision="${b.dataset.revision}"`));},
 'expert-sign-confirm':async b=>{await api('expert-cases/'+b.dataset.case+'/sign',{revision:Number(b.dataset.revision)});closeModal();await refresh();render();toast('Заключение подтверждено экспертом. Версия закрыта для изменений.');},
 'expert-new-draft':async b=>{await api('expert-cases/'+b.dataset.case+'/new-draft',{});await refresh();render();},
 'delete-personal-key':async()=>{await api('settings/personal',{},'DELETE');closeModal();await refresh();render();toast('Прежний личный ключ удалён из системы.');},
 discard:async()=>{const proceed=state.pendingLeave;closeModal();clearDraft();await proceed?.();},
 'upload-switch':b=>{if($('#upload-form')?.dataset.paste===b.dataset.paste)return;readUploadForm();const paste=b.dataset.paste==='true',doc=b.dataset.doc;state.upload.uploadId=null;state.upload.fileName='';go(doc?(paste?'version-text/':'version/')+doc:paste?'paste':'upload');},
 'load-sample':()=>{readUploadForm();state.upload={...state.upload,text:state.db.sampleText,name:state.upload.name||'Порядок выдачи разрешения',fileName:'',uploadId:null};go(state.upload.docId?'version-text/'+state.upload.docId:'paste');},
 'retry-upload':()=>go(state.fileError?.docId?'version/'+state.fileError.docId:'upload'),
 'error-paste':()=>go(state.fileError?.docId?'version-text/'+state.fileError.docId:'paste'),
 confirm:()=>saveDecision('confirmed'),
 'confirm-modified':()=>{
  const x=target();if(!x?.f||isArchived(x.d,x.r)||x.r.status!=='completed')return;
  const proposal=$('#decision-form [name="proposal"]');if(!proposal)return;
  modal(`Замечание № ${x.index+1}`,field('edited-proposal','Предлагаемая редакция',proposal.value,{area:true,rows:6}),B('save-modified','Сохранить изменённую редакцию','primary')+B('modal-close','Отмена'));
  const input=$('#modal [name="edited-proposal"]');input.focus();input.setSelectionRange(input.value.length,input.value.length);
 },
 'save-modified':async()=>{
  const input=$('#modal [name="edited-proposal"]'),proposal=$('#decision-form [name="proposal"]');if(!input||!proposal)return;
  proposal.value=input.value;await saveDecision('modified');closeModal();
 },
 'cancel-decision-edit':()=>{const x=target();if(!x?.f||isArchived(x.d,x.r)||x.r.status!=='completed')return;clearDraft();render();toast('Несохранённые изменения отменены');},
 'previous-finding':()=>navigateFinding(-1),
 'next-finding':()=>navigateFinding(1),
 'next-review':()=>{const x=target(),next=nextPendingIndex(x.r,x.index);if(next>=0&&next!==x.index)go('run/'+x.r.id+'/'+next);else toast('Других нерассмотренных замечаний нет.');},
 'reject-reason':b=>{state.rejectReason=b.dataset.reason;const input=document.querySelector('#reject-form textarea');input.value=state.rejectReason;input.focus();fitFields();},
 'archive-demo-duplicates':async()=>{const result=await api('expert-cases/archive-duplicates',{});await refresh();render();toast('Скрыто пустых учебных дублей: '+result.archived);},
 reject:()=>{capture($('#decision-form'));state.rejectReason='';const x=target();if(x.f.review?.verdict==='contested')state.rejectReason=x.f.review.counterarguments?.[0]||x.f.review.explanation;go(`reject/${x.r.id}/${x.index}`,true);},
 'reject-back':()=>{const x=target();state.rejectReason='';go(`run/${x.r.id}/${x.index}`,true);},
 'edit-focus':()=>{$('[name="explanation"]').focus();},
 'reload-decision':()=>leave(async()=>{clearDraft();await refresh();render();}),
 'example-start':()=>{if(state.dirty)throw Error('Сначала сохраните решение.');const x=target();go(`save-example/${x.r.id}/${x.index}`);},
 'example-from-report':b=>{const x=locate(b.dataset.run);const i=x.r.findings.findIndex(f=>f.id===b.dataset.finding);go(`save-example/${x.r.id}/${i}`);},
 'export-file':b=>exportFile(b.dataset.run),
 'resume-run':async b=>{const result=await api('runs/'+b.dataset.run+'/resume',{});await refresh();go('results/'+result.id);toast('Проверка продолжена с прерванного этапа.');},
 cancel:async b=>{await api(`runs/${b.dataset.run}/cancel`,{});await refresh();render();},
 'source-new':()=>sourceForm(),
 'source-edit':b=>sourceForm(state.db.sources.find(s=>s.id===b.dataset.source)),
 'source-toggle':async b=>{const s=state.db.sources.find(s=>s.id===b.dataset.source);await api(`sources/${s.id}`,{active:!s.active},'PATCH');await refresh();render();},
 'source-verify':b=>{const s=state.db.sources.find(s=>s.id===b.dataset.source);modal('Подтверждение источника',`<form id="source-verify-form" class="stack" data-source="${s.id}">${card(s.title,s.revision+' · '+s.applicability)}<div class="full-text">${esc(s.text)}</div><label class="radio"><input type="checkbox" required>Я проверил текст, редакцию и применимость</label><button type="submit" class="btn primary">Подтвердить проверку</button></form>`);},
 'example-disable':async b=>{await api('examples/'+b.dataset.example,{active:false},'PATCH');await refresh();go('example/'+b.dataset.example);},
 'example-enable':async b=>{await api('examples/'+b.dataset.example,{active:true},'PATCH');await refresh();render();},
};
async function perform(fn,button) {
 if(state.busy)return;
 state.busy=true;
 const disabled=button?.disabled;
 const roleEntry=button?.dataset.action==='demo-login';
 const label=(roleEntry&&button.querySelector('.role-entry-label strong'))||button;
 const original=label?.textContent;
 if(button){
   button.disabled=true;
   label.textContent=roleEntry||button.form?.id==='login-form'?'Входим…':button.form?.id==='register-form'?'Регистрируем…':button.form?.id==='run-form'?'Запускаем…':button.form?.id==='upload-form'?'Подготавливаем…':'Сохраняем…';
   button.setAttribute('aria-busy','true');
 }
 try { await fn(); }
 catch(error){
   const page=currentToken();
   const authPage=['login','register'].includes(page);
   state.error=error instanceof DOMException&&authPage?'Не удалось открыть кабинет. Попробуйте войти ещё раз.':error.message;
   if(error.status===409&&route()[0]==='run')state.conflict=true;
   if(authPage){
     const alert=$('#auth-error');
     if(alert){alert.textContent=state.error;alert.hidden=false;}
     else render();
   }else{render();toast(state.error);}
 }
 finally{
   state.busy=false;
   if(button?.isConnected){button.disabled=!!disabled;label.textContent=original;button.removeAttribute('aria-busy');}
 }
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button){event.preventDefault();const fn=handlers[button.dataset.action];if(fn){if(['sidebar-toggle','menu','modal-close','discard','settings','source-new','source-edit','source-verify','edit-focus'].includes(button.dataset.action)){try{const result=fn(button);if(result?.catch)result.catch(error=>toast(error.message));}catch(error){toast(error.message);}}else void perform(()=>fn(button),button);}return;}const a=event.target.closest('a[href]');if(a&&!a.target&&!a.hasAttribute('download')&&a.origin===location.origin&&!a.pathname.startsWith('/api/')){if(a.hash==='#main-content'||a.dataset.scrollTo||a.dataset.registerRole)return;event.preventDefault();go(tokenFor(a.href));}});
function filterReport(select) {
  const report = select.closest('.review-report');
  for (const remark of report.querySelectorAll('[data-report-remark]')) {
    remark.hidden = !!select.value && remark.dataset.factor !== select.value;
  }
}

document.addEventListener('change', event => {
  if (event.target.matches('[data-report-factor]')) filterReport(event.target);
});
document.addEventListener('click', event => {
  const link = event.target.closest('.report-ref');
  if (link) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const remark = document.getElementById(link.dataset.scrollTo);
    if (remark?.hidden) {
      const select = link.closest('.review-report').querySelector('[data-report-factor]');
      select.value = '';
      filterReport(select);
    }
    const heading = remark?.querySelector('h3');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
    remark?.scrollIntoView({ block: 'start' });
  }
  const copy = event.target.closest('[data-report-copy]');
  if (copy) {
    const fallback = () => toast('Скопируйте контрольную сумму из реквизитов.');
    if (!navigator.clipboard?.writeText) fallback();
    else void navigator.clipboard.writeText(copy.dataset.reportCopy)
      .then(() => toast('Контрольная сумма скопирована.'), fallback);
  }
});
document.addEventListener('input',event=>{if(event.target.tagName==='TEXTAREA')fitFields(event.target.parentElement);if(event.target.closest('#upload-form'))readUploadForm();if(event.target.closest('#decision-form'))capture(event.target.closest('#decision-form'));if(event.target.closest('#reject-form')){state.rejectReason=event.target.value;state.dirty=true;}if(['document-search','example-search'].includes(event.target.id)){const id=event.target.id,pos=event.target.selectionStart;if(id==='document-search')state.search=event.target.value;else state.exampleSearch=event.target.value;render();$('#'+id).focus();$('#'+id).setSelectionRange(pos,pos);}});
document.addEventListener('change', event => {
 const field=event.target;
 if(field.id!=='finding-status-filter')return;
 state.findingFilter={runId:field.dataset.run,status:field.value};
 render();
 $('#finding-status-filter')?.focus({preventScroll:true});
});
document.addEventListener('change',event=>{if(event.target.id==='docx-input')void perform(()=>loadFile(event.target.files[0]));const form=event.target.closest('#settings-form');if(form&&event.target.name==='provider')updateProviderForm(form);if(form&&event.target.name==='protocol')updateProtocolFields(form,form.elements.protocol.value);if(form&&event.target.name==='clear'){form.elements.model.required=!event.target.checked;form.noValidate=event.target.checked;}});
document.addEventListener('dragover',event=>{const zone=event.target.closest('#upload-zone');if(zone){event.preventDefault();zone.classList.add('dragging');}});
document.addEventListener('dragleave',event=>{const zone=event.target.closest('#upload-zone');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('dragging');});
document.addEventListener('drop',event=>{if(event.target.closest('#upload-zone')){event.preventDefault();void perform(()=>loadFile(event.dataTransfer.files[0]));}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.menu){state.menu=false;render();$('[data-action="menu"]').focus();}});
document.addEventListener('submit',event=>{const form=event.target;if(!form.id.endsWith('-form'))return;event.preventDefault();void perform(async()=>{state.error='';const values=Object.fromEntries(new FormData(form));
 if(form.id==='register-form'){
   if(values.password!==values.passwordRepeat)throw Error('Пароли не совпадают. Проверьте оба поля.');
   const clean=value=>value.trim().replace(/\s+/g,' ');
   const family=clean(values.familyName), given=clean(values.givenName), patronymic=clean(values.patronymic);
   if(!family||!given)throw Error('Заполните имя и фамилию.');
   values.displayName=[family,given,patronymic].filter(Boolean).join(' ');
 }
 if(form.id==='login-form'||form.id==='register-form'){const session=await api(form.id==='register-form'?'auth/register':'auth/login',{username:values.username,password:values.password,...(form.id==='register-form'?{role:values.role,displayName:values.displayName,consent:values.consent==='on'}:{})});form.elements.password.value='';state.error='';await refresh({knownSession:session});const action=await applyAccessLink();if(action)await refresh();if(action==='admin'){render();settings();}else if(state.authReturn?.startsWith('expert-invite/')&&state.account.role==='expert'){const target=state.authReturn;state.authReturn=null;navigate(target,{replace:true});}else if(currentToken().startsWith('expert-invite/')&&state.account.role==='expert')render();else{navigate(state.account.role==='admin'?'methodology':state.account.role==='expert'?'experts':'overview',{replace:true});render();}}
 if(form.id==='expert-catalog-form'){state.expertCatalog={query:values.query||'',level:values.level||'',region:values.region||'',municipality:values.municipality||''};render();return;}
 if(form.id==='header-search-form'){state.search=values.query||'';go('documents');}
 if(form.id==='dashboard-filter-form'){state.dashboardFilter={mode:values.mode,period:values.period,from:values.from,to:values.to};render();}
 if(form.id==='basis-select-form'){const source=state.db.sources.find(s=>s.id===form.dataset.source),quote=values.quote?.trim();if(!source?.verified||!source.active||!quote||!source.text.includes(quote))throw Error('Цитата не найдена в проверенном источнике. Скопируйте точный текст нормы.');state.draft.basis=[source.title,source.revision,source.url,'«'+quote+'»'].join(' · ');state.dirty=true;closeModal();render();}
 if(form.id==='profile-form'){await api('profile',{...values,revision:Number(form.dataset.revision),avatar:state.profileAvatar||'',removeAvatar:values.removeAvatar==='on'},'PUT');state.profileAvatar=null;await refresh();go(state.profileReturn||(state.account.role==='admin'?'methodology':state.account.role==='expert'?'experts':'overview'));state.profileReturn=null;render();toast('Профиль сохранён.');}
 if(form.id==='expert-assign-form'){const c=await api('expert-cases',{runId:form.dataset.run,expertAccountId:values.expertAccountId||undefined,comment:values.comment});closeModal();await refresh();if(c.assigned||c.existing){go('expert-case/'+c.id);if(state.pilotMode)toast('Дело в общей очереди экспертов');}else showExpertInvitation(c);}
 if(form.id==='expert-accept-form'){await api('expert-cases/'+form.dataset.case+'/accept',{token:values.token,profile:{name:values.name,registryNumber:values.registryNumber}});history.replaceState(null,'',pathFor('expert-case/'+form.dataset.case));await refresh();render();}
 if(form.id==='expert-draft-form'){try{await api('expert-cases/'+form.dataset.case+'/draft',{text:values.text,revision:Number(form.dataset.revision)},'PUT');}catch(error){toast(error.message);return;}clearDraft();await refresh();render();toast('Черновик заключения сохранён.');}
 if(form.id==='expert-message-form'){if(state.dirty){toast('Сначала сохраните черновик заключения.');return;}try{await api('expert-cases/'+form.dataset.case+'/messages',{text:values.text});}catch(error){toast(error.message);return;}await refresh();render();}
 if(form.id==='upload-form'){readUploadForm();const u=state.upload,paste=form.dataset.paste==='true';if(!paste&&!u.uploadId)throw Error('Сначала выберите DOCX.');const text=paste?values.text:u.text;if(!text?.trim())throw Error('В документе нет текста. Добавьте текст регламента.');let docId=form.dataset.doc,versionId;const payload={text,fileName:u.fileName||'Вставленный текст',uploadId:paste?undefined:u.uploadId,comment:values.comment||''};if(docId)versionId=(await api(`documents/${docId}/versions`,payload)).id;else docId=(await api('documents',{...payload,name:values.name,kind:values.kind,level:values.level,territory:values.territory})).id;state.upload=null;await refresh();const d=state.db.documents.find(d=>d.id===docId);go(`prepare/${docId}/${versionId||d.versions[0].id}`);}
 if(form.id==='run-form'){state.runChoices={mode:values.mode,docId:form.dataset.doc,versionId:form.dataset.version};go('run-confirm/'+form.dataset.doc+'/'+form.dataset.version);return;}
 if(form.id==='send-run-form'){if(values.permission!=='on')throw Error('Подтвердите право передачи документа.');const r=await api(`documents/${form.dataset.doc}/runs`,{versionId:form.dataset.version,mode:values.mode});await refresh();go('results/'+r.id);toast('Документ принят. ИИ готовит предварительный анализ.');}
 if(form.id==='reject-form'){if(!values.reason?.trim())throw Error('Укажите причину отклонения.');await saveDecision('rejected',values.reason);}
 if(form.id==='settings-form'){const preset=state.db.config.providers.find(p=>p.id===values.provider);const body={connection:{provider:values.provider,baseUrl:values.baseUrl,protocol:values.protocol||preset.protocol,model:values.model,jsonMode:values.jsonMode==='on',...(values.maxTokens?{maxTokens:Number(values.maxTokens)}:{}),workspaceId:values.workspaceId||''}};if(values.key?.trim())body.key=values.key;if(values.clear){body.key='';body.connection=state.db.config.connection;}await api('settings',body);form.elements.key.value='';closeModal();await refresh();render();toast(state.db.config.shared?(values.clear?'Общий ключ удалён у всех посетителей.':'Общее подключение сохранено для всех посетителей.'):'Настройки сохранены.');}
 if(form.id==='source-form'){await api(form.dataset.source?'sources/'+form.dataset.source:'sources',{...values,scope:'project',verified:values.verified==='on'},form.dataset.source?'PATCH':'POST');closeModal();await refresh();render();}
 if(form.id==='source-verify-form'){await api('sources/'+form.dataset.source,{verified:true},'PATCH');closeModal();await refresh();render();}
 if(form.id==='new-example-form'){const e=await api('examples',{manual:true,problem:values.problem,proposal:values.proposal,criterion:values.criterion});await refresh();go('example-saved/'+e.id);}
 if(form.id==='example-form'){await api('examples/'+form.dataset.example,{explanation:values.explanation,applicability:values.applicability,sourceIds:new FormData(form).getAll('sourceIds'),verified:values.verified==='on'},'PATCH');await refresh();go('example/'+form.dataset.example);}
 if(form.id==='save-example-form'){const e=await api('examples',{runId:form.dataset.run,findingId:form.dataset.finding,revision:Number(form.dataset.revision),applicability:values.applicability});await refresh();go('example-saved/'+e.id);}
 },event.submitter);});
installActionHelp();installAccessibility();installLegalLibrary();installProvisionMap();canonicalize();
installExpertEditor({getCase:()=>state.expertCase,onTab:(caseId,tab)=>{state.expertTab={caseId,tab};fitFields();},save:async(id,text,revision)=>{if(state.busy)throw Error('Дождитесь завершения текущего действия.');state.busy=true;try{await api('expert-cases/'+id+'/draft',{text,revision},'PUT');return {revision:revision+1};}finally{state.busy=false;}},onDirty:()=>{state.dirty=true;},onSaved:(id,text,result,form)=>{if(state.expertCase?.id===id){const draft=state.expertCase.conclusions.at(-1);draft.text=text;draft.revision=result.revision;}if(form?.isConnected&&form.elements.text.value===text)clearDraft();}});
new MutationObserver(()=>upgradeLinks(document.getElementById('app'))).observe(document.getElementById('app'),{childList:true,subtree:true});
try{
 await refresh({sessionOnly:currentToken()==='login'&&!isAccessLink()});
 const action=state.account?await applyAccessLink():null;
 if(action)await refresh();
 render();
 if(action==='admin')settings();
 else if(action==='deleted')toast('Прежний личный ключ удалён из системы.');
}catch(error){
 const retry=esc(location.pathname+location.search);
 $('#app').innerHTML=`<main class="loading"><h1>Не удалось открыть пространство</h1><p>${esc(error.message)}</p><a href="${retry}">Попробовать ещё раз</a> · <a href="/login">Ко входу</a></main>`;
}


let pollingAnalysis=false;
setInterval(async()=>{
 const [page,id]=route();
 if(page!=='results'||document.hidden||pollingAnalysis||state.busy||state.dirty||$('#modal').open||!document.querySelector('[data-analysis-run]'))return;
 const x=locate(id);if(x?.r.status!=='running')return;
 const accountId=state.account?.id;
 pollingAnalysis=true;
 try{
  const next=await api('runs/'+encodeURIComponent(id)+'/status');
  if(state.account?.id!==accountId||currentToken()!=='results/'+id||state.busy||state.dirty||$('#modal').open)return;
  const current=locate(id);if(!current||current.r.status!=='running')return;
  if(next.status===current.r.status&&JSON.stringify(next.stages)===JSON.stringify(current.r.stages)&&JSON.stringify(next.stageTimes)===JSON.stringify(current.r.stageTimes))return;
  Object.assign(current.r,next.run||next);
  renderAnalysis(document.getElementById('app'),resultsPage(id));
 }catch{ /* Keep the saved screen; the next visible analysis tick can retry. */ }
 finally{pollingAnalysis=false;}
},30000);

function isAccessLink(){return /^#admin\/[A-Za-z0-9_-]{43}$/.test(location.hash)||location.hash==='#delete-personal-key';}
async function applyAccessLink(){
 const accessLink=state.pendingAccessLink||location.hash;const admin=accessLink.match(/^#admin\/([A-Za-z0-9_-]{43})$/),remove=accessLink==='#delete-personal-key';
 if(!admin&&!remove)return null;
 state.pendingAccessLink=null;
 history.replaceState(null,'',pathFor(state.account?.role==='admin'?'methodology':'documents'));
 if(remove){await api('settings/personal',{},'DELETE');return 'deleted';}
 await api('admin/login',{token:admin[1]});return 'admin';
}

function showExpertInvitation(invitation){modal('Пригласить независимого эксперта',notice('Персональная ссылка действует 7 дней','Передайте её эксперту вручную. После входа в аккаунт эксперта и принятия приглашения ему станет доступен снимок документа и результатов проверки. Повторная выдача ссылки отменяет предыдущую.')+field('expertLink','Ссылка для эксперта',location.origin+'/#expert-invite/'+invitation.id+'/'+invitation.token,{readonly:true,max:2000})+B('expert-open','Открыть дело','',`data-case="${invitation.id}"`));}
function expertPage(id){
 if(state.expertCase?.id!==id){if(state.loadingCase!==id){state.loadingCase=id;void api('expert-cases/'+id).then(c=>{state.expertCase=c;state.loadingCase=null;if(route()[0]==='expert-case'&&route()[1]===id)render();}).catch(error=>{state.loadingCase=null;go('experts');state.error=error.message;render();});}return shell(head('Открываем экспертное дело')+'<div class="loading-skeleton" role="status" aria-label="Загружаем данные"><div class="skeleton-card"></div></div>','experts','Экспертное дело');}
 return shell(expertCase(state.expertCase,{documentId:state.db.documents.find(d=>d.runs.some(r=>r.id===state.expertCase.run.id))?.id,tab:state.expertTab?.caseId===id?state.expertTab.tab:'review'}),state.expertCase.archivedAt?'case-history':state.account?.role==='expert'?'expert-done':'experts','Экспертное дело');
}
document.addEventListener('input',event=>{if(event.target.closest('#expert-draft-form'))state.dirty=true;});

document.addEventListener('change',event=>{if(event.target.id!=='profile-photo')return;void perform(async()=>{const f=event.target.files[0];if(!f)return;if(!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>5*1024*1024)throw Error('Выберите JPEG, PNG или WebP до 5 МБ.');const image=await createImageBitmap(f);try{const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const size=Math.min(image.width,image.height);canvas.getContext('2d').drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,256,256);state.profileAvatar=canvas.toDataURL('image/jpeg',0.8);const preview=document.querySelector('#avatar-preview');preview.src=state.profileAvatar;preview.hidden=false;}finally{image.close();}});});

function viewOptions(){return {...(state.dashboardFilter||{}),pilot:state.pilotMode,...(state.pilotMode?{mode:'real'}:{}),isDemoAccount:['demo-official-v1','demo-expert-v1','local-demo'].includes(state.account?.id)};}
function fitFields(root=document){for(const area of root.querySelectorAll('textarea')){if(!area.offsetParent)continue;area.style.height='auto';area.style.height=(area.scrollHeight+3)+'px';}}
window.addEventListener('resize',()=>fitFields());
document.addEventListener('change',event=>{const form=event.target.closest('#dashboard-filter-form');if(!form)return;if(event.target.name==='period'){form.querySelector('[data-custom-period]').hidden=event.target.value!=='custom';}if(event.target.name==='mode'||event.target.name==='period'&&event.target.value!=='custom'){const values=Object.fromEntries(new FormData(form));state.dashboardFilter=values;render();}});

function stepper(active){return '<ol class="stepper" aria-label="Шаги проверки">'+['Документ','Проверка данных','Отправка'].map((title,i)=>'<li '+(i+1===active?'aria-current="step"':'')+'>'+ (i+1)+' '+title+'</li>').join('')+'</ol>';}

document.addEventListener('change',event=>{
 if(!event.target.matches('[data-decision-sort]'))return;
 const list=document.querySelector('[data-decision-list]');
 const byName=event.target.value==='name';
 list.append(...Array.from(list.children).sort((a,b)=>byName?a.dataset.title.localeCompare(b.dataset.title,'ru'):b.dataset.date.localeCompare(a.dataset.date)));
});

document.addEventListener('change',event=>{const form=event.target.closest('#expert-catalog-form');if(!form||!['region','municipality'].includes(event.target.name))return;state.expertCatalog={query:form.elements.query.value,level:form.elements.level.value,region:form.elements.region?.value||'',municipality:event.target.name==='region'?'':form.elements.municipality?.value||''};render();});
