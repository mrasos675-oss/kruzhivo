import { parseDocumentStructure } from './document-structure.mjs';
export const GRAPH_VERSION='provisions-1';
const normalize=n=>String(n||'').replace(/^(?:пункт(?:е|а|ом|у)?|п\.)\s*/iu,'').replace(/\.$/,'').trim();
export function buildProvisionGraph(text,findings=[]){
 const nodes=parseDocumentStructure(text).map((p,i)=>({id:'p'+(i+1),number:p.number,text:p.text,findingIds:[]}));
 for(const f of findings){
  const byQuote=nodes.filter(n=>f.quote&&n.text.includes(f.quote));
  const byNumber=nodes.filter(n=>n.number===normalize(f.point));
  const candidates=byQuote.length===1?byQuote:byNumber.length===1?byNumber:[];
  if(candidates.length===1)candidates[0].findingIds.push(f.id);
 }
 for(const n of nodes)n.findingIds.sort();
 const edges=[],unresolved=[];
 const add=(from,to,reference)=>{
  const type=from.id!==to.id&&to.findingIds.length&&/(?:срок|не\s+может\s+превышать|исчерпывающ|перечень)/iu.test(from.text)?'уточняет':'ссылается';
  const found=edges.find(e=>e.from===from.id&&e.to===to.id);
  if(found){if(!found.references.includes(reference))found.references.push(reference);return;}
  edges.push({id:'e'+(edges.length+1),from:from.id,to:to.id,type,references:[reference]});
 };
 for(const node of nodes){
  const explicit=/(?<![\p{L}\p{N}])(?:пункт(?:е|а|ом|у)?|п\.)\s*(\d{1,3}(?:\.\d{1,3}){0,4})(?!\d|\.\d)/giu;
  for(const m of node.text.matchAll(explicit)){
   const targets=nodes.filter(n=>n.number===m[1]);
   if(targets.length===1)add(node,targets[0],m[0]);
   else unresolved.push({from:node.id,reference:m[0],reason:targets.length?'Номер повторяется в документе':'Пункт не найден'});
  }
  for(const m of node.text.matchAll(/настоящего\s+(раздела|пункта|регламента)/giu)){
   const scope=m[1].toLocaleLowerCase('ru');
   if(scope==='пункта'){add(node,node,m[0]);continue;}
   if(scope==='раздела'){
    const root=node.number.split('.')[0],parents=nodes.filter(n=>n.number===root);
    if(parents.length===1){add(node,parents[0],m[0]);continue;}
   }
   unresolved.push({from:node.id,reference:m[0],reason:scope==='регламента'?'Ссылка на весь документ, а не на отдельный пункт':'Раздел не выделен отдельным пунктом'});
  }
 }
 return {version:GRAPH_VERSION,nodes,edges,unresolved};
}
export function relatedProvisions(graph,findingId){
 if(!graph)return [];
 const ids=new Set(graph.nodes.filter(n=>n.findingIds.includes(findingId)).map(n=>n.id));
 return graph.edges.filter(e=>ids.has(e.from)||ids.has(e.to)).map(e=>({...e,direction:ids.has(e.to)?'incoming':'outgoing',node:graph.nodes.find(n=>n.id===(ids.has(e.to)?e.from:e.to))}));
}
