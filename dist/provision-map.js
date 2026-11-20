import { pathFor } from './portal-router.js';

const cardWidth = 218;
const cardHeight = 148;
const columnGap = 110;
const rowGap = 28;
const margin = 40;

function provisionLabel(number) {
  if (number.startsWith('Абзац ')) return number;
  return (number.endsWith(')') ? 'Подпункт ' : 'Пункт ') + number;
}

function nodeExcerpt(text, references) {
  const refs = references.filter(Boolean);
  const fragments = text.match(/[^!?\n]+?(?:[!?]|\.(?=\s+[А-ЯЁA-Z])|$)/gu) || [text];
  const candidate = fragments.find(fragment => fragment.trim().length >= 24 && !refs.some(reference=>fragment.includes(reference)));
  if (candidate) return candidate.trim();
  const reference = refs.find(value=>text.includes(value));
  if (reference) {
    const at = text.indexOf(reference);
    const after = text.slice(at+reference.length).replace(/^[\s,.;:]+/u,'');
    if (after.length >= 24) return after;
  }
  return text.trim();
}

function referenceContext(text, reference) {
  if (!reference) return '';
  const at = text.indexOf(reference);
  if (at < 0) return '';
  const start = text.lastIndexOf('\n',at-1)+1;
  const end = text.indexOf('\n',at+reference.length);
  return text.slice(start,end<0?text.length:end).trim();
}

function layoutColumns(columns, nodeHeight = () => cardHeight) {
  const heights = columns.map(items=>items.reduce((sum,id)=>sum+nodeHeight(id)+rowGap,0)-rowGap);
  const tallest = Math.max(...heights);
  const positions = new Map();
  for (const [column, items] of columns.entries()) {
    let y = margin+(tallest-heights[column])/2;
    for (const id of items) {
      const height = nodeHeight(id);
      positions.set(id,{x:margin+column*(cardWidth+columnGap),y,height,column});
      y += height+rowGap;
    }
  }
  return {positions,width:columns.length*(cardWidth+columnGap)-columnGap+margin*2,height:tallest+margin*2};
}

function placeNodes(links, nodes) {
  const incoming = new Set(links.filter(link => !link.reason).map(link => link.to.id));
  const useMiddle = incoming.size > 0 && links.some(link => link.reason);
  const columns = [[], [], []];
  const sources = new Set(links.map(link => link.from.id));
  const unresolved = new Map();
  for (const link of links) {
    if (link.reason) unresolved.set(link.to.id, link.to);
  }
  for (const node of nodes) {
    if (!sources.has(node.id) && !incoming.has(node.id)) continue;
    const column = incoming.has(node.id) && !sources.has(node.id) ? 1 : 0;
    columns[column].push(node);
  }
  // A cycle may have no entry node. Spread it across two columns.
  if (!columns[1].length && columns[0].length > 1 && incoming.size) {
    columns[1].push(...columns[0].splice(Math.ceil(columns[0].length / 2)));
  }
  columns[useMiddle ? 2 : 1].push(...unresolved.values());

  return columns.filter(column=>column.length).map(column=>column.map(node=>node.id));
}

