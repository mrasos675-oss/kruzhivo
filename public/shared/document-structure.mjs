
export function parseDocumentStructure(text){
 const markers=[...text.matchAll(/(?:^|[\s])((?:\d{1,3}\.){1,5}|[а-я]\))(?=\s+\S)/gmu)].filter(m=>{const token=m[1];return !/^\d{4}\.$/.test(token)&&!/(?:пункт(?:е|а|ом|у)?|п\.)\s*$/iu.test(text.slice(Math.max(0,m.index-40),m.index));});
 if(!markers.length)return text.split(/\n\s*\n|\n/).filter(s=>s.trim()).map((s,i)=>({number:'Абзац '+(i+1),text:s.trim()}));
 return markers.map((m,i)=>({number:m[1].replace(/\.$/,''),text:text.slice(m.index+m[0].length,markers[i+1]?.index??text.length).trim()}));
}
