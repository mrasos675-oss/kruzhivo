import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { newSession, sessionFromCookie, sealKey, openKey, checkOrigin } from '../server/cloud-security.mjs';
import { createCloudStore } from '../server/cloud-store.mjs';
import { createApp } from '../server/index.mjs';

const master = randomBytes(32).toString('base64url');
function memoryBlob() {
  const files = new Map(); let revision = 0;
  return { files,
    async head(path) { const v = files.get(path); if (!v) throw new Error('Missing'); return { etag: v.etag }; },
    async get(path) { const v = files.get(path); return v ? { statusCode: 200, stream: new Blob([v.bytes]).stream(), blob: { etag: 'W/"download-' + v.etag + '"' } } : null; },
    async put(path, data, options) {
      const before = files.get(path);
      if (options.ifMatch && before?.etag !== options.ifMatch) throw Object.assign(new Error('Conflict'), { name: 'BlobPreconditionFailedError' });
      if (before && options.allowOverwrite === false) throw new Error('Already exists');
      assert.equal(options.access, 'private'); assert.equal(options.addRandomSuffix, false);
      const etag = String(++revision); files.set(path, { bytes: Buffer.from(data), etag }); return { etag };
    },
    async del(path) { files.delete(path); },
  };
}

test('Signed session cannot be forged, changed, expired or reused under a different secret', () => {
  const s = newSession(master), header = s.cookie.split(';')[0];
  assert.equal(sessionFromCookie(header, master).id, s.id);
  assert.equal(sessionFromCookie(header.replace(s.id, '0'.repeat(64)), master), null);
  assert.equal(sessionFromCookie(header, 'x'.repeat(43)), null);
  assert.equal(sessionFromCookie(header, master, s.expiry + 1), null);
  assert.equal(sessionFromCookie('__Host-kruzhivo=bad', master), null);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(s.cookie.includes(flag));
});

test('AES-GCM ciphertext is bound to a workspace and tampering fails closed', () => {
  const cipher = sealKey('sk-test-not-a-real-key', 'alice', master);
  assert.ok(!cipher.includes('sk-test'));
  assert.equal(openKey(cipher, 'alice', master), 'sk-test-not-a-real-key');
  assert.throws(() => openKey(cipher, 'bob', master));
  assert.throws(() => openKey(cipher.slice(0, 20) + (cipher[20] === 'A' ? 'B' : 'A') + cipher.slice(21), 'alice', master));
});

test('Cloud workspace survives another instance; key stays encrypted, scoped and revocable after eight hours', async t => {
  const storage = memoryBlob(), a = createCloudStore('a', master, storage), b = createCloudStore('b', master, storage);
  await a.initialize(); await b.initialize();
  await a.setCredential('sk-private-sentinel', 'deepseek-flash');
  const c = await a.credential(); assert.equal(c.key, 'sk-private-sentinel');
  assert.equal(c.expiresAt, null);
  const later = Date.now() + 9 * 3600000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(await a.validCredential(c.revision), true);
  assert.equal((await b.credential()).key, '');
  assert.ok(!JSON.stringify(await a.read()).includes('credential'));
  assert.ok(!storage.files.get('workspaces/a/state.json').bytes.includes('sk-private-sentinel'));
  const next = createCloudStore('a', master, storage);
  assert.equal((await next.credential()).key, c.key);
  await a.change(db => { db.documents[0].name = 'Private Alice document'; });
  assert.equal((await next.read()).documents[0].name, 'Private Alice document');
  assert.notEqual((await b.read()).documents[0].name, 'Private Alice document');
  await a.setCredential('', 'deepseek-flash');
  assert.equal(await next.validCredential(c.revision), false);
  assert.equal((await next.credential()).key, '');
});