function connector(from, to, fromOffset, toOffset) {
  if (from.x === to.x) {
    const x = from.x + cardWidth;
    const sy = from.y + fromOffset;
    const ey = to.y + toOffset;
    return { d: `M ${x} ${sy} C ${x + 48} ${sy}, ${x + 48} ${ey}, ${x} ${ey}`, x: x + 32, y: (sy + ey) / 2 };
  }
  const forward = from.x < to.x;
  const sx = from.x + (forward ? cardWidth : 0);
  const ex = to.x + (forward ? 0 : cardWidth);
  const sy = from.y + fromOffset;
  const ey = to.y + toOffset;
  const mx = (sx + ex) / 2;
  if (Math.abs(from.x-to.x)>cardWidth+columnGap) {
    const direction = forward ? 1 : -1;
    const x1 = sx+24*direction, x2 = ex-24*direction, top = margin/2;
    return {d:`M ${sx} ${sy} C ${x1} ${sy}, ${x1} ${sy}, ${x1} ${sy-14} L ${x1} ${top+10} Q ${x1} ${top}, ${x1+10*direction} ${top} L ${x2-10*direction} ${top} Q ${x2} ${top}, ${x2} ${top+10} L ${x2} ${ey-14} C ${x2} ${ey}, ${x2} ${ey}, ${ex} ${ey}`,x:mx,y:top};
  }
  return { d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`, x: mx, y: (sy + ey) / 2 };
}

export function renderProvisionMap(run, { esc, findingCount }) {
  const graph = run.provisionGraph;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const links = [];
  const selfReferences = [];
  const endpointNames = new Map();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to) continue;
    const link = { from, to, references:edge.references, type:edge.type };
    if (from === to) selfReferences.push(link);
    else links.push(link);
  }
  const unmatched = new Map();
  for (const item of graph.unresolved) {
    const from = nodes.get(item.from);
    if (!from) continue;
    const normalized = item.reference.trim().toLocaleLowerCase('ru').replace(/^(?:пункт(?:е|а|ом|у)?|п\.)\s*/iu, 'п. ');
    const key = JSON.stringify([normalized, item.reason]);
    if (!endpointNames.has(key)) endpointNames.set(key, {id:'unresolved-'+endpointNames.size, title:'Ссылка на «'+normalized+'»', text:item.reason});
    const to = endpointNames.get(key);
    const identity = from.id + '/' + to.id;
    const existing = unmatched.get(identity);
    if (existing) {
      existing.references.push(item.reference);
      continue;
    }
    const link = {from, to, reason:item.reason, references:[item.reference]};
    unmatched.set(identity, link);
    links.push(link);
  }

  const outgoing = Map.groupBy(links, link=>link.from.id);
  const excerpts = new Map([...nodes.values()].map(node=>[node.id,nodeExcerpt(node.text,(outgoing.get(node.id)||[]).flatMap(link=>link.references))]));
  const pointRoute = node => pathFor('provision/'+run.id+'/'+node.id);
  const pointCard = node => {
    const label = esc(provisionLabel(node.number));
    const excerpt = excerpts.get(node.id);
    const prefix = node.text.trimStart().startsWith(excerpt) ? '' : '… ';
    const text = prefix + excerpt.replace(/\s+/gu,' ');
    return `<a class="provision-map-node" href="${esc(pointRoute(node))}"><strong>${label}</strong>
      <span class="provision-map-excerpt">${esc(text)}</span>
      ${node.findingIds.length?`<small class="provision-map-count">${findingCount(node.findingIds.length)}</small>`:''}
    </a>`;
  };
  const allPoints = nodes.size ? `<details class="card provision-graph-details"><summary>Все пункты документа (${nodes.size})</summary>
    <ul class="provision-node-list">${[...nodes.values()].map(node=>`<li>${pointCard(node)}</li>`).join('')}</ul>
  </details>` : '';
  const selfLinks = selfReferences.length ? `<details class="card provision-graph-details"><summary>Ссылки на тот же пункт (${selfReferences.length})</summary>
    <ul class="provision-node-list">${selfReferences.map(({from})=>`<li>${pointCard(from)}</li>`).join('')}</ul>
  </details>` : '';
  if (!links.length) return '<section class="card provision-map-empty"><h2>Ссылки между пунктами не найдены</h2><p class="muted">Ниже можно открыть текст каждого распознанного пункта.</p></section>'+selfLinks+allPoints;

  const columns = placeNodes(links,[...nodes.values()]);
  const { positions,width,height } = layoutColumns(columns);
  const incoming = Map.groupBy(links, link=>link.to.id);
  const offset = (group, link) => cardHeight * (group.indexOf(link)+1) / (group.length+1);
  const edgeName = link => link.reason?'Нужна сверка':link.type==='уточняет'?'Возможное уточнение':'Прямая ссылка';
  const edgeDescription = link => provisionLabel(link.from.number)+' → '+(link.reason?link.references[0]:provisionLabel(link.to.number))+' · '+edgeName(link);
  const optionTitle = link => link.from.number+' → '+(link.reason?link.references[0]:link.to.number);
  const evidence = link => {
    const quote = referenceContext(link.from.text, link.references[0] || '');
    return `<h2>Основание связи</h2>
      ${quote?`<blockquote>${esc(quote)}</blockquote>`:`<p class="muted">${esc(link.references.join(' · '))}</p>`}
      ${link.reason?`<div class="provision-evidence-question"><h3>Что сверить</h3><p>${esc(link.reason)}. Проверьте, к какому пункту относится ссылка.</p></div>`
        :link.type==='уточняет'?'<div class="provision-evidence-question"><h3>Что сверить</h3><p>Проверьте, уточняет ли эта ссылка условие из связанного пункта.</p></div>':''}
      ${link.reason&&link.references.length>1?`<p class="muted">Упоминаний ссылки в пункте: ${link.references.length}.</p>`:''}
      <a class="btn compact" href="${esc(pointRoute(link.from))}">Открыть пункт с цитатой</a>`;
  };
  const edgeMarkup = links.map((link,index)=>{
    const line=connector(positions.get(link.from.id),positions.get(link.to.id),offset(outgoing.get(link.from.id),link),offset(incoming.get(link.to.id),link));
    return `<g class="provision-map-edge${link.reason?' unresolved':''}" data-provision-edge="${index}" data-from="${esc(link.from.id)}" data-to="${esc(link.to.id)}" role="button" tabindex="0" aria-pressed="${index===0}" aria-label="${esc(edgeDescription(link))}">
      <path class="provision-edge-hit" d="${line.d}"/>
      <path class="provision-edge-line" d="${line.d}" marker-end="url(#${link.reason?'provision-arrow-unresolved':'provision-arrow'})"/>
      ${!link.reason?`<text class="provision-edge-caption" x="${line.x}" y="${line.y-7}" text-anchor="middle">${link.type==='уточняет'?'Уточнение?':'Ссылается'}</text>`:''}
    </g>`;
  }).join('');
  const canvasNodes = [...nodes.values(),...endpointNames.values()].filter(node=>positions.has(node.id)).map(node=>{
    const p=positions.get(node.id);
    const mark=node.number?pointCard(node):`<div class="provision-map-node unresolved"><strong>${esc(node.title)}</strong><span class="provision-map-excerpt">${esc(node.text)}</span></div>`;
    const selected = [links[0].from.id,links[0].to.id].includes(node.id);
    return `<foreignObject x="${p.x}" y="${p.y}" width="${cardWidth}" height="${cardHeight}" class="provision-map-object${selected?' linked':''}" data-provision-node="${esc(node.id)}" data-column="${p.column}">${mark}</foreignObject>`;
  }).join('');
  return `<div class="provision-map-layout" data-provision-map>
    <div class="provision-map-scroll" tabindex="0" aria-label="Граф связей, область прокрутки">
      <svg class="provision-map-canvas" data-columns="${columns.length}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Связи между пунктами документа">
        <defs>
          <marker id="provision-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z"/></marker>
          <marker id="provision-arrow-unresolved" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z"/></marker>
        </defs>
        ${edgeMarkup}${canvasNodes}
      </svg>
    </div>
    <aside class="card provision-map-inspector" aria-label="Сведения о связи">
      <label class="provision-map-picker"><span>Выбранная связь</span>
        <select data-provision-select>${links.map((link,index)=>`<option value="${index}">${esc(optionTitle(link))}</option>`).join('')}</select>
      </label>
      <div class="provision-map-evidence" aria-live="polite">${evidence(links[0])}</div>
      ${links.map((link,index)=>`<template data-provision-evidence="${index}" data-from="${esc(link.from.id)}" data-to="${esc(link.to.id)}">${evidence(link)}</template>`).join('')}
    </aside>
  </div>
  <div class="provision-map-legend"><span>Прямая ссылка</span><span class="unresolved">Нужна сверка</span></div>
  ${selfLinks}${allPoints}`;
}

function fitProvisionMap(map) {
  const svg = map.querySelector('.provision-map-canvas');
  const objects = [...svg.querySelectorAll('[data-provision-node]')];
  const columns = Array.from({length:Number(svg.dataset.columns)},()=>[]);
  const nodes = new Map(objects.map(node=>[node.dataset.provisionNode,node]));
  for (const node of objects) columns[Number(node.dataset.column)].push(node.dataset.provisionNode);
  const {positions,width,height} = layoutColumns(columns,id=>Math.max(70,nodes.get(id).firstElementChild.offsetHeight));
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.setAttribute('height',height);
  for (const [id,p] of positions) {
    const node = nodes.get(id);
    node.setAttribute('x',p.x);
    node.setAttribute('y',p.y);
    node.setAttribute('height',p.height);
  }
  const edges = [...svg.querySelectorAll('[data-provision-edge]')];
  const outgoing = Map.groupBy(edges,edge=>edge.dataset.from);
  const incoming = Map.groupBy(edges,edge=>edge.dataset.to);
  for (const edge of edges) {
    const {from,to}=edge.dataset;
    const start=positions.get(from), end=positions.get(to);
    const offsets = (group,height) => height*(group.indexOf(edge)+1)/(group.length+1);
    const line = connector(start,end,offsets(outgoing.get(from),start.height),offsets(incoming.get(to),end.height));
    for (const path of edge.querySelectorAll('path')) path.setAttribute('d',line.d);
    const caption=edge.querySelector('text');
    if(caption){caption.setAttribute('x',line.x);caption.setAttribute('y',line.y-7);}
  }
}

export function installProvisionMap(root = document) {
  let currentMap;
  const resize = new ResizeObserver(()=>{if(currentMap?.isConnected)fitProvisionMap(currentMap);});
  const observeMap = () => {
    const map = root.querySelector('[data-provision-map]');
    if(map===currentMap)return;
    resize.disconnect();
    currentMap=map;
    if(!map)return;
    fitProvisionMap(map);
    for(const node of map.querySelectorAll('.provision-map-object .provision-map-node'))resize.observe(node);
  };
  new MutationObserver(observeMap).observe(root.getElementById('app'),{subtree:true,childList:true});
  const selectLink = (map, index) => {
    const template = map.querySelector(`[data-provision-evidence="${Number(index)}"]`);
    if (!template) return;
    map.querySelector('.provision-map-evidence').replaceChildren(template.content.cloneNode(true));
    map.querySelector('[data-provision-select]').value = index;
    for (const arrow of map.querySelectorAll('[data-provision-edge]')) {
      arrow.setAttribute('aria-pressed', String(arrow.dataset.provisionEdge === index));
    }
    for (const node of map.querySelectorAll('[data-provision-node]')) {
      node.classList.toggle('linked', [template.dataset.from,template.dataset.to].includes(node.dataset.provisionNode));
    }
  };
  const selectArrow = event => {
    const arrow = event.target.closest('[data-provision-edge]');
    if (!arrow) return;
    event.preventDefault();
    selectLink(arrow.closest('[data-provision-map]'), arrow.dataset.provisionEdge);
  };
  root.addEventListener('click', selectArrow);
  root.addEventListener('keydown', event => {
    if (event.key==='Enter'||event.key===' ') selectArrow(event);
  });
  root.addEventListener('change', event => {
    if (event.target.matches('[data-provision-select]')) selectLink(event.target.closest('[data-provision-map]'),event.target.value);
  });
}
