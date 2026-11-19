import { createHash } from 'node:crypto';

const branch = 'review-history';
const endpoint = 'https://api.github.com/repos/mrasos675-oss/kruzhivo/contents/';
const prefix = 'history-outbox/';

export function createGithubHistory(token, storage, request = fetch) {
  if (!token || !storage?.list) return null;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function deliver(event) {
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    const url = endpoint + event.path;
    for (const delay of [0, 500, 1500]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const response = await request(url, {
          method: 'PUT', headers, signal: AbortSignal.timeout(6000),
          body: JSON.stringify({ branch, message: 'Запись проверки: ' + event.type, content: bytes.toString('base64') }),
        });
        if (response.status === 201) return true;
        if (![409, 422, 429, 500, 502, 503, 504].includes(response.status)) return false;
        if (response.status === 409 || response.status === 422) {
          const existing = await request(url + '?ref=' + branch, { headers, signal: AbortSignal.timeout(6000) });
          if (existing.ok && (await existing.json()).sha === sha) return true;
        }
      } catch {
        // Keep the event in the outbox for a later delivery attempt.
      }
    }
    return false;
  }

  return {
    async record(runId, type, data, conclusionNumber) {
      if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid history run identifier');
      const filename = {
        submitted: '01-submission', result: '02-result',
        conclusion: '03-conclusion-' + Number(conclusionNumber),
      }[type];
      if (!filename) throw new Error('Unknown history event');
      const path = 'reviews/' + runId + '/' + filename + '.json';
      const event = { path, type, runId, data };
      const key = prefix + runId + '/' + filename + '.json';
      try { await storage.put(key, JSON.stringify(event)); }
      catch (error) { if (error.name !== 'BlobAlreadyExistsError') throw error; }
    },
    async flush(runId) {
      for (const key of await storage.list(prefix + runId + '/')) {
        const item = await storage.get(key);
        if (!item) continue;
        const event = await new Response(item.stream).json();
        if (!await deliver(event)) {
          console.error('kruzhivo: GitHub history delivery deferred');
          return;
        }
        await storage.del(key);
      }
    },
  };
}