test('Existing keys with legacy expiry timestamps remain usable until replaced or disconnected', async () => {
  const storage = memoryBlob(), a = createCloudStore('legacy', master, storage);
  await a.initialize(); await a.setCredential('sk-legacy-sentinel', 'deepseek-flash');
  const entry = storage.files.get('workspaces/legacy/state.json');
  const data = JSON.parse(entry.bytes); data.credential.expiresAt = Date.now() - 3600000;
  data.credential = { ciphertext: sealKey('sk-legacy-sentinel', 'legacy', master), model: 'deepseek-flash', revision: 'legacy-revision', expiresAt: data.credential.expiresAt };
  entry.bytes = Buffer.from(JSON.stringify(data));
  const old = await a.credential();
  assert.equal(old.key, 'sk-legacy-sentinel'); assert.equal(old.expiresAt, null);
  assert.equal(await a.validCredential(old.revision), true);
  await a.setCredential('sk-replacement-sentinel', 'deepseek-flash');
  assert.equal(await a.validCredential(old.revision), false);
  const fresh = await a.credential(); assert.equal(fresh.key, 'sk-replacement-sentinel');
  await a.setCredential('', 'deepseek-flash');
  assert.equal(await a.validCredential(fresh.revision), false);
});

test('Provider settings are sealed together with the key and survive another instance', async () => {
  const storage = memoryBlob(), store = createCloudStore('custom', master, storage); await store.initialize();
  const connection = { provider: 'custom', protocol: 'responses', baseUrl: 'https://api.example.com/v1', model: 'chosen-model', jsonMode: false, maxTokens: 4096 };
  await store.setCredential('custom-sentinel-key', connection.model, connection);
  const entry = storage.files.get('workspaces/custom/state.json'), state = JSON.parse(entry.bytes);
  assert.ok(!entry.bytes.includes('custom-sentinel-key'));
  state.connection.baseUrl = 'https://attacker.example.com'; delete state.credential.format; state.credential.model = 'tampered-model'; entry.bytes = Buffer.from(JSON.stringify(state));
  const second = createCloudStore('custom', master, storage), result = await second.credential();
  assert.equal(result.key, 'custom-sentinel-key'); assert.equal(result.connection.baseUrl, connection.baseUrl);
  assert.equal(result.connection.protocol, 'responses'); assert.equal(result.connection.model, connection.model);
  await second.setCredential('', connection.model, connection);
  const cleared = await second.credential(); assert.equal(cleared.key, ''); assert.equal(cleared.connection.provider, 'custom');
});

test('Atomic ETag mutations from separate instances preserve both concurrent changes', async () => {
  const storage = memoryBlob(), a = createCloudStore('a', master, storage), b = createCloudStore('a', master, storage);
  await a.initialize();
  await Promise.all([a.change(db => db.examples.push({ id: 'a' })), b.change(db => db.examples.push({ id: 'b' }))]);
  assert.deepEqual((await a.read()).examples.map(x => x.id).sort(), ['a', 'b']);
});

test('Cross-origin writes and missing JSON/client guard are rejected', () => {
  const req = { method: 'POST', headers: { host: 'example.vercel.app', origin: 'https://example.vercel.app', 'x-kruzhivo-client': '1', 'content-type': 'application/json' } };
  assert.equal(checkOrigin(req), req.headers.origin);
  assert.throws(() => checkOrigin({ ...req, headers: { ...req.headers, origin: 'https://evil.test' } }));
  assert.throws(() => checkOrigin({ ...req, headers: { ...req.headers, 'x-kruzhivo-client': '' } }));
  assert.throws(() => checkOrigin({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } }));
});

test('Hosted demo runs through persistent cloud adapter and only scheduled work, without a paid request', async t => {
  const storage = memoryBlob(), store = createCloudStore('a', master, storage); await store.initialize();
  const work = [];
  const app = await createApp({ hosted: true, store, originals: store.originals, initialKey: '', origin: 'https://demo.test', schedule: promise => work.push(promise) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(bootstrap.config.hosted, true); assert.equal(bootstrap.config.configured, false);
  const doc = bootstrap.documents[2];
  const response = await fetch(base + `/api/documents/${doc.id}/runs`, { method: 'POST', headers: { origin: 'https://demo.test', 'content-type': 'application/json', 'x-kruzhivo-client': '1' }, body: JSON.stringify({ mode: 'demo', versionId: doc.versions[0].id }) });
  assert.equal(response.status, 202); const run = await response.json();
  await Promise.all(work);
  const fresh = createCloudStore('a', master, storage);
  const result = (await fresh.read()).documents.find(d => d.id === doc.id).runs.find(r => r.id === run.id);
  assert.equal(result.status, 'completed'); assert.equal(result.findings.length, 3);
});
