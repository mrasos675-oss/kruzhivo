import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const handler=source.match(/'expert-sign-confirm':(async b=>\{[^\n]+\}),/)[1];
for(const failure of [false,true])test(failure?'Sending failure preserves the form and draft':'Sending returns to My cases even when refresh fails',async()=>{
 const calls=[],state={expertCases:[{id:'case',status:'reviewing'}],queueFilter:'reviewing',draft:'Введённый текст'};
 const run=vm.runInNewContext('('+handler+')',{$:()=>({elements:{text:{value:'Введённый текст'}}}),state,api:async()=>{if(failure)throw Error('Сеть');},closeModal:()=>calls.push('close'),toast:()=>{},go:token=>calls.push(token),refresh:async()=>{throw Error('Сеть');},render:()=>calls.push('render')});
 await run({dataset:{case:'case',revision:'2'}});
 assert.equal(state.draft,'Введённый текст');assert.ok(!calls.includes('render'));
 assert.equal(calls.includes('expert-done'),!failure);
 assert.equal(state.expertCases[0].status,failure?'reviewing':'confirmed');
});

