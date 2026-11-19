import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { renderLanding } from './render-landing.mjs';
import { writeWebFont } from './web-font.mjs';

const publicDir = new URL('../public/', import.meta.url);
const outputDir = new URL('../dist/', import.meta.url);
const template = await readFile(new URL('index.html', publicDir), 'utf8');
await rm(outputDir, { recursive: true, force: true });
await cp(publicDir, outputDir, { recursive: true });
await writeWebFont(new URL('fonts/', outputDir));
const layers = ['style.css', 'portal.css', 'reference.css', 'report.css'];
const css = (await Promise.all(layers.map(file => readFile(new URL(file, publicDir), 'utf8')))).join('\n');
const hash = createHash('sha256').update(css).digest('hex').slice(0, 16);
const stylesheet = '/_assets/portal.' + hash + '.css';
await mkdir(new URL('_assets/', outputDir), { recursive: true });
await writeFile(new URL(stylesheet.slice(1), outputDir), css);
const shell = template
  .replace(/<link rel="stylesheet" href="\/(?:style|portal|reference|report)\.css(?:\?[^"]*)?">/g, '')
  .replace('</head>', '<link rel="stylesheet" href="' + stylesheet + '"></head>');
await Promise.all([
  writeFile(new URL('index.html', outputDir), renderLanding(shell)),
  writeFile(new URL('app-shell.html', outputDir), shell)
]);
