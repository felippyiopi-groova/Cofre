// Semáforo financeiro automático: fluxo de caixa dia a dia, sem ninguém escolher a cor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const C = carregar('Core');
const HOJE = '2026-11-05', AMANHA = '2026-11-06';
const js = v => JSON.parse(JSON.stringify(v));
// Conta do dia a dia com `saldo`, reserva com `reserva`, gasto de R$ 1.000/mês nos 3 meses anteriores.
function dados({ saldo, reserva = 1000, pagar = [], previstas = [], politica, gastos = 1000, extra = {} }) {
  const tx = ['2026-08-10', '2026-09-10', '2026-10-10'].map((d, i) => ({ id: 'g' + i, type: 'despesa', status: 'confirmado', amount: gastos, date: d, account_id: 'cc', category: 'Casa' }));
  return Object.assign({
    schema_version: '1.0', currency_default: 'BRL', settings: {},
    accounts: [{ id: 'cc', name: 'Conta', currency: 'BRL', snapshot_balance: saldo, snapshot_date: '2026-11-01', status: 'operacional' },
      { id: 'res', name: 'Reserva', currency: 'BRL', snapshot_balance: reserva, snapshot_date: '2026-11-01', status: 'reserva' }],
    transactions: tx,
    obligations: pagar.map(([v, d, o], i) => Object.assign({ id: 'o' + i, name: 'Conta ' + i, amount: v, due_date: d, status: 'pendente' }, o || {})),
    income_forecasts: previstas.map(([v, d, o], i) => Object.assign({ id: 'r' + i, name: 'Salário', amount: v, date: d, status: 'previsto' }, o || {})),
    traffic_light_policy: politica
  }, extra);
}

test('1) saldo positivo com conta maior vencendo amanhã: VERMELHO e diz quanto falta e quando entra o salário', () => {
  const t = C.trafficLight(dados({ saldo: 200, pagar: [[500, AMANHA]], previstas: [[3000, '2026-11-10']] }), HOJE);
  assert.equal(t.level, 'VERMELHO');
  const r = t.reasons.find(x => x.code === 'falta_caixa');
  assert.equal(r.missing, 300); assert.equal(r.available, 200); assert.equal(r.date, AMANHA);
  assert.deepEqual(js(r.next_income), { date: '2026-11-10', amount: 3000, name: 'Salário' });
  assert.notEqual(t.projected, 'VERMELHO'); // a projeção melhora, mas não esconde o risco atual
});

test('2) salário futuro não cobre conta vencida hoje', () => {
  const t = C.trafficLight(dados({ saldo: 100, pagar: [[500, '2026-11-01']], previstas: [[3000, AMANHA]] }), HOJE);
  assert.equal(t.level, 'VERMELHO');
  assert.ok(t.reasons.some(x => x.code === 'vencida_sem_dinheiro'));
});

test('3) pagamento confirmado remove a dívida da projeção', () => {
  const d = dados({ saldo: 3000, pagar: [[500, '2026-11-20', { status: 'pago' }]] });
  assert.equal(C.trafficLight(d, HOJE).due, 0);
});

test('4) transferência entre contas não vira receita', () => {
  const d = dados({ saldo: 3000 });
  d.transactions.push({ id: 'tf', type: 'transferencia', status: 'planejado', amount: 2000, date: '2026-11-12', account_id: 'cc', to_account_id: 'res' });
  assert.equal(C.trafficLight(d, HOJE).inc, 0);
});

test('5) reserva não é despesa e 6) limite de crédito não aumenta o dinheiro livre', () => {
  const d = dados({ saldo: 3000, reserva: 5000, extra: { credit_facilities: [{ id: 'cartao', name: 'Cartão', limit: 10000, available_limit: 10000 }] } });
  const t = C.trafficLight(d, HOJE);
  assert.equal(t.free, 3000); assert.equal(t.reserve, 5000); assert.equal(t.due, 0);
});

test('7) metas opcionais não são obrigações', () => {
  const d = dados({ saldo: 3000 }); d.accounts[1].goal_amount = 50000; d.accounts[1].goal_date = '2026-12-01';
  assert.equal(C.trafficLight(d, HOJE).due, 0);
});

