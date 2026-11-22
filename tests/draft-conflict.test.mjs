import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const send=source.match(/'expert-sign-confirm':(async b=>\{[^\n]+\}),/)[1];
const save=source.split("if(form.id==='expert-draft-form'){")[1].split('\n')[0];
test('One tab saves then sends using the acknowledged revision even if refresh fails or modal is stale',async()=>{
 const form={dataset:{case:'case',revision:'0'},elements:{text:{value:'Заключение'}}},button={dataset:{revision:'0'}},draft={text:'',revision:0},calls=[];
 const state={expertCase:{id:'case',conclusions:[draft]},expertCases:[{id:'case',status:'reviewing'}]};
 let revision=0;
 const context={form,values:{text:'Заключение'},state,$:selector=>selector.includes('expert-sign')?button:form,clearDraft:()=>{},refresh:async()=>{throw Error('Нет связи');},render:()=>{},toast:()=>{},closeModal:()=>{},go:()=>{},api:async(path,body)=>{calls.push(body.revision);assert.equal(body.revision,revision);if(path.endsWith('/draft'))return {revision:++revision};revision++;return {ok:true};}};
 await assert.rejects(vm.runInNewContext('(async()=>{'+save+')()',context),/Нет связи/);
 assert.equal(form.dataset.revision,'1');assert.equal(draft.revision,1);
 // An automatic save completes after opening a confirmation with revision 0.
 form.dataset.revision='2';revision=2;
 await vm.runInNewContext('('+send+')',context)({dataset:{case:'case',revision:'0'}});
 assert.deepEqual(calls,[0,2]);assert.equal(state.expertCases[0].status,'confirmed');
});
