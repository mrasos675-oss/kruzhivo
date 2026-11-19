import { brotliCompressSync, constants } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

function uintBase128(value) {
  const bytes = [value & 127];
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
  return Buffer.from(bytes);
}

export async function writeWebFont(fontDirectory) {
  const font = await readFile(new URL('InterTight.ttf', fontDirectory));
  const directory = [];
  const tables = [];
  let sfntSize = 12;
  const tableCount = font.readUInt16BE(4);
  for (let index = 0; index < tableCount; index++) {
    const record = 12 + 16 * index;
    const tag = font.subarray(record, record + 4);
    const name = tag.toString('ascii');
    // Repack the original tables without transforming outlines or metrics.
    // WOFF2 omits DSIG and requires bit 11 of head.flags to be set.
    if (name === 'DSIG') continue;
    const offset = font.readUInt32BE(record + 8);
    const size = font.readUInt32BE(record + 12);
    const table = Buffer.from(font.subarray(offset, offset + size));
    if (name === 'head') table.writeUInt16BE(table.readUInt16BE(16) | (1 << 11), 16);
    const flags = name === 'glyf' || name === 'loca' ? 0xff : 0x3f;
    directory.push(Buffer.from([flags]), tag, uintBase128(size));
    tables.push(table);
    sfntSize += 16 + 4 * Math.ceil(size / 4);
  }

  const compressed = brotliCompressSync(Buffer.concat(tables), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT
    }
  });
  const tableDirectory = Buffer.concat(directory);
  const header = Buffer.alloc(48);
  header.write('wOF2');
  header.writeUInt32BE(font.readUInt32BE(0), 4);
  header.writeUInt32BE(header.length + tableDirectory.length + compressed.length, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(sfntSize, 16);
  header.writeUInt32BE(compressed.length, 20);
  header.writeUInt16BE(1, 24);
  await writeFile(new URL('InterTight.v1.woff2', fontDirectory), Buffer.concat([header, tableDirectory, compressed]));
}
