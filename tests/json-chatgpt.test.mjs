// Leitura tolerante das respostas do ChatGPT: conserta só formatação, nunca valores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const C = carregar('Core');
const js = v => JSON.parse(JSON.stringify(v));
const obj = { snapshot_date: '2026-11-05', accounts: [{ id: 'itau', name: 'Itaú', snapshot_balance: 2500.5 }],
  transactions: [{ id: 't1', description: 'Uber “centro”', amount: 8, notes: 'pago // dividido, metade' }] };
const json = JSON.stringify(obj, null, 2);

test('JSON puro: lido direto, sem consertos', () => {
  const r = C.parseLenient(json);
  assert.deepEqual(js(r.data), obj); assert.equal(r.repairs.length, 0);
});
test('texto + bloco ```json: pega o bloco', () => {
  const r = C.parseLenient('Claro! Aqui está:\n\n```json\n' + json + '\n```\nQualquer dúvida, fale.');
  assert.deepEqual(js(r.data), obj);
});
test('texto antes e depois, sem bloco', () => {
  const r = C.parseLenient('Aqui está o arquivo atualizado:\n' + json + '\nSe quiser, explico.');
  assert.deepEqual(js(r.data), obj); assert.ok(r.repairs.some(x => /antes/.test(x)));
});
test('vírgulas sobrando antes de } e ]', () => {
  const r = C.parseLenient(json.replace('"amount": 8,', '"amount": 8,').replace(/("notes": "pago \/\/ dividido, metade")/, '$1,').replace(/\]\n\}$/, '],\n}'));
  assert.deepEqual(js(r.data), obj); assert.ok(r.repairs.some(x => /vírgula/.test(x)));
});
test('comentários // e /* */ fora dos textos; "//" dentro de texto é mantido', () => {
  const r = C.parseLenient(json.replace('"amount": 8,', '"amount": 8, // valor da corrida').replace('"accounts"', '/* contas */ "accounts"'));
  assert.deepEqual(js(r.data), obj);
  assert.equal(r.data.transactions[0].notes, 'pago // dividido, metade');
  assert.ok(r.repairs.some(x => /comentário/.test(x)));
});
test('aspas curvas usadas como aspas viram normais; dentro do texto continuam', () => {
  const r = C.parseLenient(json.replace('"name": "Itaú"', '“name”: “Itaú”'));
  assert.deepEqual(js(r.data), obj);
  assert.equal(r.data.transactions[0].description, 'Uber “centro”'); // conteúdo preservado
});
test('valores nunca mudam: números, textos e vírgulas dentro de textos', () => {
  const r = C.parseLenient('Veja:\n' + json.replace('"amount": 8,', '"amount": 8, // x'));
  assert.equal(r.data.accounts[0].snapshot_balance, 2500.5);
  assert.equal(r.data.transactions[0].notes, 'pago // dividido, metade');
});
test('resposta cortada no meio: recusada com explicação, nada inventado', () => {
  assert.throws(() => C.parseLenient(json.slice(0, json.length - 30)), e => e.kind === 'cortado' && /cortada/.test(e.message));
});
test('texto sem JSON: recusado', () => {
  assert.throws(() => C.parseLenient('Desculpe, não consegui gerar o arquivo.'), e => e.friendly && /Não encontrei/.test(e.message));
});

test('validação aceita qualquer moeda oficial e avisa só código inválido', () => {
  const ds = { accounts: [{ id: 'a', currency: 'USD' }, { id: 'b', currency: 'ars' }, { id: 'c', currency: 'DOLAR' }, { id: 'd', currency: 'XYZ' }] };
  const w = C.validate(C.prepare(ds).data).warnings.join(' | ');
  assert.ok(!/ a: | b: /.test(' ' + w.replace(/Conta /g, ' ')), w);
  assert.match(w, /Conta c: moeda DOLAR não reconhecida/);
  assert.match(w, /Conta d: moeda XYZ não reconhecida/);
});
