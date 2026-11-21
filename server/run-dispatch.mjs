// Credentials are forwarded only to the deployment's own, configured HTTPS origin.
export function createRunDispatcher(req,{request=fetch,production=process.env.VERCEL_PROJECT_PRODUCTION_URL,deployment=process.env.VERCEL_URL}={}) {
 const host=req.headers.host;
 if(![production,deployment,'kruzhivo-github.vercel.app'].filter(Boolean).includes(host))return null;
 const origin='https://'+host,cookie=req.headers.cookie||'';
 return async runId=>{
  const response=await request(origin+'/api/runs/'+encodeURIComponent(runId)+'/advance',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-kruzhivo-client':'1',Origin:origin,Cookie:cookie},body:'{}',signal:AbortSignal.timeout(30000)});
  await response.body?.cancel();
  if(!response.ok)throw Error('Не удалось продолжить следующий этап.');
 };
}
