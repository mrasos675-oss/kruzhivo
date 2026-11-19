import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { CATALOG } from './catalog.mjs';
import { layoutReportPdf } from './pdf-report-layout.mjs';
import { reportContent } from './report-content.mjs';

function fontMetrics(font){
 const tables={};for(let i=0;i<font.readUInt16BE(4);i++){const p=12+i*16;tables[font.toString('ascii',p,p+4)]=font.readUInt32BE(p+8);}
 const head=tables.head,hhea=tables.hhea,units=font.readUInt16BE(head+18),hmetrics=font.readUInt16BE(hhea+34),cmap=tables.cmap;
 let sub4=null,sub12=null;for(let i=0;i<font.readUInt16BE(cmap+2);i++){const p=cmap+4+i*8,sub=cmap+font.readUInt32BE(p+4),format=font.readUInt16BE(sub);if(format===12)sub12=sub;if(format===4)sub4=sub;}
 const glyph=cp=>{
  if(sub12!==null){let lo=0,hi=font.readUInt32BE(sub12+12)-1;while(lo<=hi){const mid=(lo+hi)>>1,p=sub12+16+mid*12,a=font.readUInt32BE(p),b=font.readUInt32BE(p+4);if(cp<a)hi=mid-1;else if(cp>b)lo=mid+1;else return font.readUInt32BE(p+8)+cp-a;}}
  if(sub4!==null&&cp<=65535){const n=font.readUInt16BE(sub4+6)/2,end=sub4+14,start=end+2*n+2,delta=start+2*n,range=delta+2*n;for(let i=0;i<n;i++)if(cp<=font.readUInt16BE(end+i*2)){if(cp<font.readUInt16BE(start+i*2))return 0;const d=font.readInt16BE(delta+i*2),r=font.readUInt16BE(range+i*2);if(!r)return (cp+d)&65535;const p=range+i*2+r+2*(cp-font.readUInt16BE(start+i*2));if(p+2>font.length)return 0;const g=font.readUInt16BE(p);return g?(g+d)&65535:0;}}
  return 0;
 };
 const width=cp=>font.readUInt16BE(tables.hmtx+4*Math.min(glyph(cp),hmetrics-1))*1000/units;
 return {glyph,width,bbox:[36,38,40,42].map(o=>Math.round(font.readInt16BE(head+o)*1000/units)),ascent:Math.round(font.readInt16BE(hhea+4)*1000/units),descent:Math.round(font.readInt16BE(hhea+6)*1000/units)};
}
export function createPdfDocument(blocks,font){
 const metrics=fontMetrics(font),used=new Map(),chars=[];
 const cid=ch=>{if(!used.has(ch)){chars.push(ch);used.set(ch,chars.length);}return used.get(ch);};
 const encode=s=>[...s].map(ch=>cid(ch).toString(16).padStart(4,'0')).join('');
 const measure=(s,size)=>[...s].reduce((n,ch)=>n+metrics.width(ch.codePointAt(0))*size/1000,0);
 const wrap=(text,size,width)=>{const rows=[];for(const para of String(text).split(/\r?\n/)){let line='';for(const token of para.split(/(\s+)/)){if(measure(line+token,size)<=width){line+=token;continue;}if(line.trim())rows.push(line.trimEnd());line='';for(const ch of token){if(line&&measure(line+ch,size)>width){rows.push(line);line='';}line+=ch;}}rows.push(line.trimEnd());}return rows;};
 const pages=[];let lines=[],y=790;const flush=()=>{pages.push(lines.join('\n'));lines=[];y=790;};
 for(const b of blocks){const size=b.size||11,leading=size*1.45,rows=wrap(b.text,size,485);if(y-(Math.min(rows.length,3)*leading)<70)flush();for(const row of rows){if(y-leading<70)flush();lines.push('BT /F1 '+size+' Tf 1 0 0 1 55 '+y.toFixed(2)+' Tm <'+encode(row)+'> Tj ET');y-=leading;}y-=b.space??8;}
 if(lines.length||!pages.length)flush();
 const footer='Предварительный отчёт системы. Не является заключением антикоррупционной экспертизы';
 pages.forEach((_,i)=>{pages[i]+='\nBT /F1 7.5 Tf 1 0 0 1 40 35 Tm <'+encode(footer+' · '+(i+1)) +'> Tj ET';});
 const cidMap=Buffer.alloc((chars.length+1)*2);for(let i=0;i<chars.length;i++)cidMap.writeUInt16BE(metrics.glyph(chars[i].codePointAt(0)),(i+1)*2);
 const unicode=s=>{let value='';for(let i=0;i<s.length;i++)value+=s.charCodeAt(i).toString(16).padStart(4,'0');return value;};
 const mappings=chars.map((ch,i)=>'<'+(i+1).toString(16).padStart(4,'0')+'> <'+unicode(ch)+'>');
 let cmap='/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /KruzhivoUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
 for(let i=0;i<mappings.length;i+=100){const chunk=mappings.slice(i,i+100);cmap+=chunk.length+' beginbfchar\n'+chunk.join('\n')+'\nendbfchar\n';}cmap+='endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
 const objects=[],add=v=>{objects.push(Buffer.isBuffer(v)?v:Buffer.from(v));return objects.length;};
 const stream=(data,extra='')=>{const compressed=deflateSync(data);return Buffer.concat([Buffer.from('<< /Length '+compressed.length+' /Filter /FlateDecode '+extra+' >>\nstream\n'),compressed,Buffer.from('\nendstream')]);};
 const catalog=add(''),root=add(''),fontFile=add(stream(font,'/Length1 '+font.length)),descriptor=add('<< /Type /FontDescriptor /FontName /KruzhivoInter /Flags 32 /FontBBox ['+metrics.bbox.join(' ')+'] /ItalicAngle 0 /Ascent '+metrics.ascent+' /Descent '+metrics.descent+' /CapHeight '+metrics.ascent+' /StemV 80 /FontFile2 '+fontFile+' 0 R >>'),map=add(stream(cidMap)),toUnicode=add(stream(Buffer.from(cmap))),descendant=add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /KruzhivoInter /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor '+descriptor+' 0 R /CIDToGIDMap '+map+' 0 R /DW 1000 /W [1 ['+chars.map(ch=>Math.round(metrics.width(ch.codePointAt(0)))).join(' ')+']] >>'),type0=add('<< /Type /Font /Subtype /Type0 /BaseFont /KruzhivoInter /Encoding /Identity-H /DescendantFonts ['+descendant+' 0 R] /ToUnicode '+toUnicode+' 0 R >>');
 const kids=pages.map(p=>{const content=add(stream(Buffer.from(p)));return add('<< /Type /Page /Parent '+root+' 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 '+type0+' 0 R >> >> /Contents '+content+' 0 R >>');});
 objects[catalog-1]=Buffer.from('<< /Type /Catalog /Pages '+root+' 0 R >>');objects[root-1]=Buffer.from('<< /Type /Pages /Kids ['+kids.map(x=>x+' 0 R').join(' ')+'] /Count '+kids.length+' >>');
 const out=[Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n','binary')],offsets=[0];let offset=out[0].length;
 objects.forEach((o,i)=>{const part=Buffer.concat([Buffer.from((i+1)+' 0 obj\n'),o,Buffer.from('\nendobj\n')]);offsets.push(offset);out.push(part);offset+=part.length;});
 const xref=offset;out.push(Buffer.from('xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root '+catalog+' 0 R >>\nstartxref\n'+xref+'\n%%EOF\n'));return Buffer.concat(out);
}
export async function legacyReportPdf(doc,version,run,profile={}){
 const model=reportContent(doc,version,run,profile),font=await readFile(new URL('../public/fonts/InterTight.ttf',import.meta.url));
 const blocks=[{text:model.title,size:17,space:15},...model.metadata.map(([k,v])=>({text:k+': '+v,size:10,space:5})),...model.lines.slice(model.skip).filter(Boolean).map(t=>({text:t,size:/^(ОГРАНИЧЕНИЯ|ОХВАТ|ПОДТВЕРЖД|ИЗМЕНЁННЫЕ|ОТКЛОНЁННЫЕ|НЕ РАССМОТРЕННЫЕ|Снимок источников)/.test(t)?14:/^Замечание \d+/.test(t)?12:10.5,space:8}))];
 return createPdfDocument(blocks,font);
}

export function reportPdf(doc, version, run, profile = {}, { legacy = false } = {}) {
  return legacy ? legacyReportPdf(doc, version, run, profile)
    : layoutReportPdf(doc, version, run, profile, run.aiPolicy?.catalog || CATALOG);
}
