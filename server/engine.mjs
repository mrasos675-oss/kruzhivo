import { buildProvisionGraph } from '../shared/provision-graph.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { CATALOG, demoAnalysis, demoReview, demoEdit } from './catalog.mjs';
import { fail } from './files.mjs';
import { PROMPTS, METHOD_GUIDANCE, FACTOR_CHECKS, MEANING_DIMENSIONS } from './ai-policy.mjs';
import { policySnapshot, stageInput } from './transparency.mjs';
import { legacyConnection, normalizeConnection, requestProvider } from './providers.mjs';
export { PROMPTS } from './ai-policy.mjs';

const object = x => x && typeof x === 'object' && !Array.isArray(x);
function str(x, max = 5000) { if (typeof x !== 'string' || !x.trim() || x.length > max) throw fail('Модель вернула некорректную структуру. Создайте новый запуск.', 502); return x.trim(); }
function list(x, max = 30) { if (!Array.isArray(x) || x.length > max) throw fail('Модель вернула некорректный список.', 502); return x; }
const strings = x => list(x, 20).map(s => str(s));
const normalizeWhitespace = text => text.replace(/\s+/gu, ' ');
const unverifiedReviewEvidence = 'Цитата Проверяющего не совпала с текстом документа. Замечание требует ручной сверки.';
export const decision = () => ({ status: 'pending', explanation: '', proposal: '', basis: '', comment: '', revision: 0, savedAt: null });

