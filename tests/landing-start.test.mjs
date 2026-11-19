import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderLanding } from '../scripts/render-landing.mjs';

const template = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('the public landing renders content and usable links without loading the workspace', () => {
  const html = renderLanding(template);
  assert.match(html, /<main id="main-content"[^>]*>.*?<h1>[\s\S]*?КружИИво/s);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="\/register\?role=expert"[^>]*>Зарегистрироваться как эксперт/);
  assert.match(html, /href="\/#features"/);
  assert.match(html, /id="features"/);
  assert.match(html, /src="\/landing-start\.js"/);
  assert.doesNotMatch(html, /src="\/app\.js"|loading-skeleton/);
});
