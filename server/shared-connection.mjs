import * as blob from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { sealKey, openKey } from './cloud-security.mjs';
import { emptyConnection, normalizeConnection } from './providers.mjs';
import { fail } from './files.mjs';

const path = 'system/shared-connection-v1.json';
const aad = 'kruzhivo-shared-connection-v1';
const readOptions = { access:'private', useCache:false };
// No TTL: the shared connection lasts until its owner disconnects it.
const writeOptions = { access:'private', addRandomSuffix:false, contentType:'application/json', cacheControlMaxAge:0 };
const conflict = e => ['BlobPreconditionFailedError','BlobAlreadyExistsError'].includes(e.name);

export function createSharedConnection(master, storage=blob) {
  async function load({conditional=false}={}) {
    const result=await storage.get(path,readOptions);
    if (!result || result.statusCode===404) return { state:{usage:[]}, etag:null };
    if (result.statusCode!==200) throw fail('Общее подключение временно недоступно.',503);
    if(!conditional)return {state:await new Response(result.stream).json()};
    // Re-read after head so CAS never uses an ETag newer than its read snapshot.
    await result.stream.cancel();
    const metadata=await storage.head(path),fresh=await storage.get(path,readOptions);
    if (!fresh || fresh.statusCode!==200) throw fail('Общее подключение временно недоступно.',503);
    return { state:JSON.parse(await new Response(fresh.stream).text()), etag:metadata.etag };
  }
  function credential(state) {
    if (!state.ciphertext) return { key:'', connection:emptyConnection(), revision:null };
    const value=JSON.parse(openKey(state.ciphertext,aad,master));
    return { key:value.key, connection:normalizeConnection(value.connection,{allowEmptyModel:!value.key}), revision:value.revision };
  }
  async function mutate(fn) {
    for(let i=0;i<5;i++) {
      const {state,etag}=await load({conditional:true}),result=fn(state);
      try { await storage.put(path,JSON.stringify(state),{...writeOptions,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{})}); return result; }
      catch(e) { if(!conflict(e))throw e; }
    }
    throw fail('Общее подключение изменяется. Повторите действие.',409);
  }
  return {
    async read() { return credential((await load()).state); },
    async set(key,connection) {
      const normalized=normalizeConnection(connection,{allowEmptyModel:!key});
      return mutate(state=>{
        state.ciphertext=sealKey(JSON.stringify({key,connection:normalized,revision:randomUUID()}),aad,master);
      });
    },
    async valid(revision) { const c=await this.read();return !!c.key && c.revision===revision; },
    async reserve(revision) {
      return mutate(state=>{
        const c=credential(state),time=Date.now();
        if(!c.key||c.revision!==revision)throw fail('Общее подключение изменено. Обновите страницу.',409);
        state.usage=(state.usage||[]).filter(x=>time-x.at<3600000);
        if(state.usage.some(x=>!x.finished&&time-x.at<300000))throw fail('Общий API сейчас выполняет проверку. Дождитесь её завершения.',429);
        if(state.usage.length>=8)throw fail('Лимит общей демки — 8 запусков API в час. Повторите позже.',429);
        const token=randomUUID();state.usage.push({token,at:time,finished:false});return token;
      });
    },
    async release(token) { if(token)await mutate(state=>{const lease=state.usage?.find(x=>x.token===token);if(lease)lease.finished=true;}); },
  };
}
