import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAuth } from '../server/account-auth.mjs';
import { createRedisAuthStore } from '../server/auth-redis.mjs';

const account = { id:'official', username:'official', role:'official', displayName:'Тест', salt:'a'.repeat(32), passwordHash:'b'.repeat(64) };
const master = 'test-only-secret';
const cookie = result => result.cookie.split(';')[0];

test('Redis demo sessions use one write, enforce the attempt limit, rotate and never fall back to GitHub after revocation', async () => {
 const sessions = new Map(), legacy = new Map(), calls = [];
 const git = {
  async get(path) {
   calls.push('git-read');
   const bytes = legacy.get(path);
   return bytes === undefined ? null : { statusCode:200, stream:new Response(bytes).body };
  },
  async put(path, bytes) { calls.push('git-write'); legacy.set(path, bytes); },
  async del(path) { calls.push('git-delete'); legacy.delete(path); },
 };
 const old = await createAccountAuth(master,[account],git,{demoEnabled:true}).loginDemo('official','old-ip');
 const redis = createRedisAuthStore({url:'https://example.upstash.io',token:'test-token',request:async (url,options) => {
  assert.equal(url.origin,'https://example.upstash.io');
  assert.equal(options.redirect,'error');
  const [command, ...args] = JSON.parse(options.body);
  calls.push(command);
  let result;
  if(command==='GET')result=sessions.get(args[0]) ?? null;
  else if(command==='DEL')result=Number(sessions.delete(args[0]));
  else {
   assert.equal(command,'EVAL');
   const [, count, attemptKey, newSession] = args;
   assert.ok(count===2||count===3);
   const attempts = sessions.get(attemptKey)||0;
   result = attempts < 10 ? 1 : 0;
   if(result===1){
    sessions.set(attemptKey, attempts+1);
    const [bytes, ttl] = args.slice(2+count);
    assert.equal(ttl,7*86400);
    sessions.set(newSession,bytes);
    if(count===3)sessions.delete(args[4]);
   }
  }
  return Response.json({result});
 }});
 const auth = createAccountAuth(master,[account],git,{redis,demoEnabled:true});
 assert.equal((await auth.current(cookie(old))).id,account.id);
 calls.length=0;
 const first=await auth.loginDemo('official','new-ip',cookie(old));
 assert.deepEqual(calls,['EVAL','git-delete']);
 assert.equal(await auth.current(cookie(old)),null);
 calls.length=0;
 const second=await auth.loginDemo('official','new-ip',cookie(first));
 assert.deepEqual(calls,['EVAL']);
 calls.length=0;
 assert.equal(await auth.current(cookie(first)),null);
 assert.equal((await auth.current(cookie(second))).id,account.id);
 assert.deepEqual(calls,['GET','GET']);
 for(let i=0;i<8;i++)await auth.loginDemo('official','new-ip');
 await assert.rejects(auth.loginDemo('official','new-ip',cookie(second)),error=>error.status===429);
 assert.equal((await auth.current(cookie(second))).id,account.id);
 await auth.logout(cookie(second));
 calls.length=0;
 assert.equal(await auth.current(cookie(second)),null);
 assert.deepEqual(calls,['GET']);
});

test('Redis configuration rejects untrusted origins and upstream failures hide provider details', async () => {
 assert.throws(()=>createRedisAuthStore({url:'https://example.net',token:'test-token'}),e=>e.status===503);
 const redis=createRedisAuthStore({url:'https://example.upstash.io',token:'test-token',request:async()=>Response.json({error:'private-provider-message'})});
 await assert.rejects(redis.read('auth/session'),e=>e.status===503&&!e.message.includes('private-provider-message'));
});
