import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const actions=source.slice(source.indexOf(" 'confirm-modified':"),source.indexOf(" 'previous-finding':"));
test('Editing opens a focused proposal without saving; only the separate save action persists it',async()=>{
 const proposal={value:'Проект редакции'},input={value:'Проект редакции',focus(){this.focused=true;},setSelectionRange(start,end){this.selection=[start,end];}};
 const saved=[];let closed=0;
 const context={target:()=>({f:{},d:{},r:{status:'completed'},index:1}),isArchived:()=>false,
  $:selector=>selector.startsWith('#modal')?input:proposal,
  field:()=>'',B:action=>action,modal:(title,body,buttons)=>{assert.equal(title,'Замечание № 2');assert.match(buttons,/save-modified/);assert.match(buttons,/modal-close/);},
  saveDecision:async status=>saved.push({status,proposal:proposal.value}),closeModal:()=>closed++};
 vm.createContext(context);vm.runInContext('globalThis.actions={'+actions+'}',context);
 context.actions['confirm-modified']();
 assert.equal(input.focused,true);assert.deepEqual(input.selection,[proposal.value.length,proposal.value.length]);assert.equal(saved.length,0);
 input.value='Новая редакция';context.closeModal();
 assert.equal(proposal.value,'Проект редакции');assert.equal(saved.length,0);
 context.actions['confirm-modified']();input.value='Проверенная редакция';
 await context.actions['save-modified']();
 assert.deepEqual(saved,[{status:'modified',proposal:'Проверенная редакция'}]);assert.equal(closed,2);
 context.isArchived=()=>true;input.focused=false;context.actions['confirm-modified']();assert.equal(input.focused,false);
});
