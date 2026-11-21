import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
test('Only the visible running analysis polls every 30 seconds; completion stops polling without refreshing navigation',async()=>{
 const run={id:'current',status:'running',stages:{analyst:'running'}},state={account:{id:'official'},busy:false,dirty:false};let page='documents',tick,requests=0,paints=0;
 const context={state,document:{hidden:false,getElementById:()=>({}),querySelector:()=>({})},$:()=>({open:false}),route:()=>[page,'current'],currentToken:()=>page+'/current',locate:()=>({r:run}),setInterval:(fn,ms)=>{assert.equal(ms,30000);tick=fn;},api:async path=>{assert.equal(path,'runs/current/status');requests++;return {id:'current',status:'completed',stages:{analyst:'completed',reviewer:'skipped',editor:'skipped'},run:{...run,status:'completed'}};},renderAnalysis:()=>paints++,resultsPage:()=>'<section>Results</section>'};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let pollingAnalysis=false;'),source.indexOf('\nfunction isAccessLink()')),context);
 await tick();assert.equal(requests,0);page='results';context.document.hidden=true;await tick();assert.equal(requests,0);context.document.hidden=false;state.dirty=true;await tick();assert.equal(requests,0);state.dirty=false;await tick();assert.equal(requests,1);assert.equal(paints,1);assert.equal(run.status,'completed');await tick();assert.equal(requests,1);
 assert.equal((source.match(/setInterval\(/g)||[]).length,1);assert.ok(!source.includes("B('refresh-status'"));
});
