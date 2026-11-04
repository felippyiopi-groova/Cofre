// Cálculos: arredondamento, leitura de valores, saldos, moedas e contas a pagar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const C = carregar('Core'), R = carregar('Reports');
// Valores vindos do módulo isolado (vm) são normalizados antes de comparar estruturas.
const js = v => JSON.parse(JSON.stringify(v));

test('round2 arredonda centavos corretamente (inclusive negativos)', () => {
  assert.equal(C.round2(10.075), 10.08);
  assert.equal(C.round2(1.255), 1.26);
  assert.equal(C.round2(-1.005), -1.01);
  assert.equal(C.round2(-2.345), -2.35);
  assert.equal(C.round2(0.1 + 0.2), 0.3);
  assert.equal(C.round2(1e-7), 0);
  for (let i = 0; i < 20000; i++) { const v = Math.round((Math.random() - 0.5) * 2e8) / 100; assert.equal(C.round2(v), v); }
});

test('num lê valores escritos em português', () => {
  assert.equal(C.num('1.234,56'), 1234.56);
  assert.equal(C.num('R$ 1.234.567'), 1234567);
  assert.equal(C.num('1.234.567,8'), 1234567.8);
  assert.equal(C.num('12.5'), 12.5);
  assert.ok(isNaN(C.num('abc')));
});

const base = () => ({
  snapshot_date: '2026-10-31', currency_default: 'BRL',
  accounts: [{ id: 'nu', name: 'Nubank', currency: 'BRL', snapshot_balance: 1000 }, { id: 'wise', name: 'Wise', currency: 'EUR', snapshot_balance: 100 }],
  credit_facilities: [{ id: 'cart', name: 'Cartão', limit_total_brl: 1000, available_estimated_brl: 800 }],
  transactions: [
    { id: 't1', date: '2026-11-02', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 50, currency: 'BRL', category: 'Casa' },
    { id: 't2', date: '2026-11-03', type: 'despesa', status: 'cancelado', account_id: 'nu', amount: 300, currency: 'BRL' },
    { id: 't3', date: '2026-11-05', type: 'despesa', status: 'planejado', account_id: 'nu', amount: 20, currency: 'BRL' },
    { id: 't4', date: '2026-11-04', type: 'transferencia', status: 'confirmado', account_id: 'nu', to_account_id: 'wise', amount: 600, amount_to: 100, currency: 'BRL' },
    { id: 't5', date: '2026-11-04', type: 'despesa', status: 'confirmado', account_id: 'wise', amount: 30, currency: 'EUR', category: 'Viagem' },
    { id: 't6', date: '2026-11-06', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 'abc', currency: 'BRL' }
  ],
  obligations: [
    { id: 'o1', description: 'Empréstimo', status: 'pendente', due_date: '2026-11-20', amount_brl: 1000, amount_remaining_brl: 400 },
    { id: 'o2', description: 'Aluguel', status: 'pendente', due_date: '2026-11-25', amount: 500, currency: 'EUR' },
    { id: 'o3', description: 'Luz', status: 'pendente', due_date: '2026-11-10', amount: 150, currency: 'BRL' }
  ]
});

test('saldo e previsto ignoram cancelados', () => {
  const nu = C.computeBalances(base()).find(b => b.id === 'nu');
  assert.equal(nu.balance, 350);
  assert.equal(nu.forecastMovements, -20);
});

test('extrato por conta usa a moeda da conta e ignora valor ilegível', () => {
  const ds = base();
  const w = R.statement(ds, { account: 'wise', start: '2026-11-01', end: '2026-11-30' });
  assert.equal(w.totals.confirmed.EUR.in, 100);
  assert.equal(w.totals.confirmed.BRL, undefined);
  const all = R.statement(ds, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(all.totals.confirmed.BRL.out, 50);
});

test('sem cotação: outra moeda fica fora dos totais e é listada', () => {
  const s = C.summarize(base(), '2026-11-04');
  assert.equal(s.totalMain, 350);
  assert.deepEqual(js(s.missingRates), ['EUR']);
  assert.equal(s.openPending, 550); // 400 restante + 150; aluguel em € fora
  assert.deepEqual(js(s.openNoRate.map(o => o.id)), ['o2']);
  assert.equal(C.monthlyExpenses(base()).find(m => m.month === '2026-11').confirmed, 50);
});

test('com cotação: tudo convertido para a moeda principal', () => {
  const ds = base(); ds.transactions.pop();
  ds.settings = { main_currency: 'BRL', exchange_rates: { EUR: { rate: 6 } } };
  const s = C.summarize(ds, '2026-11-04');
  assert.equal(s.totalMain, 1370); // 350 + 170 € × 6
  assert.equal(s.openPending, 3550); // 400 + 150 + 500 € × 6
  assert.equal(C.monthlyExpenses(ds).find(m => m.month === '2026-11').confirmed, 230);
  ds.settings = { main_currency: 'EUR', exchange_rates: { BRL: { rate: 0.16 } } };
  assert.equal(C.summarize(ds, '2026-11-04').totalMain, 226);
  assert.equal(C.rateOf({ settings: { exchange_rates: { USD: { rate: 0 } } } }, 'USD'), null);
});

test('cotação automática: converte sozinha; fixada pela pessoa tem prioridade', () => {
  const ds = base(); ds.transactions.pop();
  try {
    C.setAutoRates('BRL', '2026-11-04', { eur: 0.16221458, usd: 0.18218894 }); // tabela real de 04/11/2026
    const info = C.rateInfo(ds, 'EUR');
    assert.equal(info.source, 'automatica');
    assert.equal(C.round2(info.rate), 6.16);
    assert.equal(C.summarize(ds, '2026-11-04').missingRates.length, 0);   // nada falta: veio da tabela
    assert.equal(C.summarize(ds, '2026-11-04').totalMain, C.round2(350 + 170 / 0.16221458));
    ds.settings = { exchange_rates: { EUR: { rate: 6, fixed: true } } };     // fixada vence a automática
    assert.equal(C.rateInfo(ds, 'EUR').source, 'fixada');
    assert.equal(C.summarize(ds, '2026-11-04').totalMain, 1370);
    ds.settings = { exchange_rates: { EUR: { rate: 6 } } };                  // digitada antiga: automática vence
    assert.equal(C.rateInfo(ds, 'EUR').source, 'automatica');
    ds.settings = { main_currency: 'USD' };                                  // tabela é de BRL: não serve para USD
    assert.equal(C.rateInfo(ds, 'EUR').rate, null);
  } finally { C.setAutoRates(null, null, {}); }
});
