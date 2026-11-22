import { nextStage, resumeRun, stageLeaseMs } from './run-stages.mjs';
import { manualExample } from './examples.mjs';
import { reportDisposition } from './report-filename.mjs';
import { documentKinds } from '../public/document-kinds.js';
import { buildProvisionGraph } from '../shared/provision-graph.mjs';
import { reportPdf } from './pdf-report.mjs';
import { SAMPLE_DOCUMENTS } from '../public/samples.js';
import { validateProfile, demoProfileFor } from './profile.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATALOG, SAMPLE_TEXT, CLEAN_TEXT } from './catalog.mjs';
import { createStore, id, now, version, newRun } from './store.mjs';
import { extractDocx, fail, reportDocx, zipFiles, xmlEscape } from './files.mjs';
import { methodology, policySnapshot } from './transparency.mjs';
import { createExpertReview, expertDocx } from './expert-review.mjs';
import { pipeline } from './engine.mjs';
import { proposalForDecision, isArchived } from '../shared/review.mjs';
import { createOriginals } from './originals.mjs';
import { PROVIDERS, PROTOCOLS, legacyConnection, emptyConnection, normalizeConnection, requestProvider, sameDestination } from './providers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const string = (x, max, label) => { if (typeof x !== 'string' || !x.trim() || x.length > max) throw fail(`${label}: допустимо от 1 до ${max} символов.`, 400); return x.trim(); };
const optional = (x, max = 10000) => x == null || x === '' ? '' : string(x, max, 'Поле');
function npaMetadata(input) {
  const { level, source } = input;
  if (!['Федеральный', 'Региональный', 'Муниципальный', 'Локальный'].includes(level))
    throw fail('Выберите допустимый уровень НПА.', 400);
  const region = optional(input.region, 100) || null;
  const municipality = optional(input.municipality, 98) || null;
  const needsRegion = level === 'Региональный' || level === 'Муниципальный';
  if (Boolean(region) !== needsRegion || Boolean(municipality) !== (level === 'Муниципальный'))
    throw fail('Заполните территорию в соответствии с уровнем НПА.', 400);
  if (source === 'manual') return { level, region, municipality, source, sourceUrl: null };
  if (source !== 'official') throw fail('Укажите источник сведений о НПА.', 400);
  const sourceUrl = optional(input.sourceUrl, 2000);
  let url;
  try { url = new URL(sourceUrl); } catch { throw fail('Укажите ссылку на официальный источник.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw fail('Укажите ссылку на официальный источник.', 400);
  return { level, region, municipality, source, sourceUrl: url.href };
}
function findDoc(db, docId) { const d = db.documents.find(x => x.id === docId); if (!d) throw fail('Документ не найден.', 404); return d; }
function locate(db, runId) { for (const d of db.documents) { const r = d.runs.find(x => x.id === runId); if (r) return { d, r, v: d.versions.find(v => v.id === r.versionId) }; } throw fail('Запуск не найден.', 404); }
function safeUrl(value) { let u; try { u = new URL(string(value, 2000, 'URL')); } catch { throw fail('Укажите корректный HTTP(S)-адрес.', 400); } if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw fail('Укажите HTTP(S)-адрес без пароля.', 400); return u.href; }
async function body(req, max = 5 * 1024 * 1024) { let size = 0; const chunks = []; for await (const c of req) { size += c.length; if (size > max) throw fail('Файл слишком большой. Максимум 3 МБ для DOCX.', 413); chunks.push(c); } return Buffer.concat(chunks); }
async function jsonBody(req) { try { const value = req.body === undefined ? JSON.parse((await body(req)).toString('utf8')) : typeof req.body === 'string' || Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Ожидается объект JSON.', 400); if (Buffer.byteLength(JSON.stringify(value)) > 5 * 1024 * 1024) throw fail('Файл слишком большой.', 413); return value; } catch (e) { if (e.status) throw e; throw fail('Некорректный JSON.', 400); } }
function finishInterrupted(run, status, message) {
  run.status = status;
  run.error = message;
  run.finishedAt = now();
  for (const key of Object.keys(run.stages)) {
    if (run.stages[key] === 'running') { run.stages[key] = status; run.stageTimes ||= {}; run.stageTimes[key] ||= {}; run.stageTimes[key].finishedAt = run.finishedAt; }
    else if (run.stages[key] === 'queued') run.stages[key] = 'not_started';
  }
}
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

export async function createApp({ dataDir = process.env.DATA_DIR || join(root, 'data'), initialKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '', initialModel = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-flash', initialConnection, fetcher, store: suppliedStore, originals: suppliedOriginals, hosted = false, pilotMode = false, trainingReader = false, queueExpert = null, credentials, access, schedule, dispatchStep, origin, reviewStore, sourceLibrary, actorId = 'local-demo', account, experts = [], bootstrapState, storageInfo = null, history = null } = {}) {
  const store = suppliedStore || await createStore(dataDir); const originals = suppliedOriginals || await createOriginals(dataDir); let apiKey = initialKey;
  const envConnection = process.env.LLM_PROVIDER ? { provider: process.env.LLM_PROVIDER, baseUrl: process.env.LLM_BASE_URL, protocol: process.env.LLM_PROTOCOL || 'chat-completions', model: process.env.LLM_MODEL || '', jsonMode: process.env.LLM_JSON_MODE !== 'false' } : null;
  let connection = normalizeConnection(initialConnection || (!hosted && envConnection) || (initialKey ? legacyConnection(initialModel) : emptyConnection()), { allowEmptyModel: true }); const jobs = new Map();
  // An interrupted process never leaves a run looking as if it were still running.
  if (!hosted) await store.change(db => { for (const d of db.documents) for (const r of d.runs) if (r.status === 'running') { finishInterrupted(r, 'failed', 'Сервер перезапущен. Частичные результаты сохранены; создайте новый запуск.'); } });
  const expertReview=createExpertReview(reviewStore||store,actorId,{trainingReader});
  const queueOptions = queueExpert && {
    expertId: 'account:' + queueExpert.id,
    profile: { name: 'Общий кабинет эксперта', registryNumber: 'Аккредитация не проверена автоматически', accountId: queueExpert.id, username: queueExpert.username },
    queued: true
  };

  async function queueForExpert(d, v, r, comment) {
    if (!queueOptions) throw fail('Общий кабинет эксперта пока недоступен. Повторите позже.', 503);
    const result = await expertReview.create(d, v, r, { ...queueOptions, comment, requestedBy:account?.displayName||'Специалист' });
    await store.change(db => { locate(db, r.id).r.expertCaseId = result.id; });
    return result;
  }

  async function saveHistory(runId, type, data, version) {
    try { await history.record(runId, type, data, version); }
    catch { console.error('kruzhivo: could not queue GitHub history event'); }
  }

  async function publishHistory(runId) {
    try { await history.flush(runId); }
    catch { console.error('kruzhivo: GitHub history delivery deferred'); }
  }

  async function saveSubmission(runId) {
    if (!history) return;
    try {
      const { d, v, r } = locate(await store.read(), runId);
      const original = v.original ? (await originals.read(v)).toString('base64') : null;
      await saveHistory(runId, 'submitted', {
        document: { id:d.id, name:d.name, kind:d.kind, version:v },
        originalDocxBase64: original,
        submittedAt:r.createdAt,
      });
    } catch { console.error('kruzhivo: could not prepare GitHub submission'); }
  }

  async function saveRunResult(runId) {
    if (!history) return;
    try {
      const { d, r, v } = locate(await store.read(), runId);
      if (r.status === 'running') return;
      await saveHistory(runId, 'result', { documentId:d.id, versionId:v.id, run:r });
      await publishHistory(runId);
    } catch { console.error('kruzhivo: could not prepare GitHub result'); }
  }

  async function start(runId, runKey, permit) {
    const controller = new AbortController(); jobs.set(runId, controller);
    let lease;
    if(dispatchStep){
      lease=id();
      const claimed=await store.change(db=>{const r=locate(db,runId).r;if(r.status!=='running'||r.execution?.token&&r.execution.expiresAt>Date.now())return false;r.execution={token:lease,expiresAt:Date.now()+stageLeaseMs};return true;});
      if(!claimed){jobs.delete(runId);return;}
    }
    const { r, v } = structuredClone(locate(await store.read(), runId)); const key = runKey, selectedModel = r.model;
    permit ||= r.permit;
    let pending=false;
    const update = async (stage, status, patch = {}) => { if (r.mode === 'api' && status === 'running' && (key !== apiKey || !sameDestination(r.connection || connection, connection) || credentials && !(await credentials.valid()))) throw fail('Подключение отключено или заменено. Проверьте настройки API.', 401); return store.change(db => { const current = locate(db, runId).r; if (current.status !== 'running'||lease&&current.execution?.token!==lease) throw fail('Запуск остановлен.', 409); Object.assign(current, patch); current.stages[stage] = status; current.stageTimes ||= {}; current.stageTimes[stage] ||= {}; if (status === 'running') current.stageTimes[stage].startedAt ||= now(); else current.stageTimes[stage].finishedAt = now(); }); };
    try {
      if(permit&&credentials?.touch)await credentials.touch(permit);
      const signal = hosted ? AbortSignal.any([controller.signal, AbortSignal.timeout(dispatchStep?210000:280000)]) : controller.signal;
      await pipeline(r, v.text, {
        singleStage:!!dispatchStep, key, model: selectedModel, connection: r.connection || connection, signal, fetcher,
        onAttempt: hosted ? (stage, attempt) => {
          if (attempt.code || attempt.httpStatus >= 400) console.warn('kruzhivo: provider attempt failed', { runId, stage, ...attempt });
        } : undefined
      }, update);
      if(dispatchStep&&nextStage(r)){
        await store.change(db=>{const current=locate(db,runId).r;if(current.status!=='running'||current.execution?.token!==lease)throw fail('Запуск остановлен.',409);current.execution={token:null,expiresAt:Date.now()+90000};});
        await dispatchStep(runId);pending=true;return;
      }
      const completed = await store.change(db => {
        const { d, r: current, v } = locate(db, runId);
        if (current.status !== 'running'||lease&&current.execution?.token!==lease) return null;
        current.status = 'completed';
        current.finishedAt = now();
        return { d, r: current, v };
      });
    }
    catch (e) { await store.change(db => { const x = locate(db, runId).r; if (x.status === 'running'&&(!lease||x.execution?.token===lease||x.execution?.token===null)) { finishInterrupted(x, 'failed', e.name === 'TimeoutError' ? 'Превышено время ожидания этапа. Завершённые этапы сохранены; можно продолжить проверку.' : e.status ? e.message : 'Проверка прервана. Завершённые этапы сохранены; можно продолжить проверку.'); } }); }
    finally { jobs.delete(runId); if(permit&&!pending&&(locate(await store.read(),runId).r.status!=='running'))await credentials.release(permit); if(!pending)await saveRunResult(runId); }
  }
  const canEditSources=()=>account?account.role==='expert':!hosted||access?.canManage===true;
  const availableSources=async(workspace)=>{
    const [project,db]=await Promise.all([sourceLibrary?.read()||[],workspace||store.read()]);
    return [...project.map(s=>({...s,scope:'project'})),...db.sources];
  };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!hosted && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw fail('Доступ разрешён только с локального компьютера.', 403);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url = new URL(req.url, `http://${host}`), p = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin !== (origin || `http://${host}`) || req.headers['x-kruzhivo-client'] !== '1') throw fail('Обновите страницу и повторите действие.', 403);
      }
      const sampleMatch=p.match(/^\/api\/sample-documents\/([a-z]+)\.docx$/);
      if(req.method==='GET'&&sampleMatch){
        const sample=sampleMatch[1]==='canonical'?{id:'canonical',text:SAMPLE_TEXT}:SAMPLE_DOCUMENTS.find(d=>d.id===sampleMatch[1]);if(!sample)throw fail('Учебный документ не найден.',404);
        const bytes=zipFiles({'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>','word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+sample.text.split('\n').map(t=>'<w:p><w:r><w:t xml:space="preserve">'+xmlEscape(t)+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>'});
        res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename="teaching-'+sample.id+'.docx"'});return res.end(bytes);
      }
      if(p==='/api/profile'&&req.method==='PUT'){
        const b=await jsonBody(req);let profile;
        await store.change(db=>{if(Number(b.revision)!==(db.profile?.revision||0))throw fail('Профиль уже изменён. Обновите страницу.',409);profile=validateProfile(b,db.profile);db.profile=profile;});
        return json(res,200,{profile});
      }
      if(p==='/api/auth/session'&&req.method==='GET')return json(res,200,{user:account||{id:'local-demo',role:'official',displayName:'Локальная демонстрация',local:true}});
      if(p==='/api/expert-cases/history'&&req.method==='GET')return json(res,200,{cases:await expertReview.history()});
      if(p==='/api/expert-cases'&&req.method==='GET')return json(res,200,{cases:await expertReview.list()});
      if(p==='/api/expert-cases/archive-duplicates'&&req.method==='POST'){await jsonBody(req);return json(res,200,await expertReview.archiveEmptyDemoDuplicates());}
      if(p==='/api/expert-cases'&&req.method==='POST'){
        const b=await jsonBody(req),x=locate(await store.read(),b.runId);
        if(pilotMode)return json(res,201,await queueForExpert(x.d,x.v,x.r,b.comment));
        const chosen=b.expertAccountId?experts.find(e=>e.id===b.expertAccountId):null;
        if(b.expertAccountId&&!chosen)throw fail('Учётная запись эксперта не найдена.',400);
        const profile=chosen?{name:chosen.displayName,registryNumber:'Аккредитация не проверена автоматически',accountId:chosen.id,username:chosen.username}:null;
        return json(res,201,await expertReview.create(x.d,x.v,x.r,{
          expertId:chosen?'account:'+chosen.id:null,profile,comment:b.comment,requestedBy:account?.displayName||'Специалист'
        }));
      }
      const expertMatch=p.match(/^\/api\/expert-cases\/([a-f0-9-]{36})(?:\/(accept|invite|start|messages|draft|sign|new-draft|conclusions\/([0-9]+)\.docx))?$/);
      if(expertMatch){const [,caseId,action,number]=expertMatch;
        if(req.method==='GET'&&!action)return json(res,200,await expertReview.get(caseId));
        if(req.method==='GET'&&number){const c=await expertReview.get(caseId),bytes=expertDocx(c,Number(number));res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename="expert-conclusion-v'+number+'.docx"'});return res.end(bytes);}
        if(req.method==='POST'||req.method==='PUT'){const b=await jsonBody(req);const result=action==='accept'?await expertReview.accept(caseId,b.token,account?{...b.profile,name:account.displayName,accountId:account.id,username:account.username}:b.profile):action==='invite'?await expertReview.invite(caseId):action==='start'?await expertReview.start(caseId):action==='messages'?await expertReview.message(caseId,b.text):action==='draft'?await expertReview.save(caseId,b.text,b.revision,!!history):action==='sign'?await expertReview.sign(caseId,b.revision,!!history,b.text):action==='new-draft'?await expertReview.newDraft(caseId):null;if(result){
          if(result.history){
            const {runId, conclusion}=result.history;
            await saveHistory(runId,action==='sign'?'conclusion':'draft',{caseId, conclusion},conclusion);
            if(schedule)schedule(publishHistory(runId));else await publishHistory(runId);
            delete result.history;
          }
          return json(res,200,result);
        }}
      }
      if (req.method === 'GET' && p === '/api/methodology') return json(res, 200, methodology());
      if (req.method === 'GET' && p === '/api/bootstrap') {
        const db=bootstrapState||await store.read();
        return json(res, 200, { ...db, profile:db.profile||demoProfileFor(account||{id:'local-demo',role:'official'})||undefined, sources:await availableSources(db), account:account||{id:'local-demo',role:'official',displayName:'Локальная демонстрация',local:true}, catalog: CATALOG, config: { configured: !!apiKey && !!connection.model, model: connection.model, connection, experts:account?.role==='official'?experts:[], providers: PROVIDERS, protocols: PROTOCOLS, hosted, storage:storageInfo, keyExpiresAt: null, ...(access?{shared:true,canManage:access.canManage,usingShared:access.usingShared,personalConfigured:access.personalConfigured,...(access.canManage?{personalConnection:access.personalConnection}:{})}:{}) }, sampleText: SAMPLE_TEXT });
      }
      if(req.method==='DELETE'&&p==='/api/settings/personal'&&access){await jsonBody(req);await access.clearPersonal();return json(res,200,{ok:true});}
      if(req.method==='POST'&&p==='/api/admin/login'&&access){const b=await jsonBody(req);await access.login(b.token);return json(res,200,{ok:true});}
      if (req.method === 'POST' && p === '/api/settings/probe') {
        if (hosted && !access?.canManage) throw fail('Диагностика доступна только администратору.', 403);
        if (!apiKey || !connection.model) throw fail('Подключите модель перед диагностикой.', 400);
        const selectedConnection = connection, key = apiKey, attempts = [];
        const permit = credentials?.reserve ? await credentials.reserve() : null;
        try {
          const { content, finishReason } = await requestProvider(
            selectedConnection, key, 'Проверка подключения. Ответь только JSON: {"ok":true}.', { prompt: 'ping' },
            { fetcher, signal: AbortSignal.timeout(20000), onAttempt: attempt => attempts.push(attempt) }
          );
          const ok = finishReason === 'stop' && typeof content === 'string' && !!content.trim();
          return json(res, 200, { ok, attempts, ...(ok ? {} : { error: 'Модель не вернула завершённый текстовый ответ.' }) });
        } catch (error) {
          const failure = [...attempts].reverse().find(attempt => attempt.code);
          return json(res, 200, { ok: false, attempts, error: failure?.code || (error.status ? error.message : 'Ответ провайдера не получен.') });
        } finally {
          if (permit) await credentials.release(permit);
        }
      }
      if (req.method === 'POST' && p === '/api/settings') {
        if(access&&!access.canManage)throw fail('Изменять общий ключ может только владелец подключения.',403);
        const b = await jsonBody(req);
        const next = normalizeConnection(b.connection || { ...(connection.model ? connection : legacyConnection(b.model)), model: b.model }, { allowEmptyModel: b.key === '' });
        let key = apiKey;
        if ('key' in b) { if (typeof b.key !== 'string' || b.key.length > 8192 || (b.key.trim() && !/^[\x21-\x7e]+$/.test(b.key.trim()))) throw fail('Некорректный ключ.', 400); key = b.key.trim(); }
        if(access?.shared&&!key&&b.key!=='')throw fail('Введите API-ключ для общего подключения.',400);
        if (key && apiKey && !sameDestination(connection, next) && !b.key?.trim()) throw fail('При смене провайдера или адреса введите его API-ключ. Сохранённый ключ не будет отправлен другому сервису.', 400);
        if (credentials) await credentials.set(key, next.model, next);
        apiKey = key; connection = next;
        return json(res, 200, { configured: !!apiKey && !!connection.model, model: connection.model, connection });
      }
      if (req.method === 'POST' && p === '/api/extract') {
        const b = await jsonBody(req); return json(res, 200, await originals.prepare(b.fileName, b.base64));
      }
      if (req.method === 'POST' && p === '/api/documents') {
        const b = await jsonBody(req), text = string(b.text, 80000, 'Текст документа');
        const v = version(text, 1, optional(b.fileName, 250) || 'Вставленный текст');
        if (b.kind !== undefined && !documentKinds.includes(b.kind)) throw fail('Выберите допустимый вид документа.', 400);
        if (b.level && !['Федеральный','Региональный','Муниципальный','Локальный'].includes(b.level)) throw fail('Выберите допустимый уровень НПА.',400);
        const metadata = b.source || 'region' in b || 'municipality' in b ? npaMetadata(b) : null;
        const territory = metadata ? [metadata.region, metadata.municipality].filter(Boolean).join(', ') : optional(b.territory, 200);
        const d = { id: id(), ...(metadata && { npaMetadata: metadata }), kind: b.kind || null, level: b.level || null, territory: territory || null, name: string(b.name, 180, 'Название'), sample: b.text===SAMPLE_TEXT||b.text===CLEAN_TEXT||b.text?.includes('УЧЕБНЫЙ ПРИМЕР. Не является действующим нормативным правовым актом.')===true, createdAt: now(), versions: [v], runs: [] };
        await originals.attach(b.uploadId, v);
        try { await store.change(db => { db.documents.unshift(d); }); } catch (error) { await originals.discard(v); throw error; }
        return json(res, 201, { id: d.id });
      }
      const metadataMatch = p.match(/^\/api\/documents\/([^/]+)\/metadata$/);
      if (req.method === 'PATCH' && metadataMatch) {
        if (account && account.role !== 'official') throw fail('Изменять карточку НПА может специалист.', 403);
        const metadata = npaMetadata(await jsonBody(req));
        await store.change(db => { findDoc(db, metadataMatch[1]).npaMetadata = metadata; });
        return json(res, 200, { ok: true });
      }
      let m = p.match(/^\/api\/documents\/([^/]+)\/versions$/);
      if (req.method === 'POST' && m) {
        const b = await jsonBody(req), doc = findDoc(await store.read(), m[1]);
        const v = version(string(b.text, 80000, 'Текст'), doc.versions.length + 1, optional(b.fileName, 250) || 'Вставленный текст');
        v.comment = optional(b.comment, 2000);
        await originals.attach(b.uploadId, v);
        try { await store.change(db => { const d = findDoc(db, m[1]); v.number = d.versions.length + 1; d.versions.push(v); }); } catch (error) { await originals.discard(v); throw error; }
        return json(res, 201, { id: v.id });
      }
      m = p.match(/^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/(original|text)$/);
      if (req.method === 'GET' && m) {
        const d = findDoc(await store.read(), m[1]), v = d.versions.find(v => v.id === m[2]);
        if (!v) throw fail('Версия не найдена.', 404);
        const original = m[3] === 'original';
        const bytes = original ? await originals.read(v) : Buffer.from(v.text);
        const name = original ? v.original.fileName : d.name + '-v' + v.number + '.txt';
        res.writeHead(200, { 'Content-Type': original ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="document-v${v.number}.${original ? 'docx' : 'txt'}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
        return res.end(bytes);
      }
      m = p.match(/^\/api\/documents\/([^/]+)\/runs$/);
      if (req.method === 'POST' && m) {
        const b = await jsonBody(req); if (!['demo', 'api'].includes(b.mode)) throw fail('Укажите режим проверки.', 400);
        if (pilotMode && b.mode === 'demo') throw fail('В рабочем кабинете доступна только проверка моделью.',400);
        if (b.mode === 'api' && !apiKey) throw fail('Общий API ещё не подключён. Попросите администратора подключить модель.', 400);
        if (b.mode === 'api') normalizeConnection(connection);
        const runKey = apiKey, runConnection = structuredClone(connection);
        const sourceSnapshot=await availableSources();
        const permit=b.mode==='api'&&credentials?.reserve?await credentials.reserve():null;
        let r;try{r = await store.change(db => { const d = findDoc(db, m[1]); if (d.runs.some(x => x.status === 'running')) throw fail('Для этого документа уже выполняется проверка.', 409); const v = d.versions.find(x => x.id === b.versionId); if (!v) throw fail('Версия не найдена.', 404); if (b.mode === 'demo') demoAnalysisCheck(v.text); const r = newRun(d, v, b.mode, sourceSnapshot, db.examples, runConnection.model); r.authorSnapshot=db.profile?Object.fromEntries(['fullName','organization','department','position'].map(k=>[k,db.profile[k]||''])):null; if (b.mode === 'api') { r.connection = runConnection; r.aiPolicy = policySnapshot(runConnection); r.aiPolicy.snapshotOrigin = 'captured_at_creation'; } d.runs.push(r); return r; });}catch(error){if(permit)await credentials.release(permit);throw error;}
        if(dispatchStep)await store.change(db=>{const current=locate(db,r.id).r;current.orchestration='staged-v1';current.permit=permit;current.execution={token:null,expiresAt:Date.now()+90000};});
        await saveSubmission(r.id);
        if (history && schedule) schedule(publishHistory(r.id));
        if (schedule) schedule(start(r.id, runKey, permit)); else setImmediate(() => void start(r.id, runKey, permit)); return json(res, 202, { id: r.id });
      }
      m = p.match(/^\/api\/runs\/([^/]+)\/status$/);
      if(req.method==='GET'&&m){
        const {r}=locate(await store.read(),m[1]);
        const {permit,execution,...publicRun}=r;
        return json(res,200,{id:r.id,status:r.status,stages:r.stages,stageTimes:r.stageTimes,finishedAt:r.finishedAt,error:r.error,...(r.status==='running'?{}:{run:publicRun})});
      }
      m = p.match(/^\/api\/runs\/([^/]+)\/(advance|resume)$/);
      if(req.method==='POST'&&m){
        const runId=m[1];
        if(m[2]==='advance'){
          const {r}=locate(await store.read(),runId);
          if(!dispatchStep||r.orchestration!=='staged-v1')throw fail('Этот запуск не поддерживает поэтапное выполнение.',409);
          if(r.status!=='running')return json(res,200,{status:r.status});
          if(schedule)schedule(start(runId,apiKey,r.permit));else setImmediate(()=>void start(runId,apiKey,r.permit));
          return json(res,202,{id:runId});
        }
        const previous=locate(await store.read(),runId).r;
        if(previous.mode==='api'&&(!apiKey||!sameDestination(previous.connection||connection,connection)))throw fail('Для продолжения нужно прежнее API-подключение и модель.',409);
        const permit=previous.mode==='api'&&credentials?.reserve?await credentials.reserve():null;
        let resumed;
        try{resumed=await store.change(db=>{const {d,r,v}=locate(db,runId);if(d.runs.some(x=>x.status==='running'))throw fail('Для документа уже идёт проверка.',409);const next=resumeRun(d,r,v);if(dispatchStep){next.orchestration='staged-v1';next.permit=permit;next.execution={token:null,expiresAt:Date.now()+90000};}d.runs.push(next);return next;});}catch(error){if(permit)await credentials.release(permit);throw error;}
        await saveSubmission(resumed.id);
        if(schedule)schedule(start(resumed.id,apiKey,permit));else setImmediate(()=>void start(resumed.id,apiKey,permit));
        return json(res,202,{id:resumed.id});
      }
      m = p.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && m) { jobs.get(m[1])?.abort(); await store.change(db => { const r = locate(db, m[1]).r; if (r.status !== 'running') throw fail('Этот запуск уже завершён.', 409); finishInterrupted(r, 'cancelled', 'Запуск остановлен специалистом. Завершённые этапы сохранены.'); }); return json(res, 200, { ok: true }); }
      m = p.match(/^\/api\/runs\/([^/]+)\/findings\/([^/]+)$/);
      if (req.method === 'PUT' && m) {
        const b = await jsonBody(req); if (!['confirmed', 'modified', 'rejected', 'pending'].includes(b.status)) throw fail('Некорректный статус решения.', 400);
        const d = await store.change(db => { const { d: doc, r } = locate(db, m[1]); if (isArchived(doc, r)) throw fail('Архивный запуск доступен только для чтения.', 403); if (r.status !== 'completed') throw fail('Дождитесь завершения проверки.', 409); const f = r.findings.find(x => x.id === m[2]); if (!f) throw fail('Замечание не найдено.', 404); if (f.decision.revision !== b.revision) throw fail('Решение уже изменено в другой вкладке. Обновите страницу.', 409); const explanation = optional(b.explanation);if(b.factorIds!==undefined&&(!Array.isArray(b.factorIds)||!b.factorIds.length||b.factorIds.length>12||new Set(b.factorIds).size!==b.factorIds.length||b.factorIds.some(id=>!CATALOG.factors.some(f=>f.id===id))))throw fail('Укажите от одного до 12 известных факторов.',400); if (b.status === 'rejected' && !explanation) throw fail('Укажите причину отклонения.', 400); f.decision = { status: b.status, explanation, proposal: optional(b.proposal), basis: optional(b.basis), comment: optional(b.comment, 3000), factorIds:b.factorIds||f.decision.factorIds||[f.factorId], systemOriginal: f.decision.systemOriginal||{explanation:f.editor?.explanation||f.explanation,proposal:f.editor?.proposal||'',basis:structuredClone(f.basis)}, revision: f.decision.revision + 1, savedAt: now() }; (doc.actionLog ||= []).push({id:id(),createdAt:f.decision.savedAt,author:db.profile?.fullName||account?.displayName||'Специалист',action:b.status,runId:r.id,findingId:f.id}); return f.decision; }); return json(res, 200, d);
      }
      m = p.match(/^\/api\/runs\/([^/]+)\/report\.docx$/);
      if (req.method === 'GET' && m) { const { d, r, v } = locate(await store.read(), m[1]); const bytes = reportDocx(d, v, r,(await store.read()).profile); res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': reportDisposition(d,v,r,'docx'), 'Cache-Control': 'no-store' }); return res.end(bytes); }
      if (req.method === 'POST' && p === '/api/sources') {
        if(!canEditSources())throw fail('Правовую базу изменяет только эксперт.',403);
        const b = await jsonBody(req),project=!!sourceLibrary&&(account?.role==='expert'||b.scope==='project');
        if(b.scope==='project'&&!sourceLibrary)throw fail('Общая база недоступна.',400);
        const s = { id: id(), title: string(b.title, 250, 'Название'), url: safeUrl(b.url), revision: string(b.revision, 250, 'Редакция'), applicability: string(b.applicability, 3000, 'Область применения'), text: string(b.text, 30000, 'Текст источника'), active: true, verified: b.verified === true, verifiedAt: b.verified === true ? now() : null,...(project?{scope:'project'}:{}) };
        const add=sources=>{if(sources.length>=20)throw fail('В каждой базе может быть не более 20 источников.',400);sources.unshift(s);};
        if(project)await sourceLibrary.change(add);else await store.change(db=>add(db.sources));return json(res,201,{id:s.id});
      }
      const sourceFile=p.match(/^\/api\/sources\/([^/]+)\/download$/);
      if(req.method==='GET'&&sourceFile){const s=(await availableSources()).find(s=>s.id===sourceFile[1]);if(!s)throw fail('Источник не найден.',404);const text=[s.title,s.revision,s.url,s.applicability,'',s.text].join('\n');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="legal-source.txt"','Cache-Control':'private, no-store'});return res.end('\uFEFF'+text);}
      m = p.match(/^\/api\/sources\/([^/]+)$/);
      if (req.method === 'PATCH' && m) {
        const b=await jsonBody(req),project=sourceLibrary&&(await sourceLibrary.read()).some(s=>s.id===m[1]);
        if(!canEditSources())throw fail('Правовую базу изменяет только эксперт.',403);
        const patch=sources=>{const s=sources.find(s=>s.id===m[1]);if(!s)throw fail('Источник не найден.',404);let changed=false;for(const [field,max,label] of [['title',250,'Название'],['revision',250,'Редакция'],['applicability',3000,'Область применения'],['text',30000,'Текст источника']])if(field in b){const value=string(b[field],max,label);if(s[field]!==value){s[field]=value;changed=true;}}if('url'in b){const url=safeUrl(b.url);if(s.url!==url){s.url=url;changed=true;}}if(changed){s.verified=false;s.verifiedAt=null;s.updatedAt=now();s.updatedBy=actorId;}if('active'in b)s.active=b.active===true;if('verified'in b){s.verified=b.verified===true;s.verifiedAt=s.verified?now():null;}};
        if(project)await sourceLibrary.change(patch);else await store.change(db=>patch(db.sources));return json(res,200,{ok:true});
      }
      const pdfMatch=p.match(/^\/api\/runs\/([^/]+)\/report\.pdf$/);
      if(req.method==='GET'&&pdfMatch){const db=await store.read(),{d,r,v}=locate(db,pdfMatch[1]),bytes=await reportPdf(d,v,r,db.profile);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':reportDisposition(d,v,r,'pdf'),'Cache-Control':'no-store'});return res.end(bytes);}
      const graphMatch=p.match(/^\/api\/runs\/([^/]+)\/provision-graph$/);
      if(req.method==='POST'&&graphMatch){
        await jsonBody(req);
        const graph=await store.change(db=>{const {r,v}=locate(db,graphMatch[1]);if(r.status==='running')throw fail('Дождитесь завершения проверки.',409);r.provisionGraph ||= buildProvisionGraph(v.text,r.findings);return r.provisionGraph;});
        return json(res,200,graph);
      }
      const manifestMatch=p.match(/^\/api\/runs\/([^/]+)\/manifest\.json$/);
      if(req.method==='GET'&&manifestMatch){const {r,v}=locate(await store.read(),manifestMatch[1]);res.setHeader('Content-Disposition','attachment; filename="run-manifest.json"');return json(res,200,{runId:r.id,mode:r.mode,createdAt:r.createdAt,documentHash:v.hash,document:v.text,provisionGraph:r.provisionGraph||null,author:r.authorSnapshot||null,connection:r.connection||null,policy:r.aiPolicy||null,sources:r.sources,examples:r.examples,inputs:r.aiInputs||[],trace:r.aiTrace||[],notice:r.mode==='demo'?'Подготовленный сценарий: провайдер не использовался.':'Снимок запуска. Повторный запрос модели может дать другой результат.'});}
      if (req.method === 'POST' && p === '/api/examples') { const b = await jsonBody(req); if (b.manual === true) { if (account && account.role !== 'expert') throw fail('Добавлять ручные примеры может эксперт.', 403); const e = manualExample(b, account); await store.change(db => { db.examples.unshift(e); }); return json(res, 201, { id: e.id }); } const e = await store.change(db => { const { r, d, v } = locate(db, b.runId); const f = r.findings.find(f => f.id === b.findingId); if (f && b.revision != null && b.revision !== f.decision.revision) throw fail('Решение изменено. Обновите страницу перед сохранением примера.', 409); if (!f || !['confirmed','modified'].includes(f.decision.status)) throw fail('Сначала подтвердите находку и сохраните решение.', 400); const e = { id: id(), title: CATALOG.factors.find(c => c.id === f.factorId).title, quote: f.quote, explanation: f.decision.explanation || f.explanation, proposal: proposalForDecision(f), applicability: b.applicability ? string(b.applicability, 3000, 'Применимость') : 'Требует проверки специалистом', sourceIds: f.basis.map(b => b.sourceId), origin: `${d.name} · v.${v.number} · №${r.number}`, author: 'Специалист', createdAt: now(), active: true, verified: false }; db.examples.unshift(e); return e; }); return json(res, 201, { id: e.id }); }
      m = p.match(/^\/api\/examples\/([^/]+)$/);
      if (req.method === 'PATCH' && m) { const b = await jsonBody(req); await store.change(db => { const e = db.examples.find(x => x.id === m[1]); if (!e) throw fail('Пример не найден.', 404); if ('explanation' in b) { e.explanation = string(b.explanation, 10000, 'Объяснение'); e.verified = false; } if ('sourceIds' in b) { if (!Array.isArray(b.sourceIds) || b.sourceIds.length > 20 || b.sourceIds.some(id => !db.sources.some(s => s.id === id))) throw fail('Некорректные источники примера.', 400); e.sourceIds = [...new Set(b.sourceIds)]; e.verified = false; } if ('applicability' in b) { e.applicability = string(b.applicability, 3000, 'Применимость'); e.verified = false; } if ('active' in b) e.active = b.active === true; if (b.verified === false) e.verified = false; if (b.verified === true) { if (!e.sourceIds.length || e.sourceIds.some(id => !db.sources.some(s => s.id === id && s.verified && s.active))) throw fail('Для подтверждения примера нужны связанные проверенные источники.', 400); e.verified = true; } }); return json(res, 200, { ok: true }); }
      if (p.startsWith('/api/')) throw fail('Действие не найдено.', 404);
      const files = { '/app-render.js':['app-render.js','text/javascript; charset=utf-8'], '/action-help.js':['action-help.js','text/javascript; charset=utf-8'], '/provision-map.js':['provision-map.js','text/javascript; charset=utf-8'], '/document-kinds.js':['document-kinds.js','text/javascript; charset=utf-8'], '/legal-reference.js':['legal-reference.js','text/javascript; charset=utf-8'], '/legal-base.js':['legal-base.js','text/javascript; charset=utf-8'], '/portal.css':['portal.css','text/css; charset=utf-8'], '/report.css':['report.css','text/css; charset=utf-8'], '/shared/report-view.mjs':['../shared/report-view.mjs','text/javascript; charset=utf-8'], '/portal-router.js':['portal-router.js','text/javascript; charset=utf-8'], '/accessibility.js':['accessibility.js','text/javascript; charset=utf-8'], '/expert-editor.js':['expert-editor.js','text/javascript; charset=utf-8'], '/quote-pairs.js':['quote-pairs.js','text/javascript; charset=utf-8'], '/shared/provision-graph.mjs':['../shared/provision-graph.mjs','text/javascript; charset=utf-8'], '/shared/report-format.mjs':['../shared/report-format.mjs','text/javascript; charset=utf-8'], '/shared/document-structure.mjs':['../shared/document-structure.mjs','text/javascript; charset=utf-8'], '/dashboard.js':['dashboard.js','text/javascript; charset=utf-8'], '/portal-illustration.svg':['portal-illustration.svg','image/svg+xml'], '/demo-official.svg':['demo-official.svg','image/svg+xml'], '/demo-expert.svg':['demo-expert.svg','image/svg+xml'], '/landing.js':['landing.js','text/javascript; charset=utf-8'], '/profile.js':['profile.js','text/javascript; charset=utf-8'], '/samples.js':['samples.js','text/javascript; charset=utf-8'], '/login.js':['login.js','text/javascript; charset=utf-8'], '/expert-showcase.js': ['expert-showcase.js','text/javascript; charset=utf-8'], '/cabinets.js': ['cabinets.js','text/javascript; charset=utf-8'], '/transparency.js': ['transparency.js', 'text/javascript; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/review.mjs': ['../shared/review.mjs', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/fonts/InterTight.ttf': ['fonts/InterTight.ttf', 'font/ttf'] };
      if(!files[p]&&/^\/(?:login|register|restore|gov|expert|notifications|profile|help|sources|samples|privacy|terms|app)(?:\/|$)/.test(p))files[p]=['index.html','text/html; charset=utf-8'];
      if (!files[p] || !['GET', 'HEAD'].includes(req.method)) throw fail('Страница не найдена.', 404);
      const [file, type] = files[p]; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : await readFile(join(root, 'public', file)));
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Не удалось выполнить действие. Данные не изменены.' }); else res.end(); }
  });
  return { server, handler: server.listeners('request')[0], store, close: async () => { for (const c of jobs.values()) c.abort(); await new Promise(resolve => server.close(resolve)); } };
}

// Importing the server in tests never starts a listener or makes paid API calls.
import { demoAnalysis as demoAnalysisCheck } from './catalog.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4310); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT');
  const app = await createApp(); app.server.listen(port, '127.0.0.1', () => console.log(`КружИИво: http://127.0.0.1:${port}`));
  app.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'Порт занят. Укажите другой PORT в .env.' : 'Не удалось запустить локальный сервер.'); process.exitCode = 1; });
}

