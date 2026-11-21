const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Resolve only exact text. A repeated quote needs an unambiguous numbered point.
export function quoteRange(text, finding) {
 const quote = finding.quote;
 if (!quote) return null;
 const matches = [];
 for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) matches.push(start);
 if (!matches.length) return null;
 const point = String(finding.point || '').trim().replace(/^(?:пункт|п\.)\s*/iu, '').replace(/\.$/, '');
 const markers = [...text.matchAll(/^\s*(\d+(?:\.\d+)*)[.)]?\s+\S/gmu)];
 const points = markers.filter(m => m[1] === point);
 let candidates = matches;
 if (points.length) {
  if (points.length !== 1) return null;
  const marker = points[0], next = markers[markers.indexOf(marker) + 1];
  candidates = matches.filter(start => start >= marker.index && start + quote.length <= (next?.index ?? text.length));
 }
 if (candidates.length !== 1) return null;
 return {start:candidates[0], end:candidates[0] + quote.length};
}

export function documentWithPairs(text, findings) {
 const ranges = findings.map(f => quoteRange(text, f));
 const boundaries = [...new Set([0, text.length, ...ranges.filter(Boolean).flatMap(r => [r.start, r.end])])].sort((a,b) => a-b);
 let html = '';
 for (let i=0; i<boundaries.length-1; i++) {
  const start=boundaries[i], end=boundaries[i+1];
  const indexes=ranges.flatMap((r,index) => r && r.start<=start && r.end>=end ? [index] : []);
  const fragment=esc(text.slice(start,end));
  html += indexes.length ? `<mark tabindex="0" role="button" data-quote-pairs="${indexes.join(' ')}" aria-label="Открыть замечание ИИ ${indexes.map(n=>n+1).join(', ')}">${fragment}</mark>` : fragment;
 }
 return html;
}

export function activateQuotePair(panel, index, direction) {
 const card=panel.querySelector(`[data-finding-pair="${index}"]`);
 const marks=[...panel.querySelectorAll('[data-quote-pairs]')].filter(mark => mark.dataset.quotePairs.split(' ').includes(String(index)));
 for (const node of panel.querySelectorAll('.quote-pair-active')) node.classList.remove('quote-pair-active');
 card?.classList.add('quote-pair-active');
 for (const mark of marks) mark.classList.add('quote-pair-active');
 panel.dataset.activePair=String(index);
 const status=panel.querySelector('[data-quote-pair-status]');
 if(status) status.textContent=marks.length ? `Выбрано замечание ${Number(index)+1} и его цитата в документе.` : 'Точная цитата не найдена однозначно. Переход недоступен.';
 const target=direction==='finding' ? card : marks[0];
 if (!target) return false;
 target.scrollIntoView({behavior:'smooth',block:'center'});
 target.setAttribute('tabindex','-1');
 // Marks remain keyboard reachable after selection.
 if(direction!=='finding') target.setAttribute('tabindex','0');
 target.focus({preventScroll:true});
 return true;
}

export function handleQuotePairClick(event) {
 const panel=event.target.closest('.expert-review-panel');
 if(!panel) return false;
 const mark=event.target.closest('[data-quote-pairs]');
 if(mark) {
  const indexes=mark.dataset.quotePairs.split(' ');
  activateQuotePair(panel,indexes.includes(panel.dataset.activePair)?panel.dataset.activePair:indexes[0],'finding');
  return true;
 }
 const card=event.target.closest('[data-finding-pair]');
 if(!card) return false;
 const button=event.target.closest('[data-show-quote]');
 if(!button && (event.target.closest('a,button,input,textarea,select,label,details') || panel.ownerDocument.defaultView.getSelection()?.toString())) return false;
 activateQuotePair(panel,card.dataset.findingPair,'quote');
 return true;
}