export function validateAnalysis(raw, text, sources) {
  if (!object(raw)) throw fail('Некорректный результат Аналитика.', 502);
  const allowed = new Set(CATALOG.factors.map(f => f.id));
  const rejectedFactors = new Set();
  const findings = list(raw.findings).flatMap(f => {
    if (!object(f) || !allowed.has(f.factorId)) throw fail('Неизвестный фактор в ответе модели.', 502);
    const suppliedQuote = str(f.quote, 10000);
    const quote = text.includes(suppliedQuote) ? suppliedQuote : text.match(new RegExp(suppliedQuote.split(/\s+/u).map(part => part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'u'))?.[0];
    if (!quote) {
      rejectedFactors.add(f.factorId);
      return [];
    }
    const basis = list(f.basis || [], 10).map(b => {
      const src = sources.find(s => s.id === b.sourceId);
      if (!src || !src.active || !src.verified || !src.text.includes(str(b.quote))) throw fail('Основание модели не подтверждено предоставленным источником.', 502);
      return { sourceId: src.id, quote: str(b.quote), locator: str(b.locator, 500) };
    });
    return [{ id: randomUUID(), factorId: f.factorId, point: str(f.point, 200), quote, explanation: str(f.explanation), basis, decision: decision() }];
  });
  const rows = list(raw.coverage, 12);
  if (new Set(findings.map(f => JSON.stringify([f.factorId, f.point, f.quote]))).size !== findings.length) throw fail('Аналитик вернул повторяющиеся находки.', 502);
  if (rows.length !== 12 || new Set(rows.map(c => c.factorId)).size !== 12) throw fail('Аналитик должен вернуть результат по каждому из 12 факторов.', 502);
  const coverage = rows.map(c => {
    if (!allowed.has(c.factorId) || !['finding', 'none', 'limited'].includes(c.status)) throw fail('Неполный каталог проверки.', 502);
    const has = findings.some(f => f.factorId === c.factorId);
    if (rejectedFactors.has(c.factorId)) return { factorId: c.factorId, status: has ? 'finding' : 'limited', note: 'Одно или несколько замечаний требуют ручной сверки: цитата Аналитика не найдена в документе.' };
    if ((c.status === 'finding') !== has) throw fail('Охват факторов не соответствует находкам.', 502);
    return { factorId: c.factorId, status: c.status === 'none' && !sources.length ? 'limited' : c.status, note: str(c.note) };
  });
  const limitations = strings(raw.limitations || []);
  if (rejectedFactors.size) limitations.push('Замечания с неподтверждёнными цитатами Аналитика исключены из списка. Соответствующие факторы требуют ручной сверки.');
  return { findings, coverage, limitations };
}

export function validateReviews(raw, findings, text, sources = []) {
  const rows = list(raw);
  if (rows.length !== findings.length || new Set(rows.map(x => x.findingId)).size !== findings.length) throw fail('Проверяющий не обработал все находки.', 502);
  const normalizedText = normalizeWhitespace(text);
  return rows.map(r => {
    if (!findings.some(f => f.id === r.findingId) || !['supported', 'contested', 'insufficient'].includes(r.verdict)) throw fail('Некорректная перепроверка.', 502);
    const evidence = strings(r.evidence || []);
    const verifiedEvidence = evidence.filter(q => normalizedText.includes(normalizeWhitespace(q)));
    if (verifiedEvidence.length !== evidence.length) {
      return {
        findingId: r.findingId, verdict: 'insufficient', evidenceRejected: true,
        explanation: unverifiedReviewEvidence, evidence: verifiedEvidence, sourceEvidence: [],
        counterarguments: [], checks: {}, doubts: []
      };
    }
    const checks = {};
    for (const k of ['context', 'exception', 'applicability', 'freshness']) checks[k] = str(r.checks?.[k]);
    const sourceEvidence = list(r.sourceEvidence || [], 10).map(b => {
      const src = sources.find(s => s.id === b.sourceId);
      if (!src || !src.active || !src.verified || !src.text.includes(str(b.quote))) throw fail('Источник возражения Проверяющего не подтверждён.', 502);
      return { sourceId: src.id, locator: str(b.locator, 500), quote: str(b.quote) };
    });
    const finding = findings.find(f => f.id === r.findingId), missing = r.verdict === 'supported' && !finding.basis.length;
    return { findingId: r.findingId, verdict: missing ? 'insufficient' : r.verdict, explanation: str(r.explanation) + (missing ? ' Правовое основание отсутствует: результат ограничен недостатком данных.' : ''), counterarguments: strings(r.counterarguments), evidence, sourceEvidence, checks, doubts: [...strings(r.doubts), ...(missing ? ['Нормативное основание не предоставлено; допустимо лишь уточнить формулировку с сохранением смысла.'] : [])] };
  });
}

export function validateEdits(raw, eligible) {
  const rows = list(raw);
  if (rows.length !== eligible.length || new Set(rows.map(x => x.findingId)).size !== eligible.length) throw fail('Редактор не обработал все переданные находки.', 502);
  return rows.map(e => {
    const finding = eligible.find(f => f.id === e.findingId);
    if (!finding || !['preserved', 'changed', 'uncertain'].includes(e.meaning)) throw fail('Нет проверки смысла проекта правки.', 502);
    const meaningChecks = {};
    for (const dimension of MEANING_DIMENSIONS) {
      const check = e.meaningChecks?.[dimension];
      if (!check) meaningChecks[dimension] = { status: 'uncertain', explanation: 'Модель не предоставила проверку этого измерения смысла.' };
      else { if (!object(check) || !['preserved', 'changed', 'uncertain'].includes(check.status)) throw fail('Некорректная проверка смысла правки.', 502); meaningChecks[dimension] = { status: check.status, explanation: str(check.explanation) }; }
    }
    const values = Object.values(meaningChecks).map(c => c.status);
    const meaning = e.meaning === 'changed' || values.includes('changed') ? 'changed' : e.meaning === 'uncertain' || values.includes('uncertain') ? 'uncertain' : 'preserved';
    const draft = e.proposal == null || e.proposal === '' ? '' : str(e.proposal);
    const insufficient = finding.review?.verdict === 'insufficient';
    const blocked = insufficient && draft && meaning !== 'preserved';
    const proposal = blocked ? '' : draft;
    const explanation = str(e.explanation) + (blocked ? ' Проект правки скрыт: данных недостаточно, а сохранение смысла не подтверждено.' : '');
    return { findingId: e.findingId, status: proposal ? 'prepared' : 'skipped', explanation, proposal, ...(proposal && insufficient ? { requiresLegalReview: true } : {}), ...(!proposal ? { reason: explanation } : {}), meaning, meaningExplanation: str(e.meaningExplanation) + (meaning !== e.meaning ? ' Итог скорректирован по отдельным проверкам смысла: сохранение всех элементов не подтверждено.' : ''), meaningChecks };
  });
}

export async function completion(system, payload, options) {
  const connection = normalizeConnection(options.connection || legacyConnection(options.model));
  const { content, finishReason } = await requestProvider(connection, options.key, system, payload, { fetcher: options.fetcher, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(connection.provider === 'polza' ? 165000 : 120000)]) });
  if (typeof content === 'string' && options.key && content.includes(options.key)) throw fail('Ответ провайдера содержит недопустимые данные и не сохранён.', 502);
  if (options.onResponse && typeof content === 'string') await options.onResponse({ model: connection.model, provider: connection.provider, protocol: connection.protocol, requestHash: createHash('sha256').update(JSON.stringify({ system, payload, connection })).digest('hex'), response: content, finishReason, at: new Date().toISOString() });
  if (finishReason !== 'stop') throw fail('Ответ модели не завершён. Данные не приняты.', 502);
  if (typeof content !== 'string') throw fail('API не вернул текстовый ответ. Проверьте формат API и текстовую модель.', 502);
  const fenced = content.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try { return JSON.parse(fenced ? fenced[1] : content); } catch { throw fail('Модель не вернула корректный JSON. Данные не приняты.', 502); }
}


