import { buildProvisionGraph } from '../shared/provision-graph.mjs';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CATALOG, SAMPLE_TEXT, CLEAN_TEXT, demoAnalysis, demoReview, demoEdit } from './catalog.mjs';
import { decision } from './engine.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = s => createHash('sha256').update(s).digest('hex');
export function version(text, number = 1, fileName = 'Вставленный текст') { return { id: id(), number, text, hash: hash(text), fileName, createdAt: now() }; }
export function newRun(doc, v, mode, sources, examples, model) {
  const active = sources.filter(s => s.active && s.verified && s.text && s.revision);
  const sourceIds = new Set(active.map(s => s.id));
  return { id: id(), docId: doc.id, versionId: v.id, number: doc.runs.filter(r => r.versionId === v.id).length + 1, mode, model: mode === 'demo' ? 'Подготовленный пример' : model, createdAt: now(), status: 'running', stages: { analyst: 'queued', reviewer: 'queued', editor: 'queued' }, findings: [], provisionGraph: typeof v.text==='string'?buildProvisionGraph(v.text):null, coverage: [], limitations: [CATALOG.note, ...(!active.length ? ['Проверенные нормативные источники не предоставлены. Правовые основания требуют проверки.'] : [])], sources: structuredClone(active), examples: structuredClone(examples.filter(e => e.active && e.verified && e.sourceIds?.length && e.sourceIds.every(s => sourceIds.has(s)))) };
}

export function seed() {
  const documents = [['Порядок выдачи разрешения', SAMPLE_TEXT], ['Предоставление выписки', CLEAN_TEXT], ['Порядок выдачи разрешения · черновик', SAMPLE_TEXT]].map(([name, text], index) => {
    const d = { id: id(), name, sample: true, createdAt: now(), versions: [version(text, 1, 'Демонстрационный документ')], runs: [] };
    if (index !== 2) {
      const r = newRun(d, d.versions[0], 'demo', [], [], ''); const a = demoAnalysis(text);
      r.coverage = a.coverage; r.limitations.push(...a.limitations); r.findings = a.findings.map(f => ({ ...f, decision: decision() }));
      r.provisionGraph=buildProvisionGraph(text,r.findings);
      const reviews = demoReview(r.findings); r.findings.forEach(f => { f.review = reviews.find(x => x.findingId === f.id); });
      const edits = demoEdit(r.findings); r.findings.forEach(f => { f.editor = edits.find(x => x.findingId === f.id) ? { ...edits.find(x => x.findingId === f.id), status: 'prepared' } : { status: 'skipped', reason: 'Обнаружено возражение в пункте 2.6.' }; });
      r.status = 'completed'; r.stages = { analyst: 'completed', reviewer: r.findings.length ? 'completed' : 'skipped', editor: r.findings.length ? 'completed' : 'skipped' }; d.runs.push(r);
    }
    return d;
  });
  return { schemaVersion: 1, documents, sources: [], examples: [] };
}

export async function createStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const path = join(directory, 'workspace.json'); let db;
  try { db = JSON.parse(await readFile(path, 'utf8')); if (db.schemaVersion !== 1 || !Array.isArray(db.documents)) throw new Error('Несовместимое хранилище. Исходный файл сохранён.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; db = seed(); }
  const persist = async data => { const temp = join(directory, `.workspace-${id()}.tmp`); await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temp, path); };
  await persist(db);
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(db),
    change(fn) {
      const operation = queue.then(async () => { const next = structuredClone(db); const result = fn(next); await persist(next); db = next; return result; });
      queue = operation.catch(() => {}); return operation;
    },
  };
}
