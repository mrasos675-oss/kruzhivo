import puppeteer from 'puppeteer-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.setContent('<div id="app"></div>');
 const pairSource=(await readFile('public/quote-pairs.js','utf8')).replace(/^const esc.*\n/m,'').replaceAll('export function','function');const source=(await readFile('public/expert-editor.js','utf8')).replace(/^import .*;\n/gm,'').replaceAll('export function','function');
 await page.addScriptTag({content:pairSource+source+`document.getElementById('app').innerHTML=conclusionTools()+'<form id="expert-draft-form"><label hidden><textarea name="text"></textarea></label></form>';document.querySelector('textarea[name=text]').value='РАССМОТРЕНИЕ ЗАМЕЧАНИЙ\\nЗамечание 1 — Подтверждено';installExpertEditor({getCase:()=>({document:{name:'Тестовый НПА',number:1},requestedBy:'Автор',expertProfile:{name:'Эксперт'},run:{findings:[]}}),onDirty:()=>{},save:async()=>{},onSaved:()=>{}});`});
 await page.click('input[name="expert-outcome"]');await page.type('#expert-recommendations','Рекомендация');await page.click('[data-expert-compose]');
 const field='textarea[name=text]';const first=await page.$eval(field,e=>e.value);assert.equal(await page.$eval(field,e=>e.closest('label').hidden),false);
 await page.click('[data-expert-compose]');assert.equal(await page.$eval(field,e=>e.value),first);assert.equal(await page.$('dialog'),null);
 await page.$eval(field,e=>{e.value+=' Ручная правка';e.dispatchEvent(new Event('input',{bubbles:true}));});
 const manual=await page.$eval(field,e=>e.value);await page.click('[data-expert-compose]');await page.waitForSelector('dialog[open]');await page.click('[data-compose-cancel]');assert.equal(await page.$eval(field,e=>e.value),manual);
 await page.click('[data-expert-compose]');await page.click('[data-compose-confirm]');assert.equal(await page.$eval(field,e=>e.value),first);
 console.log('PASS: opens draft, repeated click, manual edit warning, cancel, confirm');
}finally{await browser.close();}
