import {createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv} from 'node:crypto';
import {deflateRawSync, inflateRawSync} from 'node:zlib';

const INDEX='index.enc', MAX_BYTES=32*1024*1024;
const DATA_CONFIG={path:'vercel.json',mode:'100644',type:'blob',content:JSON.stringify({git:{deploymentEnabled:false}})+'\n'};
const unavailable=()=>Object.assign(new Error('Хранилище временно недоступно. Повторите действие позже.'),{status:503});
const conflict=name=>Object.assign(new Error(name),{name});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Runtime objects live in an isolated private branch. Neither their contents nor
// the object index are readable without the server's existing encryption secret.
export function createGithubStorage({token,master,repository='mrasos675-oss/kruzhivo',branch='runtime-data',request=fetch,cacheMs=2000,writeIntervalMs=1000,now=Date.now,sleep=delay}={}){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||!/^runtime-[a-z0-9-]+$/.test(branch))throw unavailable();
 const base='https://api.github.com/repos/'+repository;
 const key=createHash('sha256').update('kruzhivo-github-storage-v1\0'+String(master||'')+'\0'+repository+'\0'+branch).digest();
 let verified,cache,checkedAt=0,indexEtag,cacheHead,cacheTree,reading,generation=0,queue=Promise.resolve(),lastWrite=0;
 const bodies=new Map();let bodyBytes=0;
 const objectId=path=>createHmac('sha256',key).update(path).digest('hex');
 const validPath=path=>{if(typeof path!=='string'||!path||path.length>512||path.includes('..')||/[\x00-\x1f]/.test(path))throw unavailable();return path;};
 function seal(bytes,aad){
  bytes=Buffer.from(bytes);if(bytes.length>MAX_BYTES)throw Object.assign(new Error('Слишком большой объект для хранилища.'),{status:413});
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
  const encrypted=Buffer.concat([cipher.update(deflateRawSync(bytes)),cipher.final()]);
  return Buffer.concat([Buffer.from('KGH1'),iv,cipher.getAuthTag(),encrypted]);
 }
 function open(bytes,aad){try{
  bytes=Buffer.from(bytes);if(bytes.subarray(0,4).toString()!=='KGH1')throw Error();
  const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(4,16));d.setAAD(Buffer.from(aad));d.setAuthTag(bytes.subarray(16,32));
  return inflateRawSync(Buffer.concat([d.update(bytes.subarray(32)),d.final()]),{maxOutputLength:MAX_BYTES});
 }catch{throw unavailable();}}
 async function call(path,{method='GET',data,headers={},allowed=[]}={}){
  if(!token||typeof master!=='string'||master.length<43)throw unavailable();
  const operation=path.startsWith('/git/')?path.split('/')[2]:path.startsWith('/contents/')?'index':'repository';
  let response;try{response=await request(base+path,{method,redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});}catch{const e=unavailable();e.githubOperation=operation;throw e;}
  if(response.status===304||allowed.includes(response.status))return {status:response.status,response};
  if(!response.ok){const e=unavailable();e.githubStatus=response.status;e.githubOperation=operation;throw e;}
  let json;try{json=await response.json();}catch{const e=unavailable();e.githubOperation=operation;e.githubStatus=response.status;throw e;}return {status:response.status,response,json};
 }
 async function verify(){
  verified??=call('').then(({json})=>{if(json.private!==true||json.full_name?.toLowerCase()!==repository.toLowerCase())throw unavailable();}).catch(e=>{verified=undefined;throw e;});
  return verified;
 }
 function decodeIndex(file){
  try{const x=JSON.parse(open(Buffer.from(file.content,'base64'),'index').toString());
   if(x.format!==1||!x.entries||Array.isArray(x.entries))throw Error();
   for(const [id,e]of Object.entries(x.entries))if(!/^[a-f0-9]{64}$/.test(id)||objectId(validPath(e.path))!==id||!/^[a-f0-9]{40}$/.test(e.sha)||typeof e.etag!=='string'||!Number.isSafeInteger(e.size)||e.size<0||e.size>MAX_BYTES||(e.expiresAt!==null&&!Number.isSafeInteger(e.expiresAt)))throw Error();
   return x;
  }catch{throw unavailable();}
 }
 async function readIndex(force=false){
  await verify();if(!force&&cache&&now()-checkedAt<cacheMs)return cache;
  if(!force&&reading)return reading;
  const version=generation;
  const job=(async()=>{
   const r=await call('/git/ref/heads/'+branch,{headers:indexEtag?{'If-None-Match':indexEtag}:{},allowed:[404]});
   let next,head,tree;
   if(r.status===304){if(!cache)throw unavailable();next=cache;head=cacheHead;tree=cacheTree;}
   else if(r.status===404){next={format:1,entries:{}};}
   else{
    head=r.json.object.sha;
    const snapshot=cache&&cacheHead===head?{index:cache,tree:cacheTree}:await snapshotAt(head);
    next=snapshot.index;tree=snapshot.tree;
   }
   if(version===generation){cache=next;cacheHead=head;cacheTree=tree;checkedAt=now();indexEtag=r.response.headers.get('etag')||undefined;}
   return cache||next;
  })();
  if(!force)reading=job;try{return await job;}finally{if(reading===job)reading=undefined;}
 }
 const live=e=>e&&(e.expiresAt===null||e.expiresAt>now());
 function remember(sha,bytes){if(bodies.has(sha))return;while(bodyBytes+bytes.length>64*1024*1024&&bodies.size){const [k,b]=bodies.entries().next().value;bodies.delete(k);bodyBytes-=b.length;}bodies.set(sha,bytes);bodyBytes+=bytes.length;}
 async function readObject(e){
  let bytes=bodies.get(e.sha);if(!bytes){const {json}=await call('/git/blobs/'+e.sha);bytes=open(Buffer.from(json.content,'base64'),e.path);if(bytes.length!==e.size)throw unavailable();remember(e.sha,bytes);}return bytes;
 }
 async function snapshotAt(head){
  const {json:commit}=await call('/git/commits/'+head),{json:tree}=await call('/git/trees/'+commit.tree.sha);
  const entry=tree.tree.find(e=>e.path===INDEX&&e.type==='blob');if(!entry)throw unavailable();
  const {json:file}=await call('/git/blobs/'+entry.sha);
  return {head,tree:commit.tree.sha,index:decodeIndex(file)};
 }
 async function snapshot(){
  const ref=await call('/git/ref/heads/'+branch,{allowed:[404]});if(ref.status===404)return null;
  const head=ref.json.object.sha;
  return cache&&head===cacheHead&&cacheTree?{head,index:cache,tree:cacheTree}:snapshotAt(head);
 }
 async function initialize(){
  const encrypted=seal(Buffer.from(JSON.stringify({format:1,entries:{}})),'index');
  const {json:b}=await call('/git/blobs',{method:'POST',data:{content:encrypted.toString('base64'),encoding:'base64'}});
  const {json:t}=await call('/git/trees',{method:'POST',data:{tree:[DATA_CONFIG,{path:INDEX,mode:'100644',type:'blob',sha:b.sha},{path:'README.md',mode:'100644',type:'blob',content:'Private encrypted runtime data for КружИИво. The encryption key is held only by the server.\n'}]}});
  const {json:c}=await call('/git/commits',{method:'POST',data:{message:'Initialize encrypted application storage',tree:t.sha,parents:[]}});
  await call('/git/refs',{method:'POST',data:{ref:'refs/heads/'+branch,sha:c.sha},allowed:[422]});
 }
 function enqueue(fn){const op=queue.then(fn);queue=op.catch(()=>{});return op;}
 async function mutate(changes){return enqueue(async()=>{
  await verify();
  for(let attempt=0;attempt<5;attempt++){
   let s=await snapshot();if(!s){await initialize();s=await snapshot();if(!s)throw unavailable();}
   const index=structuredClone(s.index),tree=[],saved=[];let changed=false;
   for(const change of changes){const path=validPath(change.path),id=objectId(path),entry=index.entries[id],current=live(entry)?entry:null;
    if(change.remove){if(!entry)continue;delete index.entries[id];tree.push({path:'objects/'+id+'.bin',mode:'100644',type:'blob',sha:null});changed=true;continue;}
    const options=change.options||{};
    if(options.ifMatch&&current?.etag!==options.ifMatch)throw conflict('BlobPreconditionFailedError');
    if(!options.ifMatch&&options.allowOverwrite!==true&&current)throw conflict('BlobAlreadyExistsError');
    const bytes=Buffer.from(change.bytes),encrypted=seal(bytes,path);
    const {json:blob}=await call('/git/blobs',{method:'POST',data:{content:encrypted.toString('base64'),encoding:'base64'}});
    const e={path,sha:blob.sha,etag:randomUUID(),size:bytes.length,expiresAt:options.ttlDays?now()+options.ttlDays*86400000:null};
    index.entries[id]=e;tree.push({path:'objects/'+id+'.bin',mode:'100644',type:'blob',sha:blob.sha});saved.push({entry:e,bytes});changed=true;
   }
   if(!changed)return [];
   const encrypted=seal(Buffer.from(JSON.stringify(index)),'index');
   const {json:blob}=await call('/git/blobs',{method:'POST',data:{content:encrypted.toString('base64'),encoding:'base64'}});
   tree.push(DATA_CONFIG,{path:INDEX,mode:'100644',type:'blob',sha:blob.sha});
   const {json:t}=await call('/git/trees',{method:'POST',data:{base_tree:s.tree,tree}});
   const {json:c}=await call('/git/commits',{method:'POST',data:{message:'Save encrypted application data',tree:t.sha,parents:[s.head]}});
   const wait=writeIntervalMs-(now()-lastWrite);if(wait>0)await sleep(wait);
   const r=await call('/git/refs/heads/'+branch,{method:'PATCH',data:{sha:c.sha,force:false},allowed:[409,422]});lastWrite=now();
   if(r.status===409||r.status===422){await sleep(100*(attempt+1));continue;}
   generation++;cache=index;cacheHead=c.sha;cacheTree=t.sha;checkedAt=now();indexEtag=undefined;for(const x of saved)remember(x.entry.sha,x.bytes);
   return saved.map(x=>({etag:x.entry.etag}));
  }
  throw conflict('BlobPreconditionFailedError');
 });}
 return {
  kind:'github',repository,branch,
  async get(path,{fresh=false}={}){const e=(await readIndex(fresh)).entries[objectId(validPath(path))];if(!live(e))return null;const bytes=await readObject(e);return {statusCode:200,stream:new Response(bytes).body,blob:{etag:e.etag}};},
  async head(path){const e=(await readIndex(true)).entries[objectId(validPath(path))];if(!live(e))throw conflict('BlobNotFoundError');return {etag:e.etag};},
  async put(path,bytes,options={}){return (await mutate([{path,bytes,options}]))[0];},
  async putMany(changes){return mutate(changes);},
  async list(prefix){return Object.values((await readIndex()).entries).filter(e=>live(e)&&e.path.startsWith(prefix)).map(e=>e.path).sort();},
  async del(path){await mutate([{path,remove:true}]);},
 };
}
