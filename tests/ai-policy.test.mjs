import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, SAMPLE_TEXT, demoAnalysis } from '../server/catalog.mjs';
import { FACTOR_CHECKS, METHOD_GUIDANCE, MEANING_DIMENSIONS, POLICY_VERSION, PROMPTS } from '../server/ai-policy.mjs';
import { pipeline, validateAnalysis, validateReviews, validateEdits, completion } from '../server/engine.mjs';
import { newRun, version } from '../server/store.mjs';

const checks = { context: 'Проверены связанные пункты', exception: 'Исключения не установлены', applicability: 'Нужны сведения о применимости', freshness: 'Действующая редакция не проверена' };
const review = (f, patch = {}) => ({ findingId: f.id, verdict: 'supported', explanation: 'Предварительный вывод', counterarguments: [], evidence: [], checks, doubts: [], ...patch });
const edit = patch => ({ findingId: 'f', explanation: 'Проект изменения', proposal: 'Предлагаемая редакция', meaning: 'preserved', meaningExplanation: 'Сопоставлены элементы нормы', ...patch });
const matrix = () => Object.fromEntries(MEANING_DIMENSIONS.map(k => [k, { status: 'preserved', explanation: 'Соответствует исходной норме' }]));
const source = { id: 's', title: 'Синтетический тестовый источник', text: 'Тестовая норма: перечень документов является исчерпывающим.', active: true, verified: true, revision: 'Не является правовым актом' };

