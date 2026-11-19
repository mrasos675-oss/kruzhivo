import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentRun, pendingCurrent, proposalForDecision } from '../shared/review.mjs';
import { createApp } from '../server/index.mjs';
import { createStore, newRun } from '../server/store.mjs';
import { extractDocx } from '../server/files.mjs';

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kruzhivo-regression-'));
  const app = await createApp({ dataDir: dir, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, data, method = 'POST') => {
    const response = await fetch(base + '/api/' + path, data === undefined ? {} : {
      method,
      headers: { Origin: base, 'x-kruzhivo-client': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, dir, base, request, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

// Completing an older rerun must not relabel the latest uploaded document.
test('Current card and pending count belong to newest version, including an untested version', () => {
  const pending = { decision: { status: 'pending' } };
  const doc = { versions: [{ id: 'v1' }, { id: 'v2' }], runs: [
    { id: 'r1', versionId: 'v1', status: 'completed', findings: [pending] },
    { id: 'r2', versionId: 'v2', status: 'completed', findings: [pending, pending] },
    { id: 'old-rerun', versionId: 'v1', status: 'completed', findings: [pending] },
  ] };
  assert.equal(currentRun(doc).id, 'r2');
  assert.equal(pendingCurrent([doc]), 2);
  doc.versions.push({ id: 'v3' });
  assert.equal(currentRun(doc), undefined);
  assert.equal(pendingCurrent([doc]), 0);
});

test('Saved empty correction is retained instead of resurrecting AI proposal', () => {
  const f = { editor: { proposal: 'Исходный проект редактора' }, decision: { revision: 0, proposal: '' } };
  assert.equal(proposalForDecision(f), 'Исходный проект редактора');
  f.decision = { revision: 1, proposal: '', status: 'confirmed' };
  assert.equal(proposalForDecision(f), '');
  f.decision.proposal = 'Собственная редакция специалиста';
  assert.equal(proposalForDecision(f), 'Собственная редакция специалиста');
});

test('Empty human correction survives export and saving a checked example', async () => {
  const f = await fixture();
  try {
    const db = (await f.request('bootstrap')).body, run = db.documents[0].runs[0], finding = run.findings[0];
    assert.ok(finding.editor.proposal);
    assert.equal((await f.request(`runs/${run.id}/findings/${finding.id}`, { status: 'confirmed', revision: 0, explanation: 'Риск подтверждён, правка не предложена', proposal: '' }, 'PUT')).status, 200);
    const example = await f.request('examples', { runId: run.id, findingId: finding.id });
    const after = (await f.request('bootstrap')).body;
    assert.equal(after.examples.find(x => x.id === example.body.id).proposal, '');
    const report = await fetch(`${f.base}/api/runs/${run.id}/report.docx`);
    const text = extractDocx(Buffer.from(await report.arrayBuffer()));
    assert.match(text, /Редакция специалиста: правка не предложена/);
    assert.match(text, /Проект редактора \(не решение специалиста\)/);
    assert.equal((await fetch(`${f.base}/review.mjs`)).status, 200);
  } finally { await f.close(); }
});

test('Restart marks interrupted stages failed and preserves finished outputs and human decisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kruzhivo-restart-'));
  try {
    const store = await createStore(dir);
    await store.change(db => {
      const doc = db.documents[0];
      doc.runs[0].findings[0].decision = { status: 'rejected', revision: 1, explanation: 'Сохранённое решение', proposal: '', basis: '' };
      const run = newRun(doc, doc.versions[0], 'api', [], [], 'deepseek-flash');
      run.findings = structuredClone(doc.runs[0].findings);
      run.stages = { analyst: 'completed', reviewer: 'running', editor: 'queued' };
      doc.runs.push(run);
    });
    const app = await createApp({ dataDir: dir });
    const runs = app.store.read().documents[0].runs;
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].findings[0].decision.explanation, 'Сохранённое решение');
    assert.equal(runs.at(-1).status, 'failed');
    assert.deepEqual(runs.at(-1).stages, { analyst: 'completed', reviewer: 'failed', editor: 'not_started' });
    assert.equal(runs.at(-1).findings.length, 3);
    assert.ok(runs.at(-1).finishedAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const status of [401, 402, 429]) {
  test(`Provider HTTP ${status} finishes run truthfully and keeps earlier review`, async () => {
    const f = await fixture({ initialKey: 'not-a-real-key', fetcher: async () => new Response('not-a-real-key', { status }) });
    try {
      const doc = (await f.request('bootstrap')).body.documents[0];
      const created = await f.request(`documents/${doc.id}/runs`, { versionId: doc.versions[0].id, mode: 'api' });
      let result;
      for (let attempt = 0; attempt < 50; attempt++) {
        result = (await f.request('bootstrap')).body.documents[0].runs.find(r => r.id === created.body.id);
        if (result.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(result.status, 'failed');
      assert.equal(result.stages.analyst, 'failed');
      assert.equal(result.stages.reviewer, 'not_started');
      assert.ok(!result.error.includes('not-a-real-key'));
      assert.equal((await f.request('bootstrap')).body.documents[0].runs[0].status, 'completed');
    } finally { await f.close(); }
  });
}
