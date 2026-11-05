// Extrai um módulo de dentro do index.html para testar no Node, sem navegador.
// Cada módulo do app tem a forma: (function (root) { ... root.<Nome> = api; })(...);
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cache = {};

export function carregar(nome) {
  if (cache[nome]) return cache[nome];
  const fim = HTML.indexOf(`root.${nome} = api;`);
  if (fim < 0) throw new Error(`Módulo ${nome} não encontrado no index.html`);
  const ini = HTML.lastIndexOf('\n(function (root) {', fim);
  const fecha = HTML.indexOf('\n})(', fim);
  const fimLinha = HTML.indexOf('\n', fecha + 1);
  const codigo = HTML.slice(ini, fimLinha);
  const modulo = { exports: {} };
  const deps = { './core.js': () => carregar('Core'), './reports.js': () => carregar('Reports'), './classify.js': () => carregar('Classify') };
  const ctx = vm.createContext({
    module: modulo, exports: modulo.exports, self: undefined,
    require: p => { if (!deps[p]) throw new Error('dependência desconhecida: ' + p); return deps[p](); },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, console, Intl, Date, Math, JSON,
    DecompressionStream: globalThis.DecompressionStream
  });
  vm.runInContext(codigo, ctx, { filename: `index.html#${nome}` });
  return (cache[nome] = modulo.exports);
}
