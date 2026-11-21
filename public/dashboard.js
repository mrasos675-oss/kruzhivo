const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY=86400000;
export function dashboardFilters(options={}){const mode=options.mode||'real',period=options.period||'all';return `<form id="dashboard-filter-form" class="dashboard-toolbar">${options.pilot?'<input type="hidden" name="mode" value="real">':`<label><span>Данные</span><select name="mode"><option value="real" ${mode==='real'?'selected':''}>Мои проверки</option><option value="demo" ${mode==='demo'?'selected':''}>Демонстрация</option></select></label>`}<fieldset class="period-filter"><legend>Период</legend><div class="period-buttons">${[['month','30 дней'],['quarter','90 дней'],['year','Год'],['all','Всё время'],['custom','Указать период']].map(([v,label])=>`<label class="period-button"><input type="radio" name="period" value="${v}" ${v===period?'checked':''}><span>${label}</span></label>`).join('')}</div></fieldset><div class="date-filter" data-custom-period ${period==='custom'?'':'hidden'}><label><span>С</span><input type="date" name="from" value="${esc(options.from||'')}"></label><label><span>По</span><input type="date" name="to" value="${esc(options.to||'')}"></label><button class="btn compact" type="submit">Применить</button></div></form>`;}
export function selectPeriod(items,options={},now=Date.now()){
 let start=-Infinity,end=Infinity;if(options.period==='month')start=now-30*DAY;if(options.period==='quarter')start=now-90*DAY;if(options.period==='year')start=now-365*DAY;
 if(options.period==='custom'){if(!/^\d{4}-\d{2}-\d{2}$/.test(options.from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(options.to||''))return [];start=new Date(options.from+'T00:00:00').getTime();end=new Date(options.to+'T00:00:00').getTime()+DAY-1;if(start>end)return [];}
 return items.filter(x=>{const time=new Date(x.createdAt).getTime();return time>=start&&time<=end;});
}
export function demoActivity(now=Date.now()){
 // Explicit synthetic activity. These records never become real documents, runs or AI inputs.
 return Array.from({length:24},(_,i)=>({id:'illustration-'+i,createdAt:new Date(now-(i*4+1)*DAY).toISOString(),status:i<3?'running':i===3?'failed':'completed',confirmed:i<4?0:(i%4)+1,pending:i<4?0:i%3,rejected:i<4?0:i%2}));
}
const metric=(label,value,note='')=>`<article class="card metric-tile"><p>${esc(label)}</p><strong>${value}</strong>${note?`<small>${esc(note)}</small>`:''}</article>`;
function gauge(label,numerator,denominator){const percent=denominator?Math.round(numerator/denominator*100):0,angle=Math.PI*(1-percent/100),x=120+73*Math.cos(angle),y=120-73*Math.sin(angle);return `<section class="card gauge-card"><h2>${esc(label)}</h2><svg viewBox="0 0 240 154" role="img" aria-label="${esc(label)}: ${denominator?percent+'%':'нет данных'}"><path d="M30 120 A90 90 0 0 1 210 120" fill="none" stroke="#ecebe7" stroke-width="16"/><path d="M30 120 A90 90 0 0 1 210 120" fill="none" stroke="#b84d16" stroke-width="16" pathLength="100" stroke-dasharray="${percent} 100"/><line x1="120" y1="120" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="#252a28" stroke-width="4" stroke-linecap="round"/><circle cx="120" cy="120" r="8" fill="#252a28"/><text x="25" y="149">0%</text><text x="105" y="19">50%</text><text x="195" y="149">100%</text></svg><strong class="gauge-number">${denominator?percent+'%':'—'}</strong><p class="muted">${numerator} из ${denominator}. ${denominator?'Доля по выбранному периоду.':'Появится после первых результатов.'}</p></section>`;}
function activityChart(items,{expert=false,conclusions=false}={}){let reference=Date.now();if(items.length)reference=Math.max(...items.map(x=>new Date(x.createdAt).getTime()));const bins=Array.from({length:8},(_,i)=>{const a=reference-(7-i)*7*DAY-7*DAY,b=a+7*DAY;return{date:new Date(b).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}),value:items.filter(x=>new Date(x.createdAt).getTime()>a&&new Date(x.createdAt).getTime()<=b).length};}),max=Math.max(1,...bins.map(x=>x.value));return `<section class="card activity-card"><h2>${conclusions?'Мои заключения по неделям':expert?'Запросы экспертизы':'Запуски проверок НПА'}</h2><p class="muted">По неделям · 8 недель до последнего события</p><p class="muted">${conclusions?'Количество подготовленных заключений, шт.':expert?'Количество запросов, шт.':'Количество запусков, шт. · повторная проверка считается отдельным запуском'}</p><svg viewBox="0 0 520 210" role="img" aria-label="${esc(bins.map(x=>x.date+': '+x.value+(conclusions?' заключений':expert?' запросов':' запусков')).join('; '))}"><line x1="15" y1="171" x2="505" y2="171" stroke="#d9dde1"/>${bins.map((b,i)=>{const height=125*b.value/max,x=23+i*61;return `<rect x="${x}" y="${170-height}" width="32" height="${height}" rx="3" fill="#b84d16"><title>${b.date}: ${b.value} ${conclusions?'заключений':expert?'запросов экспертизы':'запусков проверок НПА'}</title></rect><text x="${x+16}" y="${158-height}" text-anchor="middle">${b.value}</text><text x="${x+16}" y="196" text-anchor="middle">${b.date}</text>`;}).join('')}</svg></section>`;}
function explanation(demo){return demo?'<div class="demo-banner"><strong>Демонстрационные показатели</strong><p>Учебная активность для знакомства с дашбордом. Эти цифры не относятся к вашим документам или реальным пользователям. Переключите «Данные» на «Мои проверки», чтобы увидеть свои результаты.</p></div>':'';}
export function officialDashboard(db,cases,options={}){
 const demo = (options.mode || 'real') === 'demo';
 const realDocuments = db.documents.filter(d => !d.sample);
 const runs = selectPeriod(demo ? demoActivity() : realDocuments.flatMap(d => d.runs.filter(r => r.mode === 'api')), options);
 const docs = demo ? runs : selectPeriod(realDocuments, options);
 const officialCases = selectPeriod(cases.filter(c => !c.isDemo && c.role === 'official'), options);
 const running = runs.filter(r => r.status === 'running').length;
 const completed = runs.filter(r => r.status === 'completed').length;
 const forwarded = demo ? runs.filter(r => r.status === 'completed' && r.pending > 0).length
   : officialCases.filter(c => ['waiting', 'reviewing'].includes(c.status)).length;
 const conclusions = demo ? runs.filter(r => r.status === 'completed' && r.pending === 0).length
   : officialCases.filter(c => c.status === 'confirmed').length;

 return `<div class="stack">${recentActions(db)}${dashboardFilters(options)}${explanation(demo)}<div class="metric-grid">${metric('Загружено документов', docs.length)}${metric('ИИ: в работе / готово', running + ' / ' + completed, 'Запуски анализа')}${metric('Передано эксперту', forwarded, 'Дела в ожидании и в работе')}${metric('Подтверждено экспертом', conclusions, 'Заключения')}</div>${activityChart(runs)}</div>`;
}
export function expertDashboard(cases,options={}){
 const demo=(options.mode||'real')==='demo';
 const own=demo?demoActivity().map((r,i)=>({...r,status:i<4?'reviewing':i<6?'waiting':'confirmed',confirmedAt:i>=6?r.createdAt:null})):cases.filter(c=>!c.isDemo&&c.role==='expert');
 const rows=selectPeriod(own,options),done=rows.filter(r=>r.status==='confirmed').length;
 // Count one prepared conclusion per case, including a confirmed version followed by a new draft.
 const conclusions=selectPeriod(own.filter(c=>c.confirmedAt).map(c=>({...c,createdAt:c.confirmedAt})),options);
 return `<div class="stack">${dashboardFilters(options)}${explanation(demo)}<section class="card expert-conclusion-summary" aria-labelledby="my-conclusions-title"><div><h2 id="my-conclusions-title">Мои заключения</h2><p class="muted">Подготовлено за выбранный период · по дате подтверждения</p><p class="muted">Одна экспертиза — одно заключение, независимо от числа версий.</p></div><div class="conclusion-total"><svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5h17l8 8v30H12z"/><path d="M29 5v9h8M18 22h13M18 28h13m-13 7 4 4 8-8"/></svg><strong>${conclusions.length}</strong><span>заключений</span></div></section><div class="metric-grid">${metric('Запросов экспертизы',rows.length)}${metric('На рассмотрении',rows.filter(r=>r.status==='reviewing').length)}${metric('Ожидают начала',rows.filter(r=>r.status==='waiting').length)}${metric('Дел с готовым заключением',done)}</div><div class="dashboard-charts">${gauge('Дела с готовым заключением',done,rows.length)}${activityChart(rows,{expert:true})}</div>${activityChart(conclusions,{conclusions:true})}</div>`;
}


