import { fail } from './files.mjs';

// One atomic command for the rolling limit and, on demo sign-in, session rotation.
const recordAttempt = `
local attempts = redis.call('GET', KEYS[1])
local times = attempts and cjson.decode(attempts) or {}
local now = tonumber(redis.call('TIME')[1])
local recent = {}
for _, time in ipairs(times) do
  if now - time < 900 then table.insert(recent, time) end
end
if #recent >= 10 then return 0 end
table.insert(recent, now)
redis.call('SET', KEYS[1], cjson.encode(recent), 'EX', 900)
if #KEYS >= 2 then
  redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]))
end
if #KEYS == 3 then redis.call('DEL', KEYS[3]) end
return 1
`;

const rotateSession = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
if #KEYS == 2 then redis.call('DEL', KEYS[2]) end
return 1
`;

export function createRedisAuthStore({
 url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
 token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
 request = fetch,
} = {}) {
 if (!url && !token) return null;

 let endpoint;
 try {
  endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.upstash.io') ||
      endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' ||
      endpoint.search || endpoint.hash || !token) throw new Error();
 } catch {
  throw fail('Хранилище сессий не настроено.', 503);
 }

 const key = path => 'kruzhivo:auth:v1:' + path;
 async function command(args) {
  try {
   const response = await request(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
   });
   if (!response.ok) throw new Error();
   const body = await response.json();
   if (body.error || !Object.hasOwn(body, 'result')) throw new Error();
   return body.result;
  } catch {
   throw fail('Сервис входа временно недоступен. Повторите позже.', 503);
  }
 }

 function sessionKeys(session) {
  return [key(session.path), ...(session.previousPath ? [key(session.previousPath)] : [])];
 }

 return {
  async read(path) {
   const value = await command(['GET', key(path)]);
   if (value === null) return null;
   try { return JSON.parse(value); }
   catch { throw fail('Сервис входа временно недоступен. Повторите позже.', 503); }
  },
  async recordAttempt(path, session) {
   const keys = [key(path), ...(session ? sessionKeys(session) : [])];
   const args = session ? [session.bytes, session.ttl] : [];
   const accepted = await command(['EVAL', recordAttempt, keys.length, ...keys, ...args]);
   if (accepted !== 1) throw fail('Слишком много попыток входа. Повторите через 15 минут.', 429);
  },
  async issue(session) {
   const keys = sessionKeys(session);
   if (keys.length === 1) {
    await command(['SET', keys[0], session.bytes, 'EX', session.ttl]);
   } else {
    await command(['EVAL', rotateSession, keys.length, ...keys, session.bytes, session.ttl]);
   }
  },
  async revoke(path) {
   await command(['DEL', key(path)]);
  },
 };
}
