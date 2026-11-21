import { setTimeout as delay } from 'node:timers/promises';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as networkFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { fail } from './files.mjs';

export const PROVIDERS = [
  { id: 'polza', title: 'Польза AI (Polza.ai)', protocol: 'chat-completions', baseUrl: 'https://polza.ai/api/v1' },
  { id: 'openai', title: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', title: 'DeepSeek', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com' },
  { id: 'openrouter', title: 'OpenRouter', protocol: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'anthropic', title: 'Anthropic / Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', title: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'groq', title: 'Groq', protocol: 'chat-completions', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', title: 'Mistral', protocol: 'chat-completions', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'custom', title: 'Другой совместимый API', protocol: 'chat-completions', baseUrl: '' },
];
export const PROTOCOLS = [
  { id: 'chat-completions', title: 'OpenAI Chat Completions' },
  { id: 'responses', title: 'OpenAI Responses' },
  { id: 'anthropic', title: 'Anthropic Messages' },
  { id: 'gemini', title: 'Gemini generateContent' },
];
export const legacyConnection = model => ({ provider: 'deepseek', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com', model: model || 'deepseek-flash', jsonMode: true, maxTokens: null, workspaceId: '' });
export const emptyConnection = () => ({ provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: '', jsonMode: true, maxTokens: null, workspaceId: '' });

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function normalizeBaseUrl(value) {
  let u; try { u = new URL(value); } catch { throw fail('Укажите полный HTTPS-адрес API.', 400); }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.href.length > 1000 || (u.port && u.port !== '443')) throw fail('Нужен HTTPS-адрес API без логина, пароля, параметров и нестандартного порта.', 400);
  if (!host.includes('.') && !isIP(host) || /(^|\.)(localhost|local|internal|lan|home|onion|test|invalid)$/.test(host) || (isIP(host) && !publicAddress(host))) throw fail('Адрес API должен быть публичным. Локальные и служебные адреса недоступны.', 400);
  u.pathname = u.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/+$/, '');
  return u.href.replace(/\/$/, '');
}
export function normalizeConnection(input, { allowEmptyModel = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Некорректные настройки API.', 400);
  const preset = PROVIDERS.find(p => p.id === input.provider);
  if (!preset) throw fail('Выберите провайдера API.', 400);
  const protocol = preset.id === 'custom' ? input.protocol : preset.protocol;
  if (!PROTOCOLS.some(p => p.id === protocol)) throw fail('Выберите поддерживаемый формат API.', 400);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!(allowEmptyModel && !model) && !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,199}$/.test(model)) throw fail('Укажите ID текстовой модели из кабинета вашего провайдера.', 400);
  // Only Anthropic Messages requires a limit in the request. Ignore legacy
  // limits for other protocols, including settings stored before this change.
  const maxTokens=protocol==='anthropic'?Number(input.maxTokens??8192):null;
  if(protocol==='anthropic'&&(!Number.isSafeInteger(maxTokens)||maxTokens<1))throw fail('Для Anthropic укажите положительный лимит токенов ответа.',400);
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
  if (workspaceId && !/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId)) throw fail('Некорректный Workspace ID.', 400);
  return { provider: preset.id, protocol, baseUrl: normalizeBaseUrl(preset.id === 'custom' ? input.baseUrl : preset.baseUrl), model, jsonMode: input.jsonMode !== false, maxTokens, workspaceId: protocol === 'anthropic' ? workspaceId : '' };
}
export const sameDestination = (a, b) => a.baseUrl === b.baseUrl && a.protocol === b.protocol && a.provider === b.provider && a.workspaceId === b.workspaceId;