export async function pipeline(run, text, options, update) {
  const demo = run.mode === 'demo';
  if (!demo) {
    const connection = normalizeConnection(options.connection || legacyConnection(options.model));
    run.aiPolicy ||= { ...policySnapshot(connection), snapshotOrigin: 'captured_at_execution' };
    run.aiInputs = [];
    run.aiTrace = [];
  }
  const requestOptions = stage => ({ ...options, onResponse: async response => {
    run.aiTrace.push({ stage, promptVersion: run.aiPolicy.version, ...response });
    await update(stage, 'running', { aiTrace: run.aiTrace });
  } });
  const policy = run.aiPolicy;
  const prompts = policy?.prompts || PROMPTS;
  const context = { methodologicalContext: policy?.methodology || METHOD_GUIDANCE, factorChecks: policy?.factorChecks || FACTOR_CHECKS, reviewDate: run.createdAt, limitations: run.limitations };
  const call = async (stage, payload) => {
    run.aiInputs.push(stageInput(stage, payload));
    await update(stage, 'running', { aiInputs: run.aiInputs });
    return completion(prompts[stage], payload, requestOptions(stage));
  };
  const step = async (stage, fn) => {
    options.signal.throwIfAborted(); await update(stage, 'running', !demo && stage === 'analyst' ? { aiPolicy: run.aiPolicy, aiTrace: run.aiTrace } : {});
    const result = await fn(); options.signal.throwIfAborted(); return result;
  };
  const analysis = await step('analyst', async () => {
    if (demo) { const a = demoAnalysis(text); return { ...a, findings: a.findings.map(f => ({ ...f, decision: decision() })) }; }
    return validateAnalysis(await call('analyst', { ...context, document: text, catalog: policy.catalog || CATALOG, sources: run.sources, examples: run.examples }), text, run.sources);
  });
  run.findings = analysis.findings; run.coverage = analysis.coverage;
  run.provisionGraph = buildProvisionGraph(text,run.findings);
  run.limitations = [...new Set([...run.limitations, ...analysis.limitations])];
  await update('analyst', 'completed', { findings: run.findings, provisionGraph: run.provisionGraph, coverage: run.coverage, limitations: run.limitations });
  if (!run.findings.length) { await update('reviewer', 'skipped'); await update('editor', 'skipped'); return run; }
  const reviews = await step('reviewer', async () => demo ? demoReview(run.findings) : validateReviews((await call('reviewer', { ...context, document: text, findings: run.findings, sources: run.sources })).reviews, run.findings, text, run.sources));
  run.findings = run.findings.map(f => ({ ...f, review: reviews.find(r => r.findingId === f.id) }));
  await update('reviewer', 'completed', { findings: run.findings });
  const eligible = run.findings.filter(f => !f.review.evidenceRejected && (demo ? f.review.verdict === 'supported' : f.review.verdict !== 'contested'));
  const edits = eligible.length ? await step('editor', async () => demo ? demoEdit(run.findings).map(e => ({ ...e, status: 'prepared' })) : validateEdits((await call('editor', { ...context, document: text, findings: eligible, sources: run.sources })).edits, eligible)) : [];
  run.findings = run.findings.map(f => ({
    ...f,
    editor: edits.find(e => e.findingId === f.id) || {
      status: 'skipped',
      reason: f.review.evidenceRejected ? unverifiedReviewEvidence : 'Перепроверка выявила возражение к замечанию.'
    }
  }));
  await update('editor', eligible.length ? 'completed' : 'skipped', { findings: run.findings });
  return run;
}
