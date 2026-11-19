import test from 'node:test';
import assert from 'node:assert/strict';
import {legalBaseContent,matchesLibraryItem,filterLibrary} from '../public/legal-base.js';
import {MATERIAL_LIBRARY} from '../server/materials.mjs';
import {CATALOG} from '../server/catalog.mjs';
const source={id:'law-1',title:'Источник <script>',url:'https://example.org/act',revision:'Редакция 1',applicability:'Территория <img>',text:'Статья 1.\nТочная цитата.',active:true,verified:true,verifiedAt:'2026-11-17'};
test('Legal library keeps every source and exposes editing only to expert, with exact provenance and escaped content',()=>{
 const sources=[source,{...source,id:'pending',active:true,verified:false},{...source,id:'off',active:false,verified:true}],before=JSON.stringify(sources);
 for(const role of ['official','expert','admin']){
  const html=legalBaseContent({role,sources,catalog:CATALOG});
  assert.equal((html.match(/data-library-item /g)||[]).length,3);
  assert.match(html,/Источник &lt;script&gt;/);assert.ok(!html.includes('<img>'));assert.match(html,/Точная цитата/);
  for(const id of ['law-1','pending','off'])assert.ok(html.includes('/api/sources/'+id+'/download'));
  for(const action of ['source-new','source-edit','source-verify','source-toggle'])assert.equal(html.includes('data-action="'+action+'"'),role==='expert',action);
  assert.match(html,/В проверках: 1/);assert.match(html,/Ожидают проверки: 1/);assert.match(html,/Исключены: 1/);
  assert.match(html,/пп. «а» п. 3 Методики/);
 }
 assert.equal(JSON.stringify(sources),before);
 const empty=legalBaseContent({role:'official',sources:[]});assert.match(empty,/Нормативная база пока не заполнена/);assert.ok(!empty.includes('data-action="source-new"'));
 assert.ok(!legalBaseContent({sources:[{...source,url:'javascript:alert(1)'}]}).includes('href="javascript:'));
});
test('Legal base exposes only legal sources and methodology; legacy sample section falls back to sources',()=>{
 const html=legalBaseContent({section:'samples'});
 assert.ok(!html.includes('source-samples'));assert.ok(!html.includes('Учебные документы'));assert.ok(!html.includes('data-action="sample-start"'));
 assert.match(html,/href="#sources" aria-current="page"/);assert.match(html,/Нормативная база пока не заполнена/);
 assert.match(html,/href="#source-materials"/);
});
test('All thirteen reference files stay available with five guidance origins; grouping and natural ordering do not mutate the registry',()=>{
 const before=JSON.stringify(MATERIAL_LIBRARY),html=legalBaseContent({section:'materials',library:MATERIAL_LIBRARY});
 assert.equal((html.match(/data-library-item /g)||[]).length,13);
 assert.equal((html.match(/data-library-kind="guidance"/g)||[]).length,5);
 assert.equal((html.match(/data-library-kind="reference"/g)||[]).length,8);
 assert.ok(html.indexOf('Нормотворчество 2<')<html.indexOf('Нормотворчество 9<'));
 for(const f of MATERIAL_LIBRARY.files){assert.ok(html.includes(f.id),f.name);assert.ok(html.includes(f.localOriginalSha256));}
 assert.match(html,/Исходные файлы целиком в запросы не передаются/);assert.match(html,/автоматически не подхватываются/);
 assert.equal(JSON.stringify(MATERIAL_LIBRARY),before);
});
test('Catalog search combines Unicode-insensitive search with status, keeps empty results distinct and hides empty groups',()=>{
 assert.ok(matchesLibraryItem({search:'РЕЕСТР Ёлок',filter:'ready'},'реестр елок','ready'));
 assert.ok(matchesLibraryItem({search:'Противодеи\u0306ствие',filter:'reference'},'противодействие','all'));
 assert.ok(!matchesLibraryItem({search:'Закон',filter:'pending'},'закон','ready'));
 const search={value:'Срок'},filter={value:'ready'},count={},empty={},items=[{dataset:{librarySearchText:'Срок',libraryKind:'ready'}},{dataset:{librarySearchText:'Срок',libraryKind:'pending'}}],group={querySelectorAll:()=>[items[1]]};
 const root={querySelector:s=>({'[data-library-search]':search,'[data-library-filter]':filter,'[data-library-count]':count,'[data-library-no-matches]':empty}[s]),querySelectorAll:s=>s==='[data-library-item]'?items:[group]};
 filterLibrary(root);assert.equal(items[0].hidden,false);assert.equal(items[1].hidden,true);assert.equal(group.hidden,true);assert.equal(empty.hidden,true);assert.equal(count.textContent,'Найдено: 1 из 2');
 search.value='Ничего';filterLibrary(root);assert.equal(empty.hidden,false);
 search.value='';filter.value='all';filterLibrary(root);assert.ok(items.every(x=>!x.hidden));assert.equal(group.hidden,false);assert.equal(count.textContent,'Всего: 2');
});
