import * as blob from '@vercel/blob';
import { randomUUID, createHash } from 'node:crypto';
import { seed } from './store.mjs';
import { extractDocx, fail } from './files.mjs';
import { sealKey, openKey } from './cloud-security.mjs';
import { legacyConnection, emptyConnection, normalizeConnection } from './providers.mjs';

const readOptions = { access: 'private', useCache: false };
const CONNECTION_ENVELOPE = 'kruzhivo-connection-v2:';
const writeOptions = { access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0, ttlDays: 30 };
export function createCloudStore(workspace, master, storage = blob, { initialDb = seed } = {}) {
  const prefix = `workspaces/${workspace}/`, path = prefix + 'state.json';
  let queue = Promise.resolve();
  async function readState() {
    const result = await storage.get(path, readOptions);
    if (!result || result.statusCode === 404) return null;
    if (result.statusCode !== 200) throw fail('Рабочее пространство недоступно. Обновите страницу.',503);
    const state = await new Response(result.stream).json();
    if (state.db?.schemaVersion !== 1) throw fail('Несовместимое хранилище.',503);
    return state;
  }
  async function requireState() {
    const state=await readState();
    if(!state)throw fail('Рабочее пространство недоступно. Обновите страницу.',503);
    return state;
  }
  function mutate(fn) {
    const operation = queue.then(async () => {
      // Retry only the pure mutation against the latest snapshot, with an atomic ETag guard.
      for (let attempt = 0; attempt < 5; attempt++) {
        // Conditional writes still use the storage ETag read before the snapshot.
        const {etag}=await storage.head(path),state=await requireState(),result=fn(state);
        const serialized = JSON.stringify(state);
        try { await storage.put(path, serialized, { ...writeOptions, allowOverwrite: true, ifMatch: etag }); return result; }
        catch (e) { if (!(e instanceof blob.BlobPreconditionFailedError) && e.name !== 'BlobPreconditionFailedError') throw e; }
      }
      throw fail('Данные изменяются в другой вкладке. Повторите действие.', 409);
    });
    queue = operation.catch(() => {}); return operation;
  }
  return {
    async ensure() {
      const existing=await readState();
      if(existing)return existing.db;
      try{return await this.initialize();}
      catch(error){const raced=await readState();if(!raced)throw error;return raced.db;}
    },
    async initialize() {
      const db=initialDb();
      await storage.put(path,JSON.stringify({db,credential:null}),{...writeOptions,allowOverwrite:false});
      return db;
    },
    async read() { return (await requireState()).db; },
    change(fn) { return mutate(s => {
      const result = fn(s.db);
      if (s.db.documents.length > 40 || s.db.examples.length > 100 || s.db.documents.some(d => d.runs.length > 40 || d.versions.length > 40)) throw fail('Достигнут лимит учебного рабочего пространства.', 413);
      const runs = s.db.documents.flatMap(d => d.runs);
      if (runs.filter(r => r.status === 'running').length > 1) throw fail('Дождитесь завершения текущей проверки или остановите её.', 429);
      if (runs.filter(r => r.mode === 'api' && Date.now() - Date.parse(r.createdAt) < 3600000).length > 8) throw fail('Лимит демки — 8 запусков API в час. Повторите позже.', 429);
      return result;
    }); },
    async credential() {
      const state=await requireState(),c=state.credential;
      if (!c) { const connection = normalizeConnection(state.connection || emptyConnection(), { allowEmptyModel: true }); return { key: '', model: connection.model, connection, expiresAt: null, revision: null }; }
      // Legacy expiry timestamps are ignored too: existing keys need no re-entry.
      const plaintext = openKey(c.ciphertext, workspace, master);
      // Detect the format inside the authenticated ciphertext; outer metadata is not authority.
      const payload = plaintext.startsWith(CONNECTION_ENVELOPE) ? JSON.parse(plaintext.slice(CONNECTION_ENVELOPE.length)) : { key: plaintext, connection: legacyConnection(c.model) };
      const connection = normalizeConnection(payload.connection);
      return { key: payload.key, model: connection.model, connection, expiresAt: null, revision: c.revision };
    },
    setCredential(key, model, settings) {
      const connection = normalizeConnection(settings || legacyConnection(model), { allowEmptyModel: !key });
      return mutate(s => { s.connection = connection; s.credential = key ? { format: 2, ciphertext: sealKey(CONNECTION_ENVELOPE + JSON.stringify({ key, connection }), workspace, master), revision: randomUUID() } : null; });
    },
    async validCredential(revision) { const c=(await requireState()).credential; return !!revision && c?.revision === revision; },
    async recover(snapshot) {
      const db=snapshot||await this.read();
      if(!db.documents.some(d=>d.runs.some(r=>r.status==='running'&&Date.now()-Date.parse(r.createdAt)>300000)))return db;
      return this.change(db => { for (const d of db.documents) for (const r of d.runs) if (r.status === 'running' && Date.now() - Date.parse(r.createdAt) > 300000) {
        r.status = 'failed'; r.error = 'Проверка прервана или превысила время выполнения. Частичные результаты сохранены; создайте новый запуск.'; r.finishedAt = new Date().toISOString();
        for (const stage of Object.keys(r.stages)) { if (r.stages[stage] === 'running') r.stages[stage] = 'failed'; else if (r.stages[stage] === 'queued') r.stages[stage] = 'not_started'; }
      } return db; });
    },
    originals: {
      async prepare(fileName, base64) {
        if (typeof fileName !== 'string' || fileName.length > 250 || !fileName.toLowerCase().endsWith('.docx')) throw fail('Добавьте DOCX или вставьте текст.');
        if (typeof base64 !== 'string' || base64.length > 4194304 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('Некорректный или слишком большой файл.');
        const bytes = Buffer.from(base64, 'base64'); if (bytes.length > 3 * 1024 * 1024) throw fail('Максимальный размер DOCX — 3 МБ.', 413);
        const text = extractDocx(bytes), uploadId = randomUUID();
        await storage.put(prefix + `pending/${uploadId}.json`, JSON.stringify({ fileName, base64, text, at: Date.now() }), { ...writeOptions, ttlDays: 1, allowOverwrite: false });
        return { text, fileName, uploadId, size: bytes.length };
      },
      async attach(uploadId, version) {
        if (!uploadId) return;
        if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw fail('Некорректный файл.', 400);
        const pendingPath = prefix + `pending/${uploadId}.json`, result = await storage.get(pendingPath, readOptions);
        if (!result || result.statusCode !== 200) throw fail('Подготовленный файл устарел. Загрузите его ещё раз.', 409);
        const entry = JSON.parse(await new Response(result.stream).text());
        if (Date.now() - entry.at > 1800000) throw fail('Подготовленный файл устарел. Загрузите его ещё раз.', 409);
        if (entry.text !== version.text) throw fail('Текст отличается от DOCX. Загрузите файл ещё раз.', 400);
        const bytes = Buffer.from(entry.base64, 'base64'), fileId = randomUUID();
        await storage.put(prefix + `originals/${fileId}.docx`, bytes, { ...writeOptions, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', allowOverwrite: false });
        version.original = { fileId, fileName: entry.fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; version.fileName = entry.fileName;
        await storage.del(pendingPath);
      },
      async discard(version) { if (version.original) await storage.del(prefix + `originals/${version.original.fileId}.docx`); },
      async read(version) {
        if (!version.original || !/^[a-f0-9-]{36}$/.test(version.original.fileId)) throw fail('Для этой версии оригинальный DOCX не сохранён.', 404);
        const result = await storage.get(prefix + `originals/${version.original.fileId}.docx`, readOptions);
        if (!result || result.statusCode !== 200) throw fail('Оригинал недоступен.', 404);
        const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== version.original.sha256) throw fail('Оригинал не прошёл проверку целостности.', 500);
        return bytes;
      },
    },
  };
}
