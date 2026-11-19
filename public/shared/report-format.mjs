
export const REPORT_LABELS={pending:'Не рассмотрено',confirmed:'Подтверждено',modified:'Изменено',rejected:'Отклонено',finding:'Есть находка',limited:'Ограничено',none:'Находка не предложена',supported:'Выдержало перепроверку',contested:'Оспорено',insufficient:'Недостаточно данных',context:'Другие пункты',exception:'Исключения',applicability:'Применимость',freshness:'Актуальность',prepared:'Подготовлено',skipped:'Не выполнялось',preserved:'Смысл сохранён',changed:'Смысл изменён',uncertain:'Сохранение смысла не подтверждено',running:'Выполняется',completed:'Завершено',failed:'Прервано с ошибкой',cancelled:'Остановлено',queued:'Ожидание',not_started:'Не выполнялось',rights:'Права',obligations:'Обязанности',deadlines:'Сроки',conditions:'Условия',exceptions:'Исключения',competence:'Компетенция'};
export const ruStatus=value=>REPORT_LABELS[value]||String(value??'Не указано');
export function moscowTime(value){const d=new Date(value);return Number.isNaN(d.getTime())?'Не записано':new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'medium'}).format(d)+' (МСК)';}
export function methodReference(factorId,catalog){const f=catalog?.factors?.find(f=>f.id===factorId);const m=f?.locator?.match(/^([34])\s+([а-я])$/i);return m?'пп. «'+m[2]+'» п. '+m[1]+' Методики (ПП РФ от 26.02.2010 № 96)':'Классификация требует проверки';}
export const findingNumber=(run,finding)=>run.findings.findIndex(f=>f.id===finding.id)+1;
export const missingBasisCount=run=>run.findings.filter(f=>f.decision?.status!=='rejected'&&!f.decision?.basis?.trim()&&!f.basis?.length).length;
export const nextPendingIndex=(run,current=-1)=>{for(let n=1;n<=run.findings.length;n++){const i=(current+n)%run.findings.length;if(run.findings[i].decision.status==='pending')return i;}return -1;};
export function findingLimitation(finding){return [...new Set([...(finding.review?.doubts||[]),...(finding.basis?.length?[]:['Проверенное нормативное основание не приложено. Ссылка на фактор Методики является классификацией, а не доказательством нарушения.'])])].join(' ')||'Вывод предварительный. Проверить применимость норм, исключения и связанные положения документа.';}

const documentAssessmentLabels = {
  confirmed: 'Подтверждается текстом',
  partial: 'Подтверждается частично',
  refuted: 'Опровергается текстом',
  unclear: 'По тексту недостаточно данных'
};

export function documentAssessmentLabel(finding) {
  return documentAssessmentLabels[finding.review?.documentAssessment?.status] || '';
}

export function findingReviewSummary(finding) {
  const label = documentAssessmentLabel(finding);
  return [
    ...(label ? [[label, finding.review.documentAssessment.summary]] : []),
    ...(finding.review ? [[label ? 'Правовая оценка' : 'Итог перепроверки', ruStatus(finding.review.verdict)]] : []),
    ...(finding.editor?.nextStep ? [['Что сделать дальше', finding.editor.nextStep]] : [])
  ];
}
