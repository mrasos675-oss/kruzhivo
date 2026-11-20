import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderLanding } from '../scripts/render-landing.mjs';

const template = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('the public landing renders content and usable links without loading the workspace', () => {
  const html = renderLanding(template);
  assert.match(html, /<main id="main-content"[^>]*>.*?<h1>[\s\S]*?КружИИво/s);
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /register|Зарегистриру/);
  assert.match(html, /href="\/#features"/);
  assert.match(html, /id="features"/);
  assert.match(html, /src="\/landing-start\.js"/);
  assert.doesNotMatch(html, /src="\/app\.js"|loading-skeleton/);
});

test('registration is unavailable through old direct links and absent from login', async () => {
 const {registrationPage} = await import('../public/landing.js');
 const {loginForm} = await import('../public/login.js');
 assert.doesNotMatch(registrationPage(), /<form|register-form/);
 assert.match(registrationPage(), /Регистрация недоступна/);
 assert.doesNotMatch(loginForm(), /register|Зарегистриру/);
});