test('8) simulação "e se eu guardar" não altera os dados e mostra a mudança de cor', () => {
  const d = dados({ saldo: 3000, pagar: [[500, '2026-11-20']] }), antes = JSON.stringify(d);
  const base = C.trafficLight(d, HOJE), sim = C.trafficLight(d, HOJE, { save: 2450 });
  assert.equal(JSON.stringify(d), antes);
  assert.equal(base.level, 'VERDE'); assert.equal(sim.level, 'AMARELO'); // sobra fica menor que a margem
  assert.equal(sim.free, 550); assert.equal(sim.reserve, 3450);
  assert.equal(base.canSave, 2400); // 3000 − 500 − margem de 10% de 1.000
});

test('10) verde exige dados suficientes', () => {
  const sem = dados({ saldo: 3000 }); sem.accounts[0].snapshot_balance = null;
  assert.equal(C.trafficLight(sem, HOJE).level, 'DADOS INSUFICIENTES');
  const semData = dados({ saldo: 3000, pagar: [[100, null]] });
  assert.equal(C.trafficLight(semData, HOJE).level, 'DADOS INSUFICIENTES');
  // risco continua aparecendo mesmo com dados incompletos
  const risco = dados({ saldo: 100, pagar: [[500, AMANHA], [10, null]] });
  assert.equal(C.trafficLight(risco, HOJE).level, 'VERMELHO');
});

test('AMARELO: reserva abaixo do mínimo, conta vencida coberta ou sobra pequena', () => {
  assert.equal(C.trafficLight(dados({ saldo: 3000, reserva: 200 }), HOJE).level, 'AMARELO');
  assert.equal(C.trafficLight(dados({ saldo: 3000, pagar: [[100, '2026-11-02']] }), HOJE).level, 'AMARELO');
  assert.equal(C.trafficLight(dados({ saldo: 550, pagar: [[500, '2026-11-20']] }), HOJE).level, 'AMARELO');
  assert.equal(C.trafficLight(dados({ saldo: 3000, pagar: [[500, '2026-11-20']] }), HOJE).level, 'VERDE');
});

test('regras em traffic_light_policy: horizonte, reserva mínima, margem e receitas incertas', () => {
  const longe = [[2900, '2026-12-20']];
  assert.equal(C.trafficLight(dados({ saldo: 3000, pagar: longe }), HOJE).due, 0);
  assert.equal(C.trafficLight(dados({ saldo: 3000, pagar: longe, politica: { horizon_days: 60 } }), HOJE).due, 2900);
  assert.equal(C.trafficLight(dados({ saldo: 3000, reserva: 1000, politica: { reserve_min: 5000 } }), HOJE).level, 'AMARELO');
  const inc = dados({ saldo: 100, pagar: [[500, '2026-11-20']], previstas: [[3000, '2026-11-10', { certain: false }]] });
  assert.equal(C.trafficLight(inc, HOJE).level, 'VERMELHO');
  inc.traffic_light_policy = { count_uncertain_income: true };
  assert.notEqual(C.trafficLight(inc, HOJE).level, 'VERMELHO');
  // valores inválidos são ignorados (nada do JSON é executado)
  const P = C.tlPolicy({ traffic_light_policy: { horizon_days: 45, safety_margin_pct: -3, reserve_min: 'abc', count_uncertain_income: 'sim' } });
  assert.equal(P.horizon_days, 30); assert.equal(P.safety_margin_pct, 10); assert.equal(P.reserve_min, null); assert.equal(P.count_uncertain_income, false);
});

test('conta não essencial vencida não deixa vermelho; o campo traffic_light gravado é ignorado', () => {
  const d = dados({ saldo: 100, pagar: [[50, '2026-11-01', { essential: false }]] }); d.traffic_light = { level: 'VERDE' };
  const t = C.trafficLight(d, HOJE);
  assert.notEqual(t.level, 'VERMELHO'); assert.notEqual(t.level, 'VERDE');
});

test('exportação leva o cálculo; a importação ignora o calculado e preserva as extensões do ChatGPT', async () => {
  const d = dados({ saldo: 200, pagar: [[500, AMANHA]] });
  Object.assign(d, { cofre_ai_financial_rules: { a: 1 }, ai_goal_templates: [{ id: 'g1', nome: 'Viagem' }], ai_interoperability: { b: 2 } });
  const out = await C.buildExport(d, '2026-11-05T10:00:00Z', {});
  assert.equal(out.calculated_traffic_light.current, 'VERMELHO');
  assert.ok(C.META_KEYS.has('calculated_traffic_light'));
  const p = C.prepare(js(out)); const data = p.data || p;
  assert.deepEqual(js(data.cofre_ai_financial_rules), { a: 1 }); assert.equal(data.ai_goal_templates.length, 1); assert.deepEqual(js(data.ai_interoperability), { b: 2 });
});
