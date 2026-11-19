const xml=s=>String(s??'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const run=(text,bold=false)=>`<w:r>${bold?'<w:rPr><w:b/></w:rPr>':''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
function p(text,style='Normal'){const colon=String(text).indexOf(':');const content=style==='Normal'&&colon>0&&colon<90?run(String(text).slice(0,colon+1),true)+run(String(text).slice(colon+1)):run(text);return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${content}</w:p>`;}
function table(rows){return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(x=>`<w:${x} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6960"/></w:tblGrid>${rows.map(([k,v],i)=>`<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/><w:shd w:fill="F1F3F4"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${run(k,true)}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6960" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${p(v,'TableText')}</w:tc></w:tr>`).join('')}</w:tbl>`;}
const styles=`<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:color w:val="000000"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${[
 ['Normal','Обычный','', '<w:spacing w:after="140" w:line="288" w:lineRule="auto"/>',''],
 ['Title','Заголовок документа','Normal','<w:spacing w:before="120" w:after="260"/><w:keepNext/>','<w:b/><w:sz w:val="36"/>'],
 ['Heading1','Заголовок 1','Normal','<w:spacing w:before="300" w:after="160"/><w:keepNext/><w:outlineLvl w:val="0"/>','<w:b/><w:sz w:val="27"/>'],
 ['Heading2','Заголовок 2','Normal','<w:spacing w:before="220" w:after="120"/><w:keepNext/><w:outlineLvl w:val="1"/>','<w:b/><w:sz w:val="24"/>'],
 ['Quote','Цитата','Normal','<w:ind w:left="360" w:right="180"/><w:spacing w:before="80" w:after="180"/>','<w:i/>'],
 ['Caption','Служебные сведения','Normal','<w:spacing w:after="120"/>','<w:sz w:val="19"/>'],
 ['TableText','Текст таблицы','Normal','<w:spacing w:after="0" w:line="264" w:lineRule="auto"/>','<w:sz w:val="20"/>']
].map(([id,name,based,pp,rp])=>`<w:style w:type="paragraph" w:styleId="${id}" ${id==='Normal'?'w:default="1"':''}><w:name w:val="${name}"/>${based?`<w:basedOn w:val="${based}"/>`:''}<w:pPr>${pp}</w:pPr><w:rPr><w:color w:val="000000"/>${rp}</w:rPr></w:style>`).join('')}</w:styles>`;
export function wordReport(lines,{title='Отчёт по проверке документа',metadata=[],skip=0}={}){
 const headings=new Map([['ОГРАНИЧЕНИЯ','Ограничения проверки'],['ОХВАТ ФАКТОРОВ','Охват факторов'],['Снимок источников запуска','Нормативные источники запуска']]);
 let content=p(title,'Title')+p('Информационная система КружИИво','Caption')+(metadata.length?table(metadata)+p('','Caption'):'');
 let finding=0;
 for(const line of lines.slice(skip).filter(Boolean).flatMap(s=>String(s).split(/\r?\n/))){let style='Normal',text=line;
  if(headings.has(line)){text=headings.get(line);style='Heading1';}
  else if(/^(ПОДТВЕРЖДЁННЫЕ|ИЗМЕНЁННЫЕ|ОТКЛОНЁННЫЕ|НЕ РАССМОТРЕННЫЕ) \/ /.test(line)){text=line.replace('ПОДТВЕРЖДЁННЫЕ','Подтверждённые замечания').replace('ИЗМЕНЁННЫЕ','Изменённые замечания').replace('ОТКЛОНЁННЫЕ','Отклонённые замечания').replace('НЕ РАССМОТРЕННЫЕ','Не рассмотренные замечания');style='Heading1';}
  else if(/^Замечание \d+/.test(line)){style='Heading2';}
  else if(/^[A-Za-zА-Яа-я0-9_-]+ · п\. /.test(line)){text='Замечание '+(++finding)+' · '+line;style='Heading2';}
  else if(line.startsWith('Цитата:'))style='Quote';
  content+=p(text,style);
 }
 const document=`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${content}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1273" w:bottom="1134" w:left="1273" w:footer="500"/></w:sectPr></w:body></w:document>`;
 return {
 '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/document.xml':document,'word/styles.xml':styles,
 'word/_rels/document.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
 'word/footer1.xml':'<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="right"/></w:pPr><w:r><w:t>Предварительный отчёт системы. Не является заключением антикоррупционной экспертизы · </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>'
 };
}
