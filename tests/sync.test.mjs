// Lógica de sincronização entre dois aparelhos (sem rede): o que envia, aplica e quando há conflito.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const Y = carregar('Sync');
const js = v => JSON.parse(JSON.stringify(v));

// Servidor de mentira: guarda o último payload de cada chave, em ordem de revisão.
function servidor() {
  let rev = 0; const rows = new Map();
  return {
    async push(ups, dels) { for (const u of ups.concat(dels)) rows.set(u.payload.key, { rev: ++rev, payload: js(u.payload) }); },
    async pull(cursor) { return [...rows.values()].filter(r => r.rev > cursor).sort((a, b) => a.rev - b.rev); },
    get rev() { return rev; }, rows
  };
}
// Um aparelho: dados locais + base + cursor. sync() = baixar, juntar, enviar.
function aparelho(srv, ds) {
  const a = { ds: ds || {}, base: {}, cursor: 0, conflicts: [] };
  a.sync = async () => {
    const rows = await srv.pull(a.cursor);
    const remote = [];
    for (const r of rows) remote.push({ payload: r.payload, hash: r.payload.deleted ? undefined : await Y.hashOf(r.payload) });
    const m = await Y.merge(a.ds, a.base, remote);
    a.ds = m.ds; a.base = m.base; a.conflicts.push(...m.conflicts);
    if (rows.length) a.cursor = rows[rows.length - 1].rev;
    const p = await Y.plan(a.ds, a.base);
    await srv.push(p.ups, p.dels);
    for (const u of p.ups) a.base[u.payload.key] = u.hash;
    for (const d of p.dels) delete a.base[d.payload.key];
    a.cursor = srv.rev; // o que acabou de enviar não precisa voltar
    return m;
  };
  return a;
}
const dados = () => ({
  snapshot_date: '2026-11-01', settings: { main_currency: 'BRL' }, rules: ['não usar a reserva'],
  accounts: [{ id: 'nu', name: 'Nubank', snapshot_balance: 100 }],
  transactions: [{ id: 't1', amount: 10 }], obligations: []
});

test('divide em registros e reconstrói igual', async () => {
  const ds = dados(), recs = Y.split(ds);
  assert.ok(recs.has('transactions:t1') && recs.has('#obligations') && recs.has('@rules') && recs.has('@snapshot_date'));
  const novo = {}; for (const p of recs.values()) Y.apply(novo, p);
  assert.deepEqual(js(novo), ds);
});

test('celular → servidor → computador: tudo chega igual', async () => {
  const srv = servidor(), cel = aparelho(srv, dados()), pc = aparelho(srv, {});
  await cel.sync(); await pc.sync();
  assert.deepEqual(js(pc.ds), js(cel.ds));
});

test('alterações e exclusões nos dois sentidos', async () => {
  const srv = servidor(), cel = aparelho(srv, dados()), pc = aparelho(srv, {});
  await cel.sync(); await pc.sync();
  pc.ds.transactions.push({ id: 't2', amount: 25 });           // novo no PC
  pc.ds.accounts[0].snapshot_balance = 150;                    // alteração no PC
  await pc.sync(); await cel.sync();
  assert.equal(cel.ds.transactions.length, 2);
  assert.equal(cel.ds.accounts[0].snapshot_balance, 150);
  cel.ds.transactions = cel.ds.transactions.filter(t => t.id !== 't1'); // exclusão no celular
  delete cel.ds.rules;
  await cel.sync(); await pc.sync();
  assert.deepEqual(js(pc.ds.transactions.map(t => t.id)), ['t2']);
  assert.equal(pc.ds.rules, undefined);
  assert.deepEqual(js(pc.ds), js(cel.ds));
});

test('lançamentos diferentes ao mesmo tempo: os dois entram, sem conflito', async () => {
  const srv = servidor(), cel = aparelho(srv, dados()), pc = aparelho(srv, {});
  await cel.sync(); await pc.sync();
  cel.ds.transactions.push({ id: 'mercado', amount: 80 });
  pc.ds.transactions.push({ id: 'farmacia', amount: 30 });
  await cel.sync(); await pc.sync(); await cel.sync();
  assert.deepEqual(js(cel.ds.transactions.map(t => t.id).sort()), ['farmacia', 'mercado', 't1']);
  assert.deepEqual(js(pc.ds.transactions.map(t => t.id).sort()), ['farmacia', 'mercado', 't1']);
  assert.equal(cel.conflicts.length + pc.conflicts.length, 0);
});

test('o mesmo registro alterado nos dois: conflito registrado, nada some em silêncio', async () => {
  const srv = servidor(), cel = aparelho(srv, dados()), pc = aparelho(srv, {});
  await cel.sync(); await pc.sync();
  cel.ds.transactions[0].amount = 11;
  pc.ds.transactions[0].amount = 12;
  await cel.sync();          // celular envia 11
  await pc.sync();           // PC tinha 12: conflito; mantém 12 e envia
  assert.equal(pc.conflicts.length, 1);
  assert.equal(pc.conflicts[0].remote.item.amount, 11); // a versão do celular ficou guardada
  await cel.sync();
  assert.equal(cel.ds.transactions[0].amount, 12);       // os dois terminam iguais
  assert.equal(pc.ds.transactions[0].amount, 12);
});

test('nada mudou: nada é enviado', async () => {
  const srv = servidor(), cel = aparelho(srv, dados());
  await cel.sync(); const antes = srv.rev;
  await cel.sync();
  assert.equal(srv.rev, antes);
});

test('lista que fica vazia e volta a ter itens continua sendo lista', async () => {
  const srv = servidor(), cel = aparelho(srv, dados()), pc = aparelho(srv, {});
  await cel.sync(); await pc.sync();
  cel.ds.transactions = []; await cel.sync(); await pc.sync();
  assert.deepEqual(js(pc.ds.transactions), []);
  pc.ds.transactions.push({ id: 'x', amount: 1 }); await pc.sync(); await cel.sync();
  assert.deepEqual(js(cel.ds.transactions), [{ id: 'x', amount: 1 }]);
});
