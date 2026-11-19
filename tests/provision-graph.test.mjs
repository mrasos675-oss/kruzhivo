import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProvisionGraph,relatedProvisions } from '../shared/provision-graph.mjs';
import { SAMPLE_TEXT,demoAnalysis } from '../server/catalog.mjs';
import { pipeline } from '../server/engine.mjs';
import { createApp } from '../server/index.mjs';
import { newRun,version } from '../server/store.mjs';

test('Teaching document has deterministic 2.6 to 2.5 clarification and incoming context',()=>{
 const findings=demoAnalysis(SAMPLE_TEXT).findings,g=buildProvisionGraph(SAMPLE_TEXT,findings);
 assert.deepEqual(buildProvisionGraph(SAMPLE_TEXT,findings),g);
 const a=g.nodes.find(n=>n.number==='2.6'),b=g.nodes.find(n=>n.number==='2.5');
 assert.ok(g.edges.some(e=>e.from===a.id&&e.to===b.id&&e.type==='уточняет'));
 const links=relatedProvisions(g,'finding-2');assert.equal(links[0].direction,'incoming');assert.equal(links[0].node.number,'2.6');
 assert.deepEqual(buildProvisionGraph(SAMPLE_TEXT,[...findings].reverse()),g);
 assert.equal(g.nodes.length,8);
});
test('References, grammatical forms, terminal punctuation, scopes and missing targets are explicit',()=>{
 const text='1. Раздел.\n1.1. Срок по п. 1.2. Указанное в пункте 1.2 настоящего раздела.\n1.2. Правила настоящего пункта и настоящего регламента; согласно пункта 1.1, пунктом 1.1 и пункт 9.8.';
 const g=buildProvisionGraph(text,[{id:'f',point:'1.2',quote:'Правила настоящего пункта'}]);
 const n=number=>g.nodes.find(n=>n.number===number).id;
 assert.ok(g.edges.some(e=>e.from===n('1.1')&&e.to===n('1.2')&&e.type==='уточняет'));
 assert.ok(g.edges.some(e=>e.from===n('1.1')&&e.to===n('1')));
 assert.ok(g.edges.some(e=>e.from===n('1.2')&&e.to===n('1.2')&&e.type==='ссылается'));
 const e=g.edges.find(e=>e.from===n('1.2')&&e.to===n('1.1'));assert.equal(e.references.length,2);
 assert.equal(g.unresolved.length,2);assert.ok(g.unresolved.some(e=>e.reason.includes('весь документ')));
});
test('Ambiguous point numbers are not guessed and keywords alone create no edges',()=>{
 const g=buildProvisionGraph('1. Срок и перечень. 2. По пункту 1. 1. Другой раздел. 3. См. п. 1.',[{id:'x',point:'1',quote:'absent'}]);
 assert.ok(g.nodes.every(n=>!n.findingIds.length));assert.equal(g.edges.length,0);assert.ok(g.unresolved.some(e=>e.reason.includes('повторяется')));
 assert.equal(buildProvisionGraph('Срок не может превышать 10 дней.').edges.length,0);
});
test('Pipeline persists graph with findings, new run captures initial structure without API',async()=>{
 const v=version(SAMPLE_TEXT),d={id:'d',runs:[]},r=newRun(d,v,'demo',[],[],'');
 assert.equal(r.provisionGraph.nodes.length,8);
 const updates=[];await pipeline(r,v.text,{signal:new AbortController().signal},async(stage,status,patch)=>{updates.push(structuredClone(patch));});
 const saved=updates.find(x=>x?.provisionGraph);assert.ok(saved);assert.ok(saved.provisionGraph.edges.some(e=>e.type==='уточняет'));
 assert.deepEqual(saved.provisionGraph,r.provisionGraph);
});
test('HTTP backfills a legacy run once, exports graph in manifest, persists it and preserves decisions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'kruzhivo-graph-')),app=await createApp({dataDir:dir,initialKey:''});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,doc=app.store.read().documents[0],r=doc.runs[0],before=structuredClone(r.findings);
 await app.store.change(db=>{delete db.documents[0].runs[0].provisionGraph;});
 const post=()=>fetch(base+'/api/runs/'+r.id+'/provision-graph',{method:'POST',headers:{origin:base,'x-kruzhivo-client':'1','content-type':'application/json'},body:'{}'});
 const first=await post();assert.equal(first.status,200);const graph=await first.json();assert.ok(graph.edges.some(e=>e.type==='уточняет'));
 assert.deepEqual(await (await post()).json(),graph);
 assert.deepEqual(app.store.read().documents[0].runs[0].findings,before);
 const manifest=await (await fetch(base+'/api/runs/'+r.id+'/manifest.json')).json();assert.deepEqual(manifest.provisionGraph,graph);
 const disk=JSON.parse(await readFile(join(dir,'workspace.json'),'utf8'));assert.deepEqual(disk.documents[0].runs[0].provisionGraph,graph);
 const absent=await fetch(base+'/api/runs/absent/provision-graph',{method:'POST',headers:{origin:base,'x-kruzhivo-client':'1','content-type':'application/json'},body:'{}'});assert.equal(absent.status,404);
});
test('Frontend exposes graph tab, linked point reader and clarification warning with escaped content',async()=>{
 const ui=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
 assert.match(ui,/Граф связей/);assert.match(ui,/relatedBlock\(r,f\)/);assert.match(ui,/graphWarning\(r,f\)/);assert.match(ui,/e.direction==='incoming'/);assert.match(ui,/esc\(n.text\)/);assert.match(ui,/page==='provision'/);assert.match(ui,/graph-build/);assert.match(build,/provision-graph.mjs/);
});
