import { findingLimitation, methodReference, missingBasisCount, moscowTime, ruStatus } from './report-format.mjs';

export const reportDisclaimer = 'Предварительный отчёт системы. Не является заключением антикоррупционной экспертизы';
const decisionStates = [['confirmed', 'Подтверждено'], ['modified', 'Изменено'], ['rejected', 'Отклонено'], ['pending', 'Не рассмотрено']];
const coverageStates = [['finding', 'Есть находка'], ['limited', 'Ограничено'], ['none', 'Находка не предложена'], ['unrecorded', 'Не записано']];
const symbols = { confirmed: '✓', modified: '◆', rejected: '×', pending: '▲', finding: '●', limited: '▲', none: '✓', unrecorded: '–' };
const methodology = 'ПП РФ от 26.02.2010 № 96';
const disclaimer = 'Оценки системы не являются установленными нарушениями. Окончательное решение принимает специалист.';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const badge = (status, label) => `<span class="report-badge report-${status}"><span aria-hidden="true">${symbols[status]}</span> ${esc(label)}</span>`;
const line = (label, value) => `<p><strong>${label}</strong> ${esc(value)}</p>`;
const note = (kind, symbol, text) => `<p class="report-note report-note-${kind}"><strong aria-hidden="true">${symbol}</strong><span>${esc(text)}</span></p>`;
const shortMethod = (id, catalog) => methodReference(id, catalog).replace(` (${methodology})`, '');
const target = (number, label) => `<a class="report-ref" href="#report-remark-${number}" data-scroll-to="report-remark-${number}">${esc(label)}</a>`;

function quoteBlock(quote, print) {
  const fragment = `<blockquote class="report-quote"><i>«${esc(quote)}»</i></blockquote>`;
  return !print && quote.length > 600
    ? `<details class="report-long-quote"><summary><span class="report-quote-preview report-quote">«${esc(quote.slice(0, 260))}…»</span><span class="report-quote-toggle">Показать цитату полностью</span><span class="report-quote-close">Свернуть цитату</span></summary>${fragment}</details>`
    : fragment;
}

function sourceDescription(entry, sources) {
  const source = sources.find(s => s.id === entry.sourceId);
  return `${source?.title || entry.sourceId}, ${entry.locator}, редакция: ${source?.revision || 'не указана'}, цитата: «${entry.quote}»`;
}

function reviewDetails(finding, sources) {
  const { review, editor } = finding;
  if (!review && !editor) return '';
  const reviewContent = review ? [
    line('Проверяющий:', `${ruStatus(review.verdict)}. ${review.explanation}`),
    ...(review.counterarguments || []).map(value => line('Возражение:', value)),
    ...(review.evidence || []).map(value => line('Контекст:', `«${value}»`)),
    ...Object.entries(review.checks || {}).map(([key, value]) => line(esc(ruStatus(key)) + ':', value)),
    ...(review.sourceEvidence || []).map(entry => line('Источник перепроверки:', sourceDescription(entry, sources)))
  ].join('') : '';
  const editorContent = editor ? [
    line('Редактор:', ruStatus(editor.status)),
    line('Проект редактора (не решение специалиста):', (editor.proposal || 'не подготовлен') + (editor.requiresLegalReview ? ' (требуется сверка с применимыми нормами)' : '')),
    line(`Смысл нормы (${esc(ruStatus(editor.meaning))}):`, editor.meaningExplanation || editor.reason || 'Не записано'),
    ...Object.entries(editor.meaningChecks || {}).map(([key, check]) => line(`Проверка смысла — ${esc(ruStatus(key).toLowerCase())}:`, `${ruStatus(check.status)}. ${check.explanation}`))
  ].join('') : '';
  return `<div class="report-review-details">${reviewContent}${editorContent}</div>`;
}

