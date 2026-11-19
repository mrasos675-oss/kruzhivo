import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeConnection, normalizeBaseUrl, publicAddress, guardedLookup, providerRequest, legacyConnection, requestProvider } from '../server/providers.mjs';
import { completion } from '../server/engine.mjs';
import { createApp } from '../server/index.mjs';
import { SAMPLE_TEXT, demoAnalysis } from '../server/catalog.mjs';
import { Agent, fetch as networkFetch } from 'undici';

const custom = patch => normalizeConnection({ provider: 'custom', protocol: 'chat-completions', baseUrl: 'https://api.example.com/v1', model: 'vendor/arbitrary-model:free', ...patch });

test('Models are arbitrary IDs; fixed providers cannot be redirected by client-supplied URLs', () => {
  assert.equal(custom().model, 'vendor/arbitrary-model:free');
  const c = normalizeConnection({ provider: 'openai', baseUrl: 'https://attacker.example.com', protocol: 'gemini', model: 'chosen-model' });
  assert.equal(c.baseUrl, 'https://api.openai.com/v1'); assert.equal(c.protocol, 'responses');
  assert.throws(() => custom({ model: 'bad\nheader' }), /ID/);
  assert.throws(() => custom({ model: '' }), /ID/);
  assert.equal(custom({ maxTokens: 8192 }).maxTokens,null);
  assert.throws(() => custom({ protocol:'anthropic',maxTokens:0 }), /лимит/);
  assert.throws(() => custom({ protocol: 'unsupported' }), /формат/);
});
test('Polza requires an explicit model ID and forwards it unchanged', async () => {
  const c = normalizeConnection({ provider: 'polza', model: 'deepseek/deepseek-v4.1-flash-1017', maxTokens:8192, baseUrl: 'https://attacker.example.com', protocol: 'gemini' });
  assert.equal(c.baseUrl, 'https://polza.ai/api/v1');
  assert.equal(c.protocol, 'chat-completions');
  assert.equal(c.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.throws(() => normalizeConnection({ provider: 'polza' }), /ID/);
  assert.equal(normalizeConnection({ provider: 'polza', model: 'other/model' }).model, 'other/model');
  let calls = 0;
  const result = await completion('Return JSON', { document: 'Тест' }, { connection: c, key: 'polza-test-key', fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://polza.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer polza-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, c.model);
    assert.ok(!Object.hasOwn(body,'max_tokens'));
    assert.equal(body.thinking, undefined);
    assert.ok(!options.body.includes('polza-test-key'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  } });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 1);
});
test('API addresses reject local, reserved, credential-bearing and redirect-style URLs', () => {
  for (const address of ['http://api.example.com', 'https://localhost', 'https://127.0.0.1', 'https://2130706433', 'https://10.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://user:secret@api.example.com', 'https://api.example.com/?key=secret', 'https://api.example.com/#secret', 'https://api.example.com:8443', 'https://service.internal']) assert.throws(() => normalizeBaseUrl(address), address);
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/chat/completions/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(publicAddress('93.184.216.34'), true); assert.equal(publicAddress('127.0.0.1'), false);
  assert.equal(publicAddress('fc00::1'), false); assert.equal(publicAddress('::ffff:169.254.169.254'), false);
});
test('DNS checks block private resolutions and rebinding on each connection', async () => {
  const call = records => new Promise(resolve => guardedLookup('api.example.com', { all: true }, (error, result) => resolve({ error, result }), (_host, _opts, callback) => callback(null, records)));
  assert.ok((await call([{ address: '127.0.0.1', family: 4 }])).error);
  assert.ok((await call([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).error);
  assert.equal((await call([{ address: '93.184.216.34', family: 4 }])).result[0].address, '93.184.216.34');
  assert.ok((await call([{ address: '169.254.169.254', family: 4 }])).error);
});
test('Native HTTP transport invokes the guarded DNS lookup before opening a private connection', async t => {
  let lookedUp = false;
  const dispatcher = new Agent({ connect: { lookup: (hostname, options, callback) => guardedLookup(hostname, options, callback, (_hostname, _options, done) => { lookedUp = true; done(null, [{ address: '127.0.0.1', family: 4 }]); }) } });
  t.after(() => dispatcher.close());
  await assert.rejects(networkFetch('https://api.example.com', { dispatcher, signal: AbortSignal.timeout(1000) }), e => e.cause?.message === 'API_NETWORK_BLOCKED');
  assert.equal(lookedUp, true);
});
test('Each protocol uses the correct authentication, request shape and response parser', async () => {
  for (const protocol of ['chat-completions', 'responses', 'anthropic', 'gemini']) {
    const c = custom({ protocol, workspaceId: 'wrkspc_test',maxTokens:32768 }); let calls = 0;
    const output = { answer: 'Проверено' }, encoded = JSON.stringify(output);
    const fetcher = async (url, options) => {
      calls++; assert.equal(options.redirect, 'manual'); assert.ok(options.dispatcher);
      assert.ok(!url.includes('sentinel-key')); const b = JSON.parse(options.body);
      assert.equal(b.thinking, undefined); assert.equal(b.model || c.model, c.model);
      if(protocol!=='anthropic'){
        assert.ok(!Object.hasOwn(b,'max_tokens'));
        assert.ok(!Object.hasOwn(b,'max_output_tokens'));
        assert.ok(!Object.hasOwn(b.generationConfig||{},'maxOutputTokens'));
      }
      if (protocol === 'anthropic') {
        assert.equal(b.max_tokens,32768);
        assert.equal(options.headers['x-api-key'], 'sentinel-key'); assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['anthropic-workspace-id'], 'wrkspc_test'); assert.equal(b.system, 'Return JSON');
        return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: encoded }] });
      }
      if (protocol === 'gemini') {
        assert.equal(options.headers['x-goog-api-key'], 'sentinel-key'); assert.equal(b.generationConfig.responseMimeType, 'application/json'); assert.ok(url.endsWith(':generateContent'));
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private reasoning', thought: true }, { text: encoded }] } }] });
      }
      assert.equal(options.headers.Authorization, 'Bearer sentinel-key');
      if (protocol === 'responses') {
        assert.equal(b.store, false); assert.equal(b.instructions, 'Return JSON'); assert.equal(b.text.format.type, 'json_object');
        return Response.json({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: encoded }] }] });
      }
      assert.equal(b.messages[0].content, 'Return JSON');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: encoded } }] });
    };
    assert.deepEqual(await completion('Return JSON', { document: 'Тест' }, { connection: c, key: 'sentinel-key', fetcher, signal: new AbortController().signal }), output);
    assert.equal(calls, 1);
  }
});
test('Custom JSON mode may be disabled, while DeepSeek-only thinking stays isolated', async () => {
  const c = custom({ jsonMode: false });
  assert.equal(providerRequest(c, 'key', 'JSON', {}).body.response_format, undefined);
  assert.deepEqual(providerRequest(legacyConnection('another-deepseek-model'), 'key', 'JSON', {}).body.thinking, { type: 'disabled' });
  assert.deepEqual(await completion('JSON', {}, { connection: c, key: 'key', fetcher: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{"ok":true}\n```' } }] }) }), { ok: true });
});
test('Redirects, provider errors and invalid responses never leak credentials or trigger automatic retries', async () => {
  for (const status of [302, 400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestProvider(custom(), 'sensitive-sentinel', 'JSON', {}, { fetcher: async () => { calls++; return new Response('sensitive-sentinel', { status, headers: { location: 'http://127.0.0.1/' } }); } }), e => !e.message.includes('sensitive-sentinel') && e.status === 502);
    assert.equal(calls, 1);
  }
  await assert.rejects(requestProvider(custom(), 'key', 'JSON', {}, { fetcher: async () => new Response('<html>wrong endpoint</html>') }), /некорректный ответ/);
  await assert.rejects(completion('JSON', {}, { connection: custom(), key: 'key', fetcher: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"partial":true}' } }] }) }), /не завершён/);
});
test('Settings preserve arbitrary models, never expose keys and require a new key for a new destination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kruzhivo-provider-'));
  const app = await createApp({ dataDir: dir, initialKey: 'old-deepseek-key', initialModel: 'legacy-custom-model' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = data => fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-kruzhivo-client': '1' }, body: JSON.stringify(data) });
  assert.equal((await call({ connection: custom() })).status, 400);
  let boot = await (await fetch(base + '/api/bootstrap')).json(); assert.equal(boot.config.connection.provider, 'deepseek');
  assert.equal((await call({ key: 'bad\nheader', connection: custom() })).status, 400);
  assert.equal((await call({ key: 'custom-provider-key', connection: custom() })).status, 200);
  boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(boot.config.connection.model, 'vendor/arbitrary-model:free'); assert.ok(!JSON.stringify(boot).includes('custom-provider-key'));
  assert.equal((await call({ connection: custom({ model: 'different-model' }) })).status, 200);
  assert.equal((await call({ connection: custom({ baseUrl: 'https://another.example.com/v1' }) })).status, 400);
  assert.equal((await call({ key: '', connection: custom() })).status, 200);
  boot = await (await fetch(base + '/api/bootstrap')).json(); assert.equal(boot.config.configured, false);
  assert.equal((await call({ key: 'polza-test-key', connection: { provider: 'polza' } })).status, 400);
  assert.equal((await call({ key: 'polza-test-key', connection: { provider: 'polza', model: 'deepseek/deepseek-v4.1-flash-1017' } })).status, 200);
  boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(boot.config.connection.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(boot.config.configured, true); assert.ok(!JSON.stringify(boot).includes('polza-test-key'));
});

test('Changing a destination during an analysis cannot forward its old or new key to the wrong provider', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kruzhivo-provider-race-'));
  let release, entered, calls = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await createApp({ dataDir: dir, initialKey: 'original-provider-key', fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer original-provider-key'); entered(); await gate;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(demoAnalysis(SAMPLE_TEXT)) } }] });
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { 'content-type': 'application/json', origin: base, 'x-kruzhivo-client': '1' };
  const doc = app.store.read().documents[2];
  const response = await fetch(base + `/api/documents/${doc.id}/runs`, { method: 'POST', headers, body: JSON.stringify({ mode: 'api', versionId: doc.versions[0].id }) });
  assert.equal(response.status, 202); await waiting;
  const change = await fetch(base + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ key: 'replacement-provider-key', connection: custom() }) });
  assert.equal(change.status, 200); release();
  const runId = (await response.json()).id;
  for (let i = 0; i < 100 && app.store.read().documents.find(d => d.id === doc.id).runs.find(r => r.id === runId).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.store.read().documents.find(d => d.id === doc.id).runs.find(r => r.id === runId).status, 'failed');
  assert.equal(calls, 1);
});
