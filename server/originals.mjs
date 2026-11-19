import { mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { extractDocx, fail } from './files.mjs';

export async function createOriginals(dataDir) {
  const dir = join(dataDir, 'originals');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const pending = new Map();
  return {
    prepare(fileName, base64) {
      for (const [key, entry] of pending) if (Date.now() - entry.at > 30 * 60 * 1000) pending.delete(key);
      if (pending.size >= 20) throw fail('Слишком много подготовленных файлов. Повторите через 30 минут.', 429);
      if (typeof fileName !== 'string' || fileName.length > 250 || !fileName.toLowerCase().endsWith('.docx')) throw fail('Добавьте DOCX или вставьте текст. PDF и сканы пока не поддерживаются.');
      if (typeof base64 !== 'string' || base64.length > 4194304 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('Некорректный или слишком большой файл.');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > 3 * 1024 * 1024) throw fail('Максимальный размер DOCX — 3 МБ.', 413);
      const text = extractDocx(bytes), uploadId = randomUUID();
      pending.set(uploadId, { bytes, text, fileName, at: Date.now() });
      return { text, uploadId, fileName, size: bytes.length };
    },
    async attach(uploadId, version) {
      if (!uploadId) return;
      const entry = pending.get(uploadId);
      if (!entry || Date.now() - entry.at > 30 * 60 * 1000) throw fail('Подготовленный файл устарел. Загрузите его ещё раз.', 409);
      if (entry.text !== version.text) throw fail('Текст DOCX отличается от подготовленного. Загрузите файл ещё раз или выберите вставку текста.', 400);
      pending.delete(uploadId);
      const fileId = randomUUID();
      await writeFile(join(dir, `${fileId}.docx`), entry.bytes, { mode: 0o600, flag: 'wx' });
      version.original = { fileId, fileName: entry.fileName, size: entry.bytes.length, sha256: createHash('sha256').update(entry.bytes).digest('hex') };
      version.fileName = entry.fileName;
    },
    async discard(version) { if (version.original) await rm(join(dir, `${version.original.fileId}.docx`), { force: true }); },
    async read(version) {
      if (!version.original || !/^[0-9a-f-]{36}$/.test(version.original.fileId)) throw fail('Для этой версии оригинальный DOCX не сохранён. Можно скачать текст.', 404);
      const bytes = await readFile(join(dir, `${version.original.fileId}.docx`));
      if (createHash('sha256').update(bytes).digest('hex') !== version.original.sha256) throw fail('Оригинал не прошёл проверку целостности.', 500);
      return bytes;
    },
  };
}