function remarkCard({ finding, number, factor, reference }, sources, catalog, print, runId) {
  const decision = finding.decision || {};
  const status = decisionStates.some(([key]) => key === decision.status) ? decision.status : 'pending';
  const stateLabel = ruStatus(status);
  const basis = finding.basis || [];
  const specialistEdit = decision.proposal || (decision.revision > 0 || decision.savedAt ? 'правка не предложена.' : 'решение ещё не сохранено.');
  return `<article id="report-remark-${number}" data-report-remark data-continuation="${esc(`Замечание № ${number} · ${factor} (продолжение)`)}" data-factor="${esc(finding.factorId)}" class="report-remark report-${status}">
    <header class="report-remark-head">
      <span class="report-number" aria-label="Замечание ${number}">${number}</span>
      <div><h3>${esc(factor)}</h3><p>${esc(finding.point || 'Расположение не записано')}</p></div>
      <span class="report-chip">${esc(reference)}</span>
    </header>
    ${quoteBlock(finding.quote || 'Цитата не записана', print)}
    <div class="report-analyst"><h4>Анализ системы</h4><p>${esc(finding.explanation || 'Не записано')}</p></div>
    ${basis.length ? `<div class="report-bases"><h4>Основания</h4><ul>${basis.map(entry => `<li>${esc(sourceDescription(entry, sources))}</li>`).join('')}</ul></div>`
      : `<p>${badge('pending', 'Основания не заполнены — требуют проверки')}</p>`}
    <p class="report-small">${esc(findingLimitation(finding))}</p>
    <div class="report-decision">
      <p class="report-decision-status"><strong>Решение специалиста</strong> ${badge(status, stateLabel)}</p>
      ${decision.explanation ? `<p>${esc(decision.explanation)}</p>` : ''}
      ${status === 'modified' ? line('Исходное объяснение системы:', decision.systemOriginal?.explanation || finding.explanation) + line('Исходная редакция системы:', decision.systemOriginal?.proposal || finding.editor?.proposal || 'Не предлагалась') : ''}
      ${decision.factorIds?.length ? line('Классификация специалиста:', decision.factorIds.map(id => methodReference(id, catalog)).join('; ')) : ''}
      ${decision.comment ? line('Комментарий специалиста:', decision.comment) : ''}
      <div class="${decision.proposal ? 'report-edit' : 'report-small'}">${line('Редакция специалиста:', specialistEdit)}</div>
      ${decision.basis ? line('Основание специалиста:', decision.basis) : '<p class="report-small">Правовое основание специалистом не заполнено.</p>'}
      ${print ? '' : `<a class="report-open no-report-print" href="/gov/checks/${encodeURIComponent(runId)}/findings/${number - 1}">Открыть замечание</a>`}
    </div>
  </article>`;
}

function coverageRows(catalog, run, remarks) {
  const coverage = new Map((run.coverage || []).map(row => [row.factorId, row]));
  return (catalog.factors || []).map(factor => {
    const row = coverage.get(factor.id);
    const status = coverageStates.some(([key]) => key === row?.status) ? row.status : 'unrecorded';
    return {
      id: factor.id, locator: factor.locator, title: factor.title, status,
      label: coverageStates.find(([key]) => key === status)[1],
      reference: shortMethod(factor.id, catalog), description: row?.note || 'Не записано',
      remarks: remarks.filter(item => item.finding.factorId === factor.id)
    };
  });
}

function limitationText(text) {
  const match = text.match(/^\s*\S+(?:\s+\S+){0,3}/u);
  if (!match) return esc(text);
  return `<strong>${esc(match[0])}</strong>${esc(text.slice(match[0].length))}`;
}

