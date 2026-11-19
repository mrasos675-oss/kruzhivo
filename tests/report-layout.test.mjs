import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../server/catalog.mjs';
import { reportPdf } from '../server/pdf-report.mjs';
import { seed } from '../server/store.mjs';
import { renderReport } from '../shared/report-view.mjs';

test('The report preserves source content, labels missing data and links 12 factors to remarks', () => {
  const doc = seed().documents[0];
  const version = doc.versions[0];
  const run = doc.runs[0];
  const empty = renderReport(doc, version, { ...run, findings: [], coverage: [] }, {}, CATALOG);
  assert.match(empty, /Замечаний не выявлено/);
  assert.equal((empty.match(/class="report-cell /g) || []).length, 12);
  const incomplete = renderReport(doc, version, { ...run, status: 'failed', findings: [], coverage: [] }, {}, CATALOG);
  assert.match(incomplete, /Замечания не записаны/);

  doc.name = '</style><script>alert(1)</script>';
  const finding = run.findings[0];
  finding.review.documentAssessment = { status: 'partial', summary: 'В договоре указан срок. Порядок подачи заявки требует уточнения.' };
  finding.editor.nextStep = 'Согласовать порядок подачи заявки.';
  finding.quote = '- Оригинальная цитата\n- <текст> без изменений';
  finding.decision = { ...finding.decision, status: 'modified', proposal: 'Редакция для публикации.' };
  const html = renderReport(doc, version, run, { fullName: 'Тестовый специалист' }, CATALOG);
  assert.doesNotMatch(html, /<script>|QR-код/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(html.includes('- Оригинальная цитата\n- &lt;текст&gt; без изменений'));
  assert.match(html, /href="#report-remark-1"/);
  assert.match(html, /Редакция для публикации\./);
  assert.match(html, /Тестовый специалист/);
  assert.match(html, /Подтверждается частично/);
  assert.match(html, /Правовая оценка/);
  assert.match(html, /Что сделать дальше/);
  assert.match(html, /Согласовать порядок подачи заявки/);
  assert.match(html, /data-report-copy="[a-f0-9]{64}"/);
});

test('The PDF uses the report layout, embeds Cyrillic text and fits under 2 MB', async () => {
  const doc = seed().documents[0];
  const version = doc.versions[0];
  const run = doc.runs[0];
  const basis = [...run.findings];
  const states = ['pending', 'confirmed', 'modified', 'rejected'];
  run.findings = Array.from({ length: 50 }, (_, i) => {
    const finding = structuredClone(basis[i % basis.length]);
    finding.id = 'test-' + i;
    finding.decision.status = states[i % states.length];
    if (i === 0) finding.quote += '\n' + '- Значимая для проверки цитата не сокращается.\n'.repeat(125);
    return finding;
  });

  const html = renderReport(doc, version, run, {}, CATALOG);
  assert.match(html, /Показать цитату полностью/);
  assert.match(html, /data-report-factor/);
  const bytes = await reportPdf(doc, version, run);
  const pdf = bytes.toString('latin1');
  assert.ok(bytes.length < 2_000_000);
  assert.match(pdf, /^%PDF-/);
  assert.match(pdf, /\/MediaBox\s*\[0 0 59[45]\.[\d]+ 84[12]\.[\d]+\]/);
  assert.match(pdf, /\/ToUnicode \d+ 0 R/);
  assert.match(pdf, /\/Subtype \/Link/);
});
