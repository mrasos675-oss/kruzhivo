import {createHash} from 'node:crypto';
export function fakeGithub(){
 const blobs=new Map(),trees=new Map(),commits=new Map(),refs=new Map(),calls=[];let counter=0;
 const sha=()=>createHash('sha1').update(String(++counter)).digest('hex');
 const blob=bytes=>{bytes=Buffer.from(bytes);const id=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');blobs.set(id,bytes);return id;};
 const response=(status,data,headers)=>new Response(data===undefined?null:JSON.stringify(data),{status,headers});
 const api={blobs,trees,commits,refs,calls,private:true,failStatus:null,blob,archive:[],
  async request(url,options={}){
   const u=new URL(url),path=u.pathname.replace('/repos/mrasos675-oss/kruzhivo',''),method=options.method||'GET',data=options.body?JSON.parse(options.body):null;calls.push({path,method,data});
   if(api.failStatus)return response(api.failStatus,{message:'sensitive diagnostic must never escape'});
   if(!path)return response(200,{private:api.private,full_name:'mrasos675-oss/kruzhivo'});
   if(path==='/git/trees/review-history')return response(200,{truncated:false,tree:api.archive.map(e=>({path:e.path,sha:e.sha,type:'blob'}))});
   if(path.startsWith('/git/ref/heads/')){const s=refs.get(path.slice(15));return s?response(200,{object:{sha:s}}):response(404,{});}
   if(method==='POST'&&path==='/git/refs'){const name=data.ref.replace('refs/heads/','');if(refs.has(name))return response(422,{});refs.set(name,data.sha);return response(201,{object:{sha:data.sha}});}
   if(method==='PATCH'&&path.startsWith('/git/refs/heads/')){const name=path.slice(16),current=refs.get(name),commit=commits.get(data.sha);if(data.force||commit?.parents[0]===current){refs.set(name,data.sha);return response(200,{});}return response(409,{});}
   if(method==='POST'&&path==='/git/blobs')return response(201,{sha:blob(data.encoding==='base64'?Buffer.from(data.content,'base64'):Buffer.from(data.content))});
   if(method==='GET'&&path.startsWith('/git/blobs/')){const id=path.slice(11),b=blobs.get(id);return b?response(200,{sha:id,content:b.toString('base64'),encoding:'base64'}):response(404,{});}
   if(method==='POST'&&path==='/git/trees'){const entries=new Map(trees.get(data.base_tree)||[]);for(const e of data.tree){if(e.sha===null)entries.delete(e.path);else entries.set(e.path,e.sha||blob(e.content));}const id=sha();trees.set(id,entries);return response(201,{sha:id});}
   if(method==='POST'&&path==='/git/commits'){const id=sha();commits.set(id,{tree:data.tree,parents:data.parents});return response(201,{sha:id});}
   if(method==='GET'&&path.startsWith('/git/commits/')){const c=commits.get(path.slice(13));return c?response(200,{tree:{sha:c.tree}}):response(404,{});}
   if(path.startsWith('/contents/')){const ref=u.searchParams.get('ref'),commit=commits.get(refs.get(ref)||ref),id=trees.get(commit?.tree)?.get(path.slice(10));if(!id)return response(404,{});if(options.headers?.['If-None-Match']==='"'+id+'"')return response(304);return response(200,{content:blobs.get(id).toString('base64'),encoding:'base64',sha:id},{etag:'"'+id+'"'});}
   throw Error('Unexpected fake GitHub route '+method+' '+path);
  },
  addArchive(path,event){api.archive.push({path,sha:blob(JSON.stringify(event))});},
 };return api;
}
