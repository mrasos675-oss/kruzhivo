import { createRedisAuthStore } from '../server/auth-redis.mjs';
import { createRunDispatcher } from '../server/run-dispatch.mjs';
import { createGithubHistory } from '../server/github-history.mjs';
import { createGithubStorage } from '../server/github-store.mjs';
import { recoverGithubHistory } from '../server/github-recovery.mjs';
import { demoProfileFor } from '../server/profile.mjs';
import { waitUntil } from '@vercel/functions';
import { createAccountAuth, roleAllowed, parseAccounts } from '../server/account-auth.mjs';
import { createExpertReview } from '../server/expert-review.mjs';
import { methodology } from '../server/transparency.mjs';
import { createApp } from '../server/index.mjs';
import { createCloudStore } from '../server/cloud-store.mjs';
import { createSharedConnection } from '../server/shared-connection.mjs';
import { sessionFromCookie, newSession, checkOrigin, isAdmin, validAdminToken, adminCookie } from '../server/cloud-security.mjs';

export function createHostedHandler({getDispatcher=createRunDispatcher,getMaster=()=>process.env.KRUZHIVO_SESSION_SECRET,getAdminToken=()=>process.env.KRUZHIVO_ADMIN_TOKEN,storage,fetcher,pilotMode=false,getAccounts=()=>process.env.KRUZHIVO_ACCOUNTS,getAdminAccount=()=>process.env.KRUZHIVO_ADMIN_ACCOUNT,getDemoLogin=()=>process.env.KRUZHIVO_DEMO_LOGIN==='1',authRequired=true,getRedisAuth=()=>null,schedule=promise=>waitUntil(promise.catch(()=>console.error('kruzhivo: background job failed')))}={}) {
return async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const origin = checkOrigin(req), master = getMaster();
    if (!master || master.length < 43) throw new Error('Missing server configuration');
    const path=req.url.split('?')[0],demoLogin=getDemoLogin()===true;
    const accounts=[...parseAccounts(getAccounts()),...parseAccounts(getAdminAccount())];
    const auth=authRequired?createAccountAuth(master,accounts,storage,{
      redis:getRedisAuth(),demoEnabled:demoLogin,
      ...(pilotMode?{demoAccount:(rows,role)=>rows.find(a=>a.role===role&&(role==='admin'||demoProfileFor(a)))}:{})
    }):null;
    const authJson=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(data));};
    if(path==='/api/auth/register')return authJson(403,{error:'Регистрация недоступна.'});
    if(auth&&['/api/auth/login','/api/auth/demo-login'].includes(path)&&req.method==='POST'){
      let body=req.body;if(body===undefined){let bytes='';for await(const chunk of req){bytes+=chunk.toString();if(Buffer.byteLength(bytes)>4096)throw Object.assign(new Error('Слишком большой запрос.'),{status:413});}body=bytes;}
      try{if(typeof body==='string'||Buffer.isBuffer(body))body=JSON.parse(body.toString());if(!body||Array.isArray(body)||typeof body!=='object'||Buffer.byteLength(JSON.stringify(body))>4096)throw Error('Bad body');}catch{throw Object.assign(new Error('Некорректный запрос.'),{status:400});}
      const ip=String(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown');
      const signed=path==='/api/auth/demo-login'?await auth.loginDemo(body.role,ip,req.headers.cookie):await auth.login(body.username,body.password,ip,req.headers.cookie);
      res.setHeader('Set-Cookie',[signed.cookie,'__Host-kruzhivo-admin=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict']);return authJson(200,{user:signed.user,demoLogin,pilotMode});
    }
    if(auth&&path==='/api/auth/logout'&&req.method==='POST'){res.setHeader('Set-Cookie',[await auth.logout(req.headers.cookie),'__Host-kruzhivo-admin=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict']);return authJson(200,{ok:true});}
    const account=auth?await auth.current(req.headers.cookie):null;
    const sharedCabinet=pilotMode&&!!demoProfileFor(account);
    const queueExpert=pilotMode?accounts.find(a=>a.role==='expert'&&demoProfileFor(a)):null;
    if(auth&&path==='/api/auth/session'&&req.method==='GET')return authJson(200,{user:account,demoLogin,pilotMode});
    if(auth&&!account)return authJson(401,{error:'Войдите по логину и паролю.'});
    if(auth&&!roleAllowed(account,req.method,path))return authJson(403,{error:'Действие недоступно для вашей роли.'});
    if(auth&&account.role==='admin'&&path==='/api/storage/recover'&&req.method==='POST'){
      const owner=accounts.find(a=>a.role==='official'&&demoProfileFor(a));
      if(!owner)return authJson(409,{error:'Не найден общий кабинет для восстановления архива.'});
      return authJson(200,await recoverGithubHistory({storage,master,token:process.env.KRUZHIVO_GITHUB_TOKEN,account:owner}));
    }
    const reviewStore=createCloudStore('expert-review-v1',master,storage,{reuseReads:true,initialDb:()=>({schemaVersion:1,documents:[],sources:[],examples:[],expertCases:[]})});
    if(auth&&req.method==='GET'){
      if(path==='/api/methodology')return authJson(200,methodology());
      if(path==='/api/expert-cases'||path==='/api/expert-cases/history'){
        const reviews=createExpertReview(reviewStore,'account:'+account.id,{trainingReader:sharedCabinet});
        return authJson(200,{cases:path.endsWith('/history')?await reviews.history():await reviews.list()});
      }
    }
    let session = sessionFromCookie(req.headers.cookie, master);
    const fresh = !session;
    if (!auth && fresh && !(req.method === 'GET' && req.url.split('?')[0] === '/api/bootstrap')) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Сессия истекла. Обновите страницу.' }));
    }
    if (fresh) session = newSession(master);
    const workspace=account?'account-'+account.id+(sharedCabinet?'-operations-v1':''):session.id;
    const store = createCloudStore(workspace, master, storage,(pilotMode||['expert','admin'].includes(account?.role))?{reuseReads:true,initialDb:()=>({schemaVersion:1,documents:[],sources:[],examples:[]})}:{reuseReads:true});
    const adminToken=getAdminToken();
    const shared=adminToken?createSharedConnection(master,storage):null;
    const workspaceReady=(async()=>{
      let db;
      if(auth){
        db=await store.ensure();
        const defaultProfile=demoProfileFor(account);
        if(defaultProfile&&!db.profile)db=await store.change(current=>{current.profile ||= defaultProfile;return current;});
      }else if(fresh){
        db=await store.initialize();
        res.setHeader('Set-Cookie',session.cookie);
      }
      return db;
    })();
    const [workspaceState,personal,sharedCredential]=await Promise.all([
      workspaceReady.then(db=>store.recover(db)),
      workspaceReady.then(()=>store.credential()),
      shared?.read()||null
    ]);
    const credential=shared?{...sharedCredential,model:sharedCredential.connection.model}:personal;
    const canManage=!!shared&&(account?account.role==='admin':isAdmin(req.headers.cookie,adminToken,master));
    const usesShared=!!sharedCredential?.key;
    const access=shared?{
      shared:true,canManage,usingShared:usesShared,personalConfigured:!!personal.key,personalConnection:canManage?personal.connection:null,
      login:async token=>{if(!validAdminToken(token,adminToken))throw Object.assign(new Error('Неверная ссылка управления.'),{status:403});res.setHeader('Set-Cookie',adminCookie(adminToken,master));},
      clearPersonal:()=>store.setCredential('',personal.model,personal.connection),
    }:null;
    const sourceLibrary={
      read:async()=>(await reviewStore.ensure()).sources,
      change:async fn=>{await reviewStore.ensure();return reviewStore.change(db=>fn(db.sources));},
    };
    const profile=workspaceState.profile;
    const effectiveAccount=account&&profile?.fullName?{...account,displayName:profile.fullName}:account;
    const app = await createApp({
      store, originals: store.originals, hosted: true, pilotMode, trainingReader:sharedCabinet, queueExpert, origin,
      bootstrapState:workspaceState, storageInfo:storage?.kind==='github'?{provider:'github',recoveryAvailable:account?.role==='admin'}:null, initialKey: credential.key, initialModel: credential.model, initialConnection: credential.connection,
      access, fetcher, actorId:account?'account:'+account.id:session.id, account:effectiveAccount, experts:auth&&!pilotMode?(await auth.listAccounts()).filter(a=>a.role==='expert').map(a=>({...a,displayName:demoProfileFor(a)?.fullName||a.displayName})):[], reviewStore, sourceLibrary,
      credentials: { expiresAt: credential.expiresAt, set: async (key, model, connection) => {
        if(shared) {if(!canManage)throw Object.assign(new Error('Изменять общий ключ может только владелец подключения.'),{status:403});await shared.set(key,connection);if(!key)await store.setCredential('',personal.model,personal.connection);return;}
        return store.setCredential(key,model,connection);
      }, valid: () => usesShared?shared.valid(credential.revision):store.validCredential(credential.revision),
        ...(usesShared?{reserve:()=>shared.reserve(credential.revision),touch:token=>shared.touch(token,credential.revision),release:token=>shared.release(token)}:{}) },
      dispatchStep:getDispatcher(req), schedule, history: pilotMode ? createGithubHistory(process.env.KRUZHIVO_GITHUB_TOKEN, storage) : null,
    });
    await app.handler(req, res);
  } catch (e) {
    // Never log request bodies, cookies, provider responses, document text or credentials.
    if (!e.status||e.status>=500) console.error('kruzhivo: request failed', { type:e.name,...(e.githubOperation?{operation:e.githubOperation,status:e.githubStatus||0}:{}) });
    if (!res.headersSent) res.writeHead(e.status || 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.status ? e.message : 'Сервис временно недоступен. Повторите действие позже.' }));
  }
}

}
const runtimeStorage=createGithubStorage({token:process.env.KRUZHIVO_GITHUB_TOKEN,master:process.env.KRUZHIVO_SESSION_SECRET});
export default createHostedHandler({pilotMode:true,storage:runtimeStorage,getRedisAuth:()=>createRedisAuthStore()});
