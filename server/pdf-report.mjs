import { CATALOG } from './catalog.mjs';
import { layoutReportPdf } from './pdf-report-layout.mjs';

export function reportPdf(doc, version, run, profile = {}) {
  return layoutReportPdf(doc, version, run, profile, run.aiPolicy?.catalog || CATALOG);
}
