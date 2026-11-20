import { createHash } from 'node:crypto';

// A short identity suffix keeps truncated or equally named documents distinct.
export function reportFilename(d, v, r, extension) {
  if (!['pdf', 'docx'].includes(extension)) throw new Error('Unsupported report format');
  const clean = value => String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  const title = Array.from(clean(d.name) || clean(d.id) || 'НПА').slice(0, 55).join('');
  const identity = createHash('sha256').update(String(d.id || d.name || 'НПА')).digest('hex').slice(0, 10);
  const timestamp = new Date(r.createdAt);
  const date = Number.isNaN(timestamp.getTime()) ? 'без-даты' : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
  const number = value => /^\d{1,9}$/.test(String(value)) ? String(value) : '0';
  return `Отчёт_${title}_${identity}_v${number(v.number)}_проверка${number(r.number)}_${date}.${extension}`;
}

export function reportDisposition(d, v, r, extension) {
  const name = reportFilename(d, v, r, extension);
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="report.${extension}"; filename*=UTF-8''${encoded}`;
}
