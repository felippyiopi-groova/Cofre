// Semáforo de liquidez automático: a cor sai só dos dados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const C = carregar('Core');
const HOJE = '2026-11-05';
// Uma conta com saldo X, gastos de R$ 1.000/mês nos 3 meses anteriores, contas a pagar e receitas previstas.
function dados({ saldo, pagar = [], previstas = [], regras, gastos = 1000 }) {
  const tx = ['2026-08-10', '2026-09-10', '2026-10-10'].map((d, i) => ({ id: 'g' + i, type: 'despesa', status: 'confirmado', amount: gastos, date: d, account_id: 'res', category: 'Casa' }));
  return {
    schema_version: '1.0', currency_default: 'BRL', settings: regras ? { traffic_light_rules: regras } : {},
    accounts: [{ id: 'cc', name: 'Conta', currency: 'BRL', snapshot_balance: saldo, snapshot_date: '2026-11-01', status: 'operacional' },
      { id: 'res', name: 'Histórico', currency: 'BRL', snapshot_balance: 0, snapshot_date: '2026-11-01', status: 'reserva' }],
    transactions: tx,
    obligations: pagar.map(([v, d], i) => ({ id: 'o' + i, name: 'Conta ' + i, amount: v, due_date: d, status: 'pendente' })),
    income_forecasts: previstas.map(([v, d], i) => ({ id: 'r' + i, amount: v, date: d, status: 'previsto' }))
  };
}

test('VERDE: contas fecham e sobra pelo menos 1 mês de gasto', () => {
  const t = C.trafficLight(dados({ saldo: 3000, pagar: [[500, '2026-11-20']] }), HOJE);
  assert.equal(t.level, 'VERDE'); assert.equal(t.free, 3000); assert.equal(t.pay, 500); assert.equal(t.avgMonthly, 1000);
});
test('AMARELO: fecha, mas sobra menos de 1 mês de gasto', () => {
  assert.equal(C.trafficLight(dados({ saldo: 1200, pagar: [[500, '2026-11-20']] }), HOJE).level, 'AMARELO');
});
test('LARANJA: só fecha com a receita prevista', () => {
  const t = C.trafficLight(dados({ saldo: 400, pagar: [[500, '2026-11-20']], previstas: [[2000, '2026-11-15']] }), HOJE);
  assert.equal(t.level, 'LARANJA'); assert.equal(t.inc, 2000);
});
test('VERMELHO: nem com a receita prevista fecha; ou não cobre o que vence em 7 dias', () => {
  assert.equal(C.trafficLight(dados({ saldo: 100, pagar: [[500, '2026-11-20']], previstas: [[200, '2026-11-15']] }), HOJE).level, 'VERMELHO');
  assert.equal(C.trafficLight(dados({ saldo: 100, pagar: [[500, '2026-11-08']], previstas: [[2000, '2026-11-07']] }), HOJE).level, 'VERMELHO');
});
test('contas fora da janela, pagas ou previstas fora do período não contam', () => {
  const d = dados({ saldo: 3000, pagar: [[9000, '2027-01-20']], previstas: [[5000, '2026-12-20']] });
  d.obligations.push({ id: 'pg', amount: 9000, due_date: '2026-11-10', status: 'pago' });
  const t = C.trafficLight(d, HOJE); assert.equal(t.pay, 0); assert.equal(t.inc, 0); assert.equal(t.level, 'VERDE');
});
test('regras do ChatGPT em settings.traffic_light_rules mudam o critério', () => {
  const d = dados({ saldo: 3000, pagar: [[500, '2026-11-20']], regras: { meses_folga_verde: 3 } });
  assert.equal(C.trafficLight(d, HOJE).level, 'AMARELO');
  const longe = dados({ saldo: 3000, pagar: [[2900, '2026-12-20']], regras: { dias: 60 } });
  assert.equal(C.trafficLight(longe, HOJE).pay, 2900);
});
test('o campo traffic_light gravado é ignorado: ninguém escolhe a cor', () => {
  const d = dados({ saldo: 100, pagar: [[500, '2026-11-20']] }); d.traffic_light = { level: 'VERDE' };
  assert.equal(C.trafficLight(d, HOJE).level, 'VERMELHO');
});
test('exportação leva o semáforo calculado e a importação o ignora', async () => {
  const out = await C.buildExport(dados({ saldo: 3000 }), '2026-11-05T10:00:00Z', {});
  assert.equal(out.calculated_traffic_light.level, 'VERDE');
  assert.ok(C.META_KEYS.has('calculated_traffic_light'));
});
