import {createHash} from 'node:crypto';
import {demoProfileFor} from './profile.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const unavailable=()=>Object.assign(new Error('Не удалось прочитать архив. Рабочие документы не изменены.'),{status:503});

// Recovery uses the existing archive, never guesses missing decisions or cases.
export async function recoverGithubHistory({storage,master,token,account,request=fetch}){
 if(storage.kind!=='github'||!account||account.role!=='official')throw unavailable();
 const repository=storage.repository,base='https://api.github.com/repos/'+repository;
 async function read(path){let r;try{r=await request(base+path,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw unavailable();}if(!r.ok)throw unavailable();return r.json();}
 const tree=await read('/git/trees/review-history?recursive=1');if(tree.truncated)throw unavailable();
 const paths=tree.tree.filter(e=>e.type==='blob'&&/^reviews\/[a-f0-9-]{36}\/(01-submission|02-result)\.json$/.test(e.path));
 if(paths.length>400)throw unavailable();
 const events=[];
 for(const item of paths){const blob=await read('/git/blobs/'+item.sha);let event;try{event=JSON.parse(Buffer.from(blob.content,'base64').toString());}catch{throw unavailable();}events.push(event);}
 const documents=new Map(),originals=new Map();
 for(const e of events.filter(e=>e.type==='submitted')){
  const d=e.data?.document,v=d?.version;
  if(!d?.id||!v?.id||typeof v.text!=='string'||hash(v.text)!==v.hash)throw unavailable();
  if(!documents.has(d.id))documents.set(d.id,{id:d.id,name:d.name,kind:d.kind||null,sample:false,createdAt:v.createdAt,versions:[],runs:[]});
  const doc=documents.get(d.id);if(!doc.versions.some(x=>x.id===v.id))doc.versions.push(structuredClone(v));
  if(e.data.originalDocxBase64&&v.original){const bytes=Buffer.from(e.data.originalDocxBase64,'base64');if(hash(bytes)!==v.original.sha256||bytes.length!==v.original.size)throw unavailable();originals.set(v.original.fileId,bytes);}
 }
 for(const e of events.filter(e=>e.type==='result')){
  const d=documents.get(e.data?.documentId),r=e.data?.run;
  if(!d||!r||r.id!==e.runId||!d.versions.some(v=>v.id===r.versionId))throw unavailable();
  if(!d.runs.some(x=>x.id===r.id))d.runs.push(structuredClone(r));
 }
 const shared=!!demoProfileFor(account),workspace='account-'+account.id+(shared?'-operations-v1':''),path='workspaces/'+workspace+'/state.json';
 let metadata;try{metadata=await storage.head(path);}catch(e){if(e.name!=='BlobNotFoundError')throw e;}
 const existing=metadata?await storage.get(path):null,state=existing?await new Response(existing.stream).json():{db:{schemaVersion:1,documents:[],sources:[],examples:[]},credential:null};
 if(state.db?.schemaVersion!==1||!Array.isArray(state.db.documents))throw unavailable();
 let restored=0;
 for(const d of documents.values()){
  d.versions.sort((a,b)=>a.number-b.number);d.runs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  // An existing document can contain newer human decisions: never overwrite it.
  if(state.db.documents.some(x=>x.id===d.id))continue;state.db.documents.push(d);restored++;
 }
 state.db.archiveRecovery={source:'review-history',at:new Date().toISOString(),documents:documents.size,runs:[...documents.values()].reduce((n,d)=>n+d.runs.length,0),partial:true,notice:'Восстановлены документы и снимки проверок из GitHub. Профили, поздние решения, экспертные дела и API-подключение из недоступной Neon не восстановлены.'};
 state.db.profile ||= demoProfileFor(account);
 const changes=[];
 for(const [id,bytes]of originals){const p='workspaces/'+workspace+'/originals/'+id+'.docx';if(!await storage.get(p))changes.push({path:p,bytes,options:{allowOverwrite:false}});}
 changes.push({path,bytes:Buffer.from(JSON.stringify(state)),options:metadata?{ifMatch:metadata.etag}:{allowOverwrite:false}});
 await storage.putMany(changes);
 return {documents:documents.size,runs:state.db.archiveRecovery.runs,restored,partial:true,notice:state.db.archiveRecovery.notice};
}