export function recentActions(db){
 const events=[];
 const add=(at,label,d,href)=>{const time=Date.parse(at);if(Number.isFinite(time))events.push({at,time,label,name:d.name,href});};
 for(const d of db.documents||[]){
  if(d.sample)continue;
  const history='#history/'+encodeURIComponent(d.id);
  add(d.createdAt,'Документ загружен',d,history);
  for(const v of d.versions||[])if(v.number>1)add(v.createdAt,'Добавлена версия '+v.number,d,history);
  for(const r of d.runs||[]){
   const target='#results/'+encodeURIComponent(r.id);
   add(r.createdAt,'Проверка запущена',d,target);
   if(r.finishedAt)add(r.finishedAt,({completed:'Проверка завершена',failed:'Ошибка проверки',cancelled:'Проверка остановлена'})[r.status]||'Проверка обновлена',d,target);
   for(const f of r.findings||[])if(f.decision?.savedAt)add(f.decision.savedAt,'Сохранено решение специалиста',d,target);
  }
 }
 events.sort((a,b)=>b.time-a.time||a.href.localeCompare(b.href)||a.label.localeCompare(b.label));
 return `<section class="card recent-actions"><h2>Последние действия</h2>${events.length?`<ul class="recent-actions-list">${events.slice(0,2).map(e=>`<li><a href="${esc(e.href)}"><strong>${esc(e.name)}</strong><span>${esc(e.label)}</span><time datetime="${esc(e.at)}">${esc(new Date(e.time).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}))}</time></a></li>`).join('')}</ul>`:'<p class="muted">Здесь появятся последние действия с вашими документами.</p>'}</section>`;
}