test('Each working factor has an operational check and false-positive safeguard', () => {
  assert.deepEqual(FACTOR_CHECKS.map(f => f.factorId), CATALOG.factors.map(f => f.id));
  assert.ok(FACTOR_CHECKS.every(f => f.check.length > 30 && f.falsePositive.length > 30));
  assert.equal(CATALOG.approved, false);
  assert.match(METHOD_GUIDANCE.rules.join(' '), /Учебные слайды/);
});
test('Repeated findings are rejected instead of inflating the results', () => {
  const a = demoAnalysis(SAMPLE_TEXT); a.findings.push(a.findings[0]);
  assert.throws(() => validateAnalysis(a, SAMPLE_TEXT, []), /повторяющиеся/);
});
test('A supported claim without a legal basis is downgraded while objections are retained', () => {
  const f = { id: 'f', basis: [] };
  const r = validateReviews([review(f)], [f], SAMPLE_TEXT)[0];
  assert.equal(r.verdict, 'insufficient'); assert.ok(r.doubts.length);
  assert.equal(validateReviews([review(f, { verdict: 'contested', evidence: ['не может превышать 10 рабочих дней'] })], [f], SAMPLE_TEXT)[0].verdict, 'contested');
});
test('Document findings survive missing legal sources and a partial objection narrows the finding', () => {
  const finding = { id: 'f', basis: [] };
  const text = 'После заключения договора цена может увеличиваться с учётом инфляции. Цена договора фиксирована.';
  const evidence = ['цена может увеличиваться с учётом инфляции', 'Цена договора фиксирована.'];
  const assessment = { status: 'confirmed', summary: 'В документе расходятся условия изменения цены.' };
  const check = patch => validateReviews([review(finding, patch)], [finding], text)[0];
  const verified = check({ documentAssessment: assessment, evidence });
  assert.equal(verified.verdict, 'insufficient');
  assert.deepEqual(verified.documentAssessment, assessment);
  assert.equal(check({ documentAssessment: assessment }).documentAssessment, undefined);
  assert.equal(check({ documentAssessment: assessment, evidence: ['Выдуманный фрагмент'] }).documentAssessment, undefined);
  const partial = { status: 'partial', summary: 'Договор устанавливает цену; порядок её пересмотра требует уточнения.' };
  assert.deepEqual(check({ documentAssessment: partial, evidence }).documentAssessment, partial);
  assert.equal(check({ documentAssessment: { ...assessment, status: 'refuted' }, evidence }).verdict, 'contested');
});
test('Reviewer cannot fabricate a quote from the document or cite an unavailable source', () => {
  const f = { id: 'f', basis: [{ sourceId: 's' }] };
  const fragment = 'Проверка занимает\n\t10\u00a0рабочих дней.';
  const evidence = 'Проверка занимает 10 рабочих дней.';
  assert.deepEqual(validateReviews([review(f, { evidence: [evidence] })], [f], fragment)[0].evidence, [evidence]);
  for (const bad of ['Не существующий пункт', 'Проверка занимает 20 рабочих дней.', 'Проверка занимает: 10 рабочих дней.']) {
    const [rejected] = validateReviews([review(f, { verdict: 'contested', evidence: [evidence, bad], counterarguments: [bad] })], [f], fragment);
    assert.equal(rejected.verdict, 'insufficient');
    assert.equal(rejected.evidenceRejected, true);
    assert.match(rejected.explanation, /ручной сверки/);
    assert.deepEqual(rejected.evidence, [evidence]);
    assert.deepEqual(rejected.counterarguments, []);
  }
  assert.throws(() => validateReviews([review(f, { sourceEvidence: [{ sourceId: 'unknown', locator: '1', quote: 'норма' }] })], [f], SAMPLE_TEXT, [source]), /Источник/);
  const result = validateReviews([review(f, { sourceEvidence: [{ sourceId: 's', locator: 'Тестовый пункт', quote: 'перечень документов является исчерпывающим' }] })], [f], SAMPLE_TEXT, [source]);
  assert.equal(result[0].sourceEvidence[0].sourceId, 's');
});
test('Editor cannot claim preserved meaning with absent, uncertain or changed dimensions', () => {
  const eligible = [{ id: 'f' }];
  assert.equal(validateEdits([edit({})], eligible)[0].meaning, 'uncertain');
  const m = matrix(); assert.equal(validateEdits([edit({ meaningChecks: m })], eligible)[0].meaning, 'preserved');
  m.rights.status = 'changed'; assert.equal(validateEdits([edit({ meaningChecks: m })], eligible)[0].meaning, 'changed');
  m.rights.status = 'uncertain'; assert.equal(validateEdits([edit({ meaningChecks: m })], eligible)[0].meaning, 'uncertain');
});
test('Editor may decline to invent a correction and leave an explanation for the specialist', () => {
  const r = validateEdits([edit({ proposal: null, nextStep: 'Сверить порядок утверждения тарифа.', explanation: 'Для конкретной редакции не хватает применимой нормы.', meaning: 'uncertain' })], [{ id: 'f' }])[0];
  assert.equal(r.status, 'skipped'); assert.equal(r.proposal, ''); assert.match(r.reason, /не хватает/);
  assert.equal(r.nextStep, 'Сверить порядок утверждения тарифа.');
  const unverified = [{ id: 'f', review: { verdict: 'insufficient' } }];
  const tentative = validateEdits([edit({ meaningChecks: matrix() })], unverified)[0];
  assert.equal(tentative.status, 'prepared');
  assert.equal(tentative.requiresLegalReview, true);
  const blocked = validateEdits([edit({ meaning: 'changed', meaningChecks: matrix() })], unverified)[0];
  assert.equal(blocked.status, 'skipped');
  assert.equal(blocked.proposal, '');
  assert.match(blocked.reason, /сохранение смысла не подтверждено/);
});
test('API pipeline isolates inaccurate reviewer quotes and continues to the editor', async () => {
  const v = version(SAMPLE_TEXT), d = { id: 'd', runs: [] }, run = newRun(d, v, 'api', [], [], 'deepseek-flash');
  let calls = 0;
  const fetcher = async (_url, options) => {
    const request = JSON.parse(options.body), p = JSON.parse(request.messages[1].content);
    assert.equal(p.sources.length, 0); assert.equal(p.factorChecks.length, 12);
    assert.equal(p.methodologicalContext.version, POLICY_VERSION);
    assert.match(request.messages[0].content, /недоверенные данные/);
    const stage = calls++;
    let output;
    if (stage === 0) output = demoAnalysis(SAMPLE_TEXT);
    else if (stage === 1) {
      assert.equal(request.messages[0].content, PROMPTS.reviewer);
      const overrides = [
        { verdict: 'contested', evidence: ['документ, подтверждающий полномочия представителя'] },
        { verdict: 'contested', evidence: ['10 календарных дней'] },
        {}
      ];
      output = { reviews: p.findings.map((f, i) => review(f, overrides[i])) };
    }
    else {
      assert.equal(p.findings.length, 1);
      assert.equal(p.findings[0].review.verdict, 'insufficient');
      assert.equal(p.findings[0].review.evidenceRejected, undefined);
      output = { edits: p.findings.map(f => edit({ findingId: f.id, proposal: null, meaning: 'uncertain', explanation: 'Нужна применимая норма.' })) };
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
  };
  await pipeline(run, SAMPLE_TEXT, { key: 'test-provider-key-sentinel', model: 'deepseek-flash', fetcher, signal: new AbortController().signal }, async () => {});
  assert.equal(calls, 3); assert.equal(run.aiPolicy.version, POLICY_VERSION); assert.equal(run.aiTrace.length, 3);
  assert.equal(run.findings[0].review.verdict, 'contested');
  assert.equal(run.findings[1].review.evidenceRejected, true);
  assert.match(run.findings[1].editor.reason, /ручной сверки/);
  assert.match(run.aiTrace.find(t => t.stage === 'reviewer').response, /10 календарных дней/);
  assert.equal(run.findings[2].editor.reason, 'Нужна применимая норма.');
  assert.ok(run.findings.every(f => f.editor.status === 'skipped' && f.decision.status === 'pending'));
  assert.ok(run.aiTrace.every(t => /^[a-f0-9]{64}$/.test(t.requestHash) && t.response));
  assert.ok(!JSON.stringify(run).includes('test-provider-key-sentinel'));
});
test('A successful provider response echoing the API key is rejected before auditing', async () => {
  let recorded = false;
  await assert.rejects(completion('', {}, { key: 'provider-key-sentinel', model: 'deepseek-flash', signal: new AbortController().signal, onResponse: () => { recorded = true; }, fetcher: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"echo":"provider-key-sentinel"}' } }] })) }), /недопустимые данные/);
  assert.equal(recorded, false);
});

test('Continuing an incomplete review reuses validated saved replies and requests only missing findings', async () => {
  const v = version(SAMPLE_TEXT);
  const run = newRun({ id: 'doc', runs: [] }, v, 'api', [], [], 'deepseek-flash');
  run.resumedFrom = 'previous';
  run.findings = [{ id: 'a', basis: [] }, { id: 'b', basis: [] }];
  run.stages.analyst = 'completed';
  run.aiTrace = [{ stage: 'reviewer', finishReason: 'stop', response: JSON.stringify({ reviews: [review(run.findings[0])] }) }];
  const requests = [];
  const fetcher = async (_url, options) => {
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    requests.push(payload.findings.map(f => f.id));
    const content = JSON.stringify({ reviews: [review(run.findings[1])] });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  };
  await pipeline(run, v.text, { singleStage: true, key: 'test-key', model: 'deepseek-flash', fetcher, signal: new AbortController().signal }, async () => {});
  assert.deepEqual(requests, [['b']]);
  assert.equal(run.stages.reviewer, 'completed');
  assert.ok(run.findings.every(f => f.review.verdict === 'insufficient'));
});
