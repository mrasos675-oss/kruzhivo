import { reportContent } from './report-content.mjs';
import { wordReport } from './word-layout.mjs';
import { inflateRawSync } from 'node:zlib';

export function fail(message, status = 422) { return Object.assign(new Error(message), { status }); }
export const xmlEscape = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  if (e[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()];
  const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});

export function unzipEntry(buffer, name, max = 8 * 1024 * 1024) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw fail('Файл не является DOCX. Добавьте DOCX или вставьте текст.');
  let eocd = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { eocd = p; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw fail('Неподдерживаемая структура DOCX.');
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries > 10000) throw fail('Слишком сложный DOCX. Вставьте текст вручную.');
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw fail('Повреждённый DOCX.');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 24), packed = buffer.readUInt32LE(p + 20), offset = buffer.readUInt32LE(p + 42);
    const n = buffer.readUInt16LE(p + 28), x = buffer.readUInt16LE(p + 30), c = buffer.readUInt16LE(p + 32);
    const entry = buffer.subarray(p + 46, p + 46 + n).toString('utf8'); p += 46 + n + x + c;
    if (entry !== name) continue;
    if (flags & 1 || size > max || packed > buffer.length || offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw fail('Защищённый или слишком большой DOCX.');
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (start + packed > buffer.length) throw fail('Повреждённый DOCX.');
    const raw = buffer.subarray(start, start + packed);
    let data;
    try { data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: max }) : null; } catch { throw fail('Не удалось распаковать DOCX в допустимом объёме.'); }
    if (!data || data.length !== size || data.length > max) throw fail('Неподдерживаемое сжатие DOCX.');
    return data;
  }
  throw fail('В DOCX не найден основной текст. Вставьте текст вручную.');
}

export function extractDocx(buffer) {
  const xml = unzipEntry(buffer, 'word/document.xml').toString('utf8');
  if (/<!DOCTYPE|<!ENTITY|<w:altChunk\b/i.test(xml)) throw fail('Этот DOCX содержит неподдерживаемые внешние фрагменты. Вставьте текст вручную.');
  const text = decode(xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw fail('В документе нет текста. PDF и сканы не поддерживаются.');
  if (text.length > 80000) throw fail('Лимит демки — 80 000 символов. Документ не обрезан: выберите меньший файл.');
  return text;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(b) { let c = 0xffffffff; for (const n of b) c = crcTable[(c ^ n) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }

export function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(value), crc = crc32(data);
    const a = Buffer.alloc(30); a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt16LE(0x800, 6); a.writeUInt32LE(crc, 14); a.writeUInt32LE(data.length, 18); a.writeUInt32LE(data.length, 22); a.writeUInt16LE(name.length, 26);
    local.push(a, name, data);
    const b = Buffer.alloc(46); b.writeUInt32LE(0x02014b50); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6); b.writeUInt16LE(0x800, 8); b.writeUInt32LE(crc, 16); b.writeUInt32LE(data.length, 20); b.writeUInt32LE(data.length, 24); b.writeUInt16LE(name.length, 28); b.writeUInt32LE(offset, 42);
    central.push(b, name); offset += a.length + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(size, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, e]);
}

export function reportDocx(doc, version, run, profile = {}) {const data=reportContent(doc,version,run,profile);return zipFiles(wordReport(data.lines,data));}
