import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

function conflict(name) {
  return Object.assign(new Error(name), { name });
}

export function createPostgresStorage(url) {
  const sql = neon(url);
  let initialized;
  function ready() {
    initialized ??= sql.transaction([
      sql`SELECT pg_advisory_xact_lock(49202513)`,
      sql`CREATE TABLE IF NOT EXISTS kruzhivo_objects (
        path text PRIMARY KEY,
        body bytea NOT NULL,
        etag uuid NOT NULL,
        expires_at timestamptz
      )`,
    ]).catch(error => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  }
  return {
    async get(path) {
      await ready();
      const [entry] = await sql`SELECT encode(body, 'base64') AS body FROM kruzhivo_objects
        WHERE path = ${path} AND (expires_at IS NULL OR expires_at > now())`;
      if (!entry) return null;
      return { statusCode: 200, stream: new Response(Buffer.from(entry.body,'base64')).body };
    },
    async head(path) {
      await ready();
      const [entry] = await sql`SELECT etag FROM kruzhivo_objects
        WHERE path = ${path} AND (expires_at IS NULL OR expires_at > now())`;
      if (!entry) throw conflict('BlobNotFoundError');
      return entry;
    },
    async put(path, bytes, { ttlDays, ifMatch, allowOverwrite = false } = {}) {
      await ready();
      const etag = randomUUID(), body = Buffer.from(bytes).toString('base64');
      const expires = ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null;
      const rows = ifMatch
        ? await sql`UPDATE kruzhivo_objects SET body = decode(${body}, 'base64'), etag = ${etag}, expires_at = ${expires}
            WHERE path = ${path} AND etag = ${ifMatch} AND (expires_at IS NULL OR expires_at > now()) RETURNING etag`
        : await sql`INSERT INTO kruzhivo_objects (path, body, etag, expires_at)
            VALUES (${path}, decode(${body}, 'base64'), ${etag}, ${expires})
            ON CONFLICT (path) DO UPDATE SET body = excluded.body, etag = excluded.etag, expires_at = excluded.expires_at
            WHERE ${allowOverwrite}::boolean OR kruzhivo_objects.expires_at <= now() RETURNING etag`;
      if (!rows.length) throw conflict(ifMatch ? 'BlobPreconditionFailedError' : 'BlobAlreadyExistsError');
      return { etag };
    },
    async list(prefix) {
      await ready();
      const rows = await sql`SELECT path FROM kruzhivo_objects WHERE starts_with(path, ${prefix})
        AND (expires_at IS NULL OR expires_at > now()) ORDER BY path`;
      return rows.map(row => row.path);
    },
    async del(path) {
      await ready();
      await sql`DELETE FROM kruzhivo_objects WHERE path = ${path}`;
    },
  };
}
