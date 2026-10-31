// Monta a pasta www do app: a mesma tela do site (public/) + o local-api.js, que responde as rotas /api/
// no próprio celular. Rode com: node build.mjs (depois "npx cap sync android").
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const www = path.join(here, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(pub, www, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(here, 'src', 'local-api.js')],
  outfile: path.join(www, 'local-api.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

// O local-api.js entra ANTES do app.js (script comum roda antes dos módulos), para já estar respondendo.
const index = path.join(www, 'index.html');
const html = fs.readFileSync(index, 'utf8');
const tag = '<script type="module" src="/app.js"></script>';
if (!html.includes(tag)) throw new Error('Não achei o <script> do app.js no index.html');
fs.writeFileSync(index, html.replace(tag, `<script src="/local-api.js"></script>\n${tag}`));

const kb = (f) => Math.round(fs.statSync(path.join(www, f)).size / 1024);
console.log(`www pronta (local-api.js: ${kb('local-api.js')} KB)`);
