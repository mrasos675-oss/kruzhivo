import puppeteer from 'puppeteer-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{const page=await browser.newPage();await page.setContent('<div id="app"></div>');const pairSource=(await readFile('public/quote-pairs.js','utf8')).replace(/^const esc.*\n/m,'').replaceAll('export function','function');const source=(await readFile('public/expert-editor.js','utf8')).replace(/^import .*;\n/gm,'').replaceAll('export function','function');await page.addScriptTag({content:`const findingReviewSummary=()=>[];${pairSource}
${source}
window.c={id:'accepted',role:'expert',document:{text:'Test'},run:{findings:[{quote:'Test',point:'1'}]},conclusions:[{status:'draft',text:'Conclusion',revision:0}]};window.saved=[];window.fail=true;window.render=()=>{document.getElementById('app').innerHTML=expertReviewPanel(c)+'<form id="expert-draft-form" data-revision="'+c.conclusions[0].revision+'"><textarea name="text"></textarea></form>';document.querySelector('textarea[name=text]').value=c.conclusions[0].text;};render();installExpertEditor({getCase:()=>c,save:async(id,text,revision)=>{saved.push({text,revision});await new Promise(r=>setTimeout(r,100));if(fail)throw Error('Connection failure');return {revision:revision+1}},onDirty:()=>{},onSaved:(id,text,result)=>{c.conclusions[0].text=text;c.conclusions[0].revision=result.revision}});`});
await page.click('[data-show-quote]');
assert.equal(await page.$eval('mark.quote-ai',node=>node.classList.contains('quote-pair-active')),true);
await page.keyboard.press('Enter');
assert.equal(await page.$eval('article[data-finding-pair]',node=>node===document.activeElement),true);
const commentButton='[data-expert-verdict="modified"]';
await page.click(commentButton);
assert.equal(await page.evaluate(()=>saved.length),0);
assert.match(await page.$eval(commentButton,node=>node.getAttribute('aria-describedby')),/expert-comment-hint/);
const selector='[data-expert-verdict="confirmed"]';await page.click(selector);await page.waitForFunction(()=>document.querySelector('[data-expert-feedback]').textContent.includes('Не удалось'));assert.equal(await page.$eval('[data-expert-review-counter]',e=>e.textContent),'Рассмотрено 0 из 1');await page.evaluate(()=>fail=false);await page.click(selector);await page.waitForFunction(()=>c.conclusions[0].revision===1);assert.equal(await page.evaluate(()=>saved.length),2);await page.click(selector);assert.equal(await page.evaluate(()=>saved.length),2);await page.evaluate(()=>render());await page.waitForFunction(()=>document.querySelector('[data-expert-review-counter]').textContent==='Рассмотрено 1 из 1');assert.equal(await page.$eval(selector,e=>e.getAttribute('aria-pressed')),'true');await page.type('[data-expert-comment]', 'Уточнить редакцию');
assert.equal(await page.$eval(commentButton,node=>node.getAttribute('aria-disabled')),'false');
await page.click(commentButton);
await page.waitForFunction(()=>c.conclusions[0].revision===2);
assert.match(await page.$eval('[data-expert-status]',node=>node.textContent),/Подтверждено с комментарием/);
console.log('PASS: quote navigation in both directions, empty and saved expert comment, failed save, retry, duplicate guard, reload counter');}finally{await browser.close();}
