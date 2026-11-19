import { landingPage } from '../public/landing.js';
import { pathFor } from '../public/portal-router.js';

export function renderLanding(template) {
  // Static links must work before any JavaScript runs.
  const markup = landingPage()
    .replace(/<a\b[^>]*\bdata-register-role="expert"[^>]*>/g, link =>
      link.replace('href="#register"', 'href="/register?role=expert"'))
    .replace(/href="#([a-z-]+)"/g, (_, token) => 'href="' + pathFor(token) + '"');
  const placeholder = /<div id="app"><main\b[\s\S]*?<\/main><\/div>/;
  if (!placeholder.test(template) || !template.includes('src="/app.js"')) {
    throw new Error('The public landing template is missing its app entry point.');
  }
  return template
    .replace('src="/app.js"', 'src="/landing-start.js"')
    .replace(placeholder, () => '<div id="app">' + markup + '</div>');
}
