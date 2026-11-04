// Recalcula a "impressão digital" (hash) do script na regra de segurança (CSP) do index.html
// e a versão do service worker. Rode depois de QUALQUER mudança no index.html:
//   node scripts/atualizar-hash.mjs          (atualiza)
//   node scripts/atualizar-hash.mjs --check  (só confere; falha se estiver desatualizado)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raiz = new URL('../', import.meta.url);
const htmlPath = new URL('index.html', raiz), swPath = new URL('sw.js', raiz);
const check = process.argv.includes('--check');

let html = readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) throw new Error(`Esperava 1 script embutido, achei ${scripts.length}.`);
const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
const novoHtml = html.replace(/'sha256-[A-Za-z0-9+/=]+'/, `'sha256-${hash}'`);
const versao = 'cofre-' + createHash('sha256').update(novoHtml, 'utf8').digest('hex').slice(0, 10);
const sw = readFileSync(swPath, 'utf8');
const novoSw = sw.replace(/cofre-[0-9a-f]{10}/, versao);

if (check) {
  if (novoHtml !== html || novoSw !== sw) { console.error('Hash da CSP ou versão do service worker desatualizados. Rode: node scripts/atualizar-hash.mjs'); process.exit(1); }
  console.log('Hash e versão em dia.');
} else {
  writeFileSync(htmlPath, novoHtml); writeFileSync(swPath, novoSw);
  console.log(`CSP sha256-${hash}\nService worker ${versao}`);
}
