import { installAccessibility } from './accessibility.js';

function openLegacyRoute() {
  const hash = location.hash;
  if (!hash || document.getElementById(hash.slice(1))) return;

  window.removeEventListener('hashchange', openLegacyRoute);
  import('./app.js').catch(() => {
    // Keep the public page usable and allow retrying with a fresh navigation.
    window.addEventListener('hashchange', openLegacyRoute);
  });
}

installAccessibility();
window.addEventListener('hashchange', openLegacyRoute);
openLegacyRoute();
