// The dashboard describes the newest document version, never an older rerun.
export function currentRun(document) {
  const version = document.versions.at(-1);
  return version && document.runs.findLast(run => run.versionId === version.id);
}

export function isArchived(document, run) {
  return currentRun(document)?.id !== run.id;
}

export function findingTitle(finding, catalog) {
  if (finding.title) return finding.title;
  const samples = [
    ['Сотрудник вправе запросить иные документы по своему усмотрению.', 'Неопределённый перечень документов'],
    ['Решение принимается в разумный срок после поступления документов.', 'Неопределённый срок решения'],
    ['В предоставлении услуги может быть отказано при наличии иных обстоятельств.', 'Неоднозначное условие отказа'],
  ];
  return samples.find(([quote]) => finding.quote?.includes(quote))?.[1] || catalog.factors.find(f => f.id === finding.factorId)?.title || 'Замечание к документу';
}

export function quoteContext(text, quote, point = '') {
  const pointStart = point ? text.indexOf(`${point}.`) : -1;
  let index = pointStart >= 0 ? text.indexOf(quote, pointStart) : -1;
  if (index < 0) index = text.indexOf(quote);
  if (index < 0) return { before: '', selected: quote, after: '' };
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index + quote.length);
  if (lineEnd < 0) lineEnd = text.length;
  return {
    before: text.slice(0, lineStart).trim().split('\n').filter(Boolean).at(-1) || '',
    selected: text.slice(lineStart, lineEnd),
    after: text.slice(lineEnd).trim().split('\n').filter(Boolean)[0] || '',
  };
}

export function pendingCurrent(documents) {
  return documents.reduce((count, document) => {
    const run = currentRun(document);
    return count + (run?.status === 'completed'
      ? run.findings.filter(finding => finding.decision.status === 'pending').length
      : 0);
  }, 0);
}

export function hasSavedDecision(finding) {
  return finding.decision.revision > 0 || !!finding.decision.savedAt;
}

// An explicitly saved empty value is a decision, not a missing AI suggestion.
export function proposalForDecision(finding) {
  return hasSavedDecision(finding)
    ? finding.decision.proposal ?? ''
    : finding.editor?.proposal ?? '';
}