export function renderReport(doc, version, run, profile, catalog, { print = false } = {}) {
  const author = run.authorSnapshot || profile || {};
  const org = [author.organization, author.department].filter(Boolean).join(' · ') || 'Не указаны';
  const versionLabel = `Версия ${version.number} · запуск №${run.number}`;
  const remarks = (run.findings || []).map((finding, index) => ({
    finding, number: index + 1, reference: shortMethod(finding.factorId, catalog),
    factor: catalog.factors?.find(item => item.id === finding.factorId)?.title || finding.factorId
  }));
  const coverage = coverageRows(catalog, run, remarks);
  const findings = remarks.length;
  const decisions = decisionStates.map(([status, label]) => ({
    status, label, count: remarks.filter(r => (r.finding.decision?.status || 'pending') === status).length
  }));
  const limitations = [...(run.limitations || []), ...(run.error ? [run.error] : [])];
  const missing = missingBasisCount(run);
  const status = run.status === 'completed' ? 'Завершён' : ruStatus(run.status);
  const countReviewed = decisions.filter(d => d.status !== 'pending').reduce((sum, d) => sum + d.count, 0);
  const hash = version.hash || 'Не записан';
  const hashRows = /^[a-f0-9]{64}$/i.test(hash) ? [hash.slice(0, 32), hash.slice(32)] : [hash];
  const model = run.mode === 'demo' ? 'Учебный сценарий с подготовленными ответами' : run.model || 'Не указан';
  const instructions = run.aiPolicy?.version || (run.mode === 'demo' ? 'Подготовленный учебный сценарий' : 'Не записана');
  const notes = `<ul class="report-limits-list">${limitations.length ? limitations.map(value =>
    `<li><span aria-hidden="true">i</span><div>${limitationText(value)}</div></li>`).join('')
    : '<li>Не записаны.</li>'}</ul>`;
  const coverageItems = coverage.map(row => {
    const refs = row.remarks.map(item => target(item.number, '№ ' + item.number)).join(', ');
    return `<tr><th scope="row">${esc(row.reference)}<small>${esc(row.title)}</small></th>
      <td>${badge(row.status, row.label)}</td><td>${esc(row.description)}${refs ? `<div class="report-refs">${refs}</div>` : ''}</td></tr>`;
  }).join('');
  const sectionLinks = `<nav class="report-toc" aria-label="Указатель замечаний"><p><strong>Указатель замечаний</strong></p><ol>${
    remarks.map(item => `<li>${target(item.number, `№ ${item.number} · ${item.factor}`)}</li>`).join('')}</ol></nav>`;
  const filter = !print && findings >= 20 ? `<label class="report-filter no-report-print">Пункт Методики
    <select data-report-factor><option value="">Все замечания</option>${coverage.filter(row => row.remarks.length)
      .map(row => `<option value="${esc(row.id)}">${esc(row.reference)}</option>`).join('')}</select></label>` : '';
  const sources = run.sources || [];
  const reviews = remarks.filter(({ finding }) => finding.review || finding.editor);
  const reviewAppendix = reviews.length ? `<div class="report-appendix">
    <h3>Перепроверка и проекты Редактора</h3>
    ${reviews.map(({ finding, number, factor }) => `<section class="report-review-entry">
      <h4>${target(number, `№ ${number} · ${factor}`)}</h4>${reviewDetails(finding, sources)}
    </section>`).join('')}
  </div>` : '';
  return `<div class="review-report" lang="ru">
    <header class="report-head">
      <div class="report-letterhead"><div><strong>КружИИво</strong><span>Предварительная проверка НПА</span></div><p>${esc(org)}</p></div>
      <h1>Аналитический отчёт</h1><p class="report-subtitle">по результатам предварительной проверки проекта НПА</p>
      <div class="report-head-status">${badge('pending', 'ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ')} <span>${esc(status)}</span></div>
    </header>

    <section class="report-section report-details" aria-label="Реквизиты">
      <dl>
        <dt>Документ</dt><dd><strong>${esc(doc.name)}</strong></dd>
        <dt>Версия и запуск</dt><dd>${esc(versionLabel)}</dd>
        <dt>Дата проверки</dt><dd>${esc(moscowTime(run.createdAt))}</dd>
        <dt>Специалист</dt><dd>${esc(author.fullName || 'Не указан')}<span class="report-small">${esc(author.position || 'Должность не указана')}</span></dd>
        <dt>Орган и подразделение</dt><dd>${esc(org)}</dd>
        <dt>Режим проверки</dt><dd class="report-small">${esc(model)}</dd>
        <dt>Версия инструкций</dt><dd class="report-small">${esc(instructions)}</dd>
        <dt>SHA-256 документа</dt><dd class="report-hash"><code>${hashRows.map(row => `<span>${esc(row)}</span>`).join('')}</code>${
          !print && hashRows.length === 2 ? `<button type="button" class="report-copy no-report-print" data-report-copy="${esc(hash)}">Копировать</button>` : ''}</dd>
      </dl>
    </section>

    <section class="report-section report-summary">
      <h2>Результаты</h2>
      <div class="report-total"><strong>${findings}</strong><div>Замечания, выявленные ИИ<span>Рассмотрено ${countReviewed} из ${findings}</span></div></div>
      <div class="report-counts">${decisions.map(({ status, label, count }) => `<div class="report-count report-${status}">
        <strong>${count}</strong><span><span aria-hidden="true">${symbols[status]}</span> ${label}</span>
        <meter min="0" max="${findings || 1}" value="${count}" aria-label="${label}: ${count} из ${findings}"></meter>
      </div>`).join('')}</div>
      <div class="report-matrix-wrap"><strong>Охват Методики</strong><div class="report-matrix">${coverage.map(row => `<div class="report-cell report-${row.status}"
        title="${esc(row.title)}" aria-label="${esc(row.reference)}. ${esc(row.label)}"><span aria-hidden="true">${symbols[row.status]}</span> ${esc(row.locator)}</div>`).join('')}</div></div>
      ${missing ? note('warning', '!', `Нормативные основания не указаны у ${missing} неотклонённых замечаний. Проверьте основания до использования отчёта.`) : ''}
      ${note('info', 'i', disclaimer)}
    </section>

    <section class="report-section report-limits">
      ${print ? `<h2>Ограничения проверки <small>${limitations.length}</small></h2>${notes}`
        : `<details><summary><h2>Ограничения проверки <small>${limitations.length}</small></h2></summary>${notes}</details>`}
    </section>

    <section class="report-section report-coverage">
      <h2>Охват факторов Методики</h2>
      <p class="report-small">${methodology}</p>
      <div class="report-legend" aria-label="Обозначения">${coverageStates.map(([key, label]) => badge(key, label)).join('')}</div>
      <table class="report-table"><thead><tr><th scope="col">Пункт Методики</th><th scope="col">Статус</th><th scope="col">Комментарий системы</th></tr></thead>
        <tbody>${coverageItems || '<tr><td colspan="3">Не записано.</td></tr>'}</tbody></table>
    </section>

    <section class="report-section report-remarks">
      <h2>Замечания <small>${findings}</small></h2>
      ${findings >= 20 ? sectionLinks : ''}${filter}
      ${findings ? remarks.map(item => remarkCard(item, sources, catalog, print, run.id)).join('')
        : run.status === 'completed' ? note('success', '✓', 'Замечаний не выявлено') : note('info', 'i', 'Замечания не записаны.')}
      ${reviewAppendix}
    </section>

    <section class="report-section report-snapshot">
      <h2>Снимок источников запуска</h2>
      <dl>${sources.length ? sources.map(source => `<dt>${esc(source.title)}</dt><dd>${esc(source.revision)} · ${esc(source.url)} · проверено специалистом: ${esc(source.verifiedAt || 'нет')}</dd>`).join('')
        : '<dt>Источники</dt><dd>Не передавались</dd>'}
        <dt>Версия инструкций ИИ</dt><dd>${esc(instructions)}</dd>
        <dt>Каталог</dt><dd>${esc(run.aiPolicy?.catalogId || 'Не записан')}${
          run.aiPolicy ? ` · утверждение: ${run.aiPolicy.catalogApproved ? 'отмечено' : badge('pending', 'не подтверждено')}` : ''}</dd>
      </dl>
      ${run.aiPolicy ? note('info', 'i', 'Учебные материалы использованы как методические подсказки, а не правовые основания.') : ''}
    </section>

    <section class="report-section report-signature">
      <h2>Работу проверил</h2>
      <dl><div><dt>ФИО</dt><dd></dd></div><div><dt>Подпись</dt><dd></dd></div><div><dt>Дата</dt><dd></dd></div></dl>
      ${note('info', 'i', disclaimer)}
    </section>
    <footer class="report-web-footer">${reportDisclaimer}</footer>
  </div>`;
}
