import { newRun } from './store.mjs';
import { fail } from './files.mjs';
export const stages=['analyst','reviewer','editor'];
export const nextStage=run=>stages.find(stage=>!['completed','skipped'].includes(run.stages[stage]));
export const stageLeaseMs=270000;
export function resumeRun(doc,previous,version) {
 if(!['failed','cancelled'].includes(previous.status)||doc.runs.at(-1)?.id!==previous.id)throw fail('Продолжить можно только последнюю прерванную проверку.',409);
 if(!nextStage(previous))throw fail('Все этапы уже выполнены.',409);
 const run=newRun(doc,version,previous.mode,previous.sources,previous.examples,previous.model);
 for(const field of ['connection','aiPolicy','aiInputs','aiTrace','findings','coverage','limitations','provisionGraph','sources','examples','authorSnapshot'])if(previous[field]!==undefined)run[field]=structuredClone(previous[field]);
 run.resumedFrom=previous.id;run.stageTimes={};
 let interrupted=false;
 for(const stage of stages){
  if(!interrupted&&['completed','skipped'].includes(previous.stages[stage])){run.stages[stage]=previous.stages[stage];if(previous.stageTimes?.[stage])run.stageTimes[stage]={...previous.stageTimes[stage],inheritedFrom:previous.id};}
  else{interrupted=true;run.stages[stage]='queued';}
 }
 return run;
}