// Validate every resolved address at connection time, not just when saving settings.
// This closes the DNS-rebinding gap; HTTP redirects are disabled separately below.
export function guardedLookup(hostname, options, callback, lookup = dnsLookup) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('API_NETWORK_BLOCKED'));
    const family = typeof options === 'number' ? options : options?.family;
    const filtered = family === 4 || family === 6 ? addresses.filter(a => a.family === family) : addresses;
    if (!filtered.length) return callback(new Error('API_ADDRESS_UNAVAILABLE'));
    if (options?.all) return callback(null, filtered);
    callback(null, filtered[0].address, filtered[0].family);
  });
}
const dispatcher = new Agent({ connect: { lookup: guardedLookup } });
export function providerRequest(connection, key, system, payload, { stream = false } = {}) {
  const c = normalizeConnection(connection), headers = { 'Content-Type': 'application/json' }, message = JSON.stringify(payload);
  let url, body;
  if (c.protocol === 'anthropic') {
    url = c.baseUrl + '/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2026-10-21';
    if (c.workspaceId) headers['anthropic-workspace-id'] = c.workspaceId;
    body = { model: c.model, system, messages: [{ role: 'user', content: message }], max_tokens: c.maxTokens, stream: false };
  } else if (c.protocol === 'gemini') {
    url = c.baseUrl + '/models/' + encodeURIComponent(c.model.replace(/^models\//, '')) + ':generateContent';
    headers['x-goog-api-key'] = key;
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: message }] }], ...(c.jsonMode ? { generationConfig: { responseMimeType: 'application/json' } } : {}) };
  } else if (c.protocol === 'responses') {
    url = c.baseUrl + '/responses'; headers.Authorization = `Bearer ${key}`;
    body = { model: c.model, instructions: system, input: message, store: false, stream: false, ...(c.jsonMode ? { text: { format: { type: 'json_object' } } } : {}) };
  } else {
    url = c.baseUrl + '/chat/completions'; headers.Authorization = `Bearer ${key}`;
    body = { model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], stream: c.provider === 'polza' && stream, ...(c.jsonMode ? { response_format: { type: 'json_object' } } : {}) };
    // Provider-specific parameters must never spill into other compatible APIs.
    if (c.provider === 'deepseek') body.thinking = { type: 'disabled' };
  }
  return { url, headers, body };
}
export function providerResult(protocol, data) {
  if (protocol === 'anthropic') return { content: data.content?.filter(p => p.type === 'text').map(p => p.text).join(''), finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason };
  if (protocol === 'gemini') {
    const c = data.candidates?.[0];
    return { content: c?.content?.parts?.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join(''), finishReason: c?.finishReason === 'STOP' ? 'stop' : c?.finishReason };
  }
  if (protocol === 'responses') return { content: data.output?.filter(p => p.type === 'message').flatMap(p => p.content || []).filter(p => p.type === 'output_text').map(p => p.text).join(''), finishReason: data.status === 'completed' ? 'stop' : data.status };
  return { content: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason };
}
async function responseJson(response) {
  let size = 0; const chunks = [];
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fail('Ответ провайдера слишком большой.', 502); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { if (e.status) throw e; throw fail('Провайдер вернул некорректный ответ. Проверьте адрес и формат API.', 502); }
}
async function streamedCompletion(response) {
  const decoder = new TextDecoder();
  // The SSE envelope also carries metadata and reasoning fragments. Count
  // model text separately so the framing does not consume the result budget.
  const maxResultBytes = 2 * 1024 * 1024, maxStreamBytes = 32 * 1024 * 1024;
  let streamBytes = 0, resultBytes = 0, buffer = '', content = '', finishReason, done = false;
  const consume = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const event = JSON.parse(data);
    if (event.error) throw fail('Polza прервал поток ответа.', 502);
    const choice = event.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string') {
      resultBytes += Buffer.byteLength(delta);
      if (resultBytes > maxResultBytes) throw fail('Текст ответа провайдера слишком большой.', 502);
      content += delta;
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
  };
  try {
    for await (const chunk of response.body) {
      streamBytes += chunk.length;
      if (streamBytes > maxStreamBytes) throw fail('Поток ответа Polza слишком большой.', 502);
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) {
        consume(frame);
        if (done) return { content, finishReason };
      }
    }
    consume(buffer + decoder.decode());
    return { content, finishReason };
  } catch (error) {
    if (error.status) throw error;
    throw fail('Поток ответа Polza не удалось прочитать до конца.', 502);
  }
}

const networkCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'API_NETWORK_BLOCKED', 'API_ADDRESS_UNAVAILABLE'
]);

function networkCode(error, signal) {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED';
  const cause = error?.cause || error;
  return [cause?.code, cause?.message, error?.code].find(code => networkCodes.has(code)) || 'NETWORK_ERROR';
}

export async function requestProvider(connection, key, system, payload, { fetcher, signal, onAttempt, stream = false } = {}) {
  const c = normalizeConnection(connection), request = providerRequest(c, key, system, payload, { stream });
  const options = { method: 'POST', redirect: 'manual', dispatcher, signal, headers: request.headers, body: JSON.stringify(request.body) };
  const send = async () => {
    signal?.throwIfAborted();
    const start = performance.now();
    let response;
    try { response = await (fetcher || networkFetch)(request.url, options); }
    catch (error) {
      onAttempt?.({ code: networkCode(error, signal), elapsedMs: Math.round(performance.now() - start) });
      signal?.throwIfAborted();
      return null;
    }
    onAttempt?.({ httpStatus: response.status, elapsedMs: Math.round(performance.now() - start) });
    return response;
  };
  let response = await send();
  if (c.provider === 'polza' && (!response || [408, 429, 500, 502, 503, 504].includes(response.status))) {
    const retryAfter = response?.headers?.get('retry-after');
    const wait = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : 1000;
    if (!(wait > 10000)) {
      await response?.body?.cancel();
      await delay(Math.max(1000, Number.isFinite(wait) ? wait : 1000), undefined, { signal });
      response = await send();
    }
  }
  if (!response) throw fail('Не удалось подключиться к API. Проверьте публичный адрес сервиса и доступность провайдера.', 502);
  if (!response.ok) {
    const errors = { 400: 'Провайдер отклонил параметры. Проверьте ID модели, формат API, JSON-режим и лимит ответа.', 401: 'Провайдер отклонил ключ. Проверьте настройки.', 402: 'Недостаточно средств на счёте провайдера.', 403: 'Нет доступа к модели или API. Проверьте разрешения ключа и Workspace ID.', 404: 'Модель или путь API не найдены. Проверьте ID модели и базовый адрес.', 429: 'Лимит запросов провайдера. Повторите запуск позже.' };
    // Do not follow redirects or expose error bodies: they may echo a credential.
    await response.body?.cancel();
    throw fail(response.status >= 300 && response.status < 400 ? 'API вернул перенаправление. Укажите конечный адрес сервиса.' : errors[response.status] || 'API временно недоступен. Предыдущие результаты сохранены.', 502);
  }
  if (request.body.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
    try{return { ...await streamedCompletion(response), connection: c };}catch(error){signal?.throwIfAborted();throw error;}
  }
  const data = await responseJson(response);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Провайдер вернул некорректную структуру ответа.', 502);
  return { ...providerResult(c.protocol, data), connection: c };
}
