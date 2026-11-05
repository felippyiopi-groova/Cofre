// "Pergunte ao Cofre": sugestões geradas dos dados, perguntas novas e soma de moedas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const C = carregar('Core'), Nlp = carregar('Nlp');
const HOJE = '2026-11-05';
const ds = () => ({
  snapshot_date: '2026-11-01', currency_default: 'BRL',
  settings: { main_currency: 'BRL', exchange_rates: { USD: { rate: 5.49, fixed: true }, EUR: { rate: 6, fixed: true } } },
  accounts: [
    { id: 'itau', name: 'Itaú', currency: 'BRL', snapshot_balance: 2500, status: 'operacional' },
    { id: 'nu', name: 'Nubank', currency: 'BRL', snapshot_balance: 1340.9, status: 'operacional' },
    { id: 'res', name: 'Reserva de emergência', currency: 'BRL', snapshot_balance: 6000, status: 'reserva' },
    { id: 'nomad', name: 'Nomad', currency: 'USD', snapshot_balance: 1000, status: 'reserva' }
  ],
  credit_facilities: [],
  transactions: [
    { id: 't1', date: '2026-11-02', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 230.5, currency: 'BRL', category: 'Alimentação/Compras', description: 'Mercado' },
    { id: 't2', date: '2026-11-03', type: 'despesa', status: 'confirmado', account_id: 'itau', amount: 89.9, currency: 'BRL', category: 'Lazer/Assinaturas', description: 'Internet' },
    { id: 't3', date: '2026-11-04', type: 'receita', status: 'confirmado', account_id: 'itau', amount: 4200, currency: 'BRL', category: 'Salário', description: 'Salário' },
    { id: 't4', date: '2026-11-04', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 32, currency: 'BRL', category: 'Transporte', description: 'Uber' },
    { id: 't5', date: '2026-10-20', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 50, currency: 'BRL', category: 'Transporte', description: 'Ônibus' }
  ],
  obligations: [
    { id: 'o1', description: 'Conta de luz', amount: 180, currency: 'BRL', due_date: '2026-11-07', status: 'pendente' },
    { id: 'o2', description: 'Aluguel', amount: 1800, currency: 'BRL', due_date: '2026-11-03', status: 'pendente' },
    { id: 'o3', description: 'Escola', amount: 950, currency: 'BRL', due_date: '2026-12-10', status: 'planejado' }
  ]
});

test('sugestões usam os dados: nomes das contas e a categoria em que mais gasta', () => {
  const g = Nlp.suggestions(ds(), HOJE), all = g.flatMap(x => x.items);
  assert.ok(all.length >= 15, 'tem ' + all.length);
  assert.ok(all.includes('Quanto tenho no Itaú?'));
  assert.ok(all.includes('Quanto gastei com Alimentação/Compras este mês?'));
  assert.ok(all.includes('Quanto tenho guardado nas reservas?'));
  assert.ok(all.some(x => /vencem em dezembro/.test(x)));
  assert.ok(!all.some(x => /Luna|Espanha/.test(x)), 'sem textos de outra família');
});

test('toda sugestão é entendida e tem resposta válida', () => {
  const d = ds();
  for (const q of Nlp.suggestions(d, HOJE).flatMap(x => x.items)) {
    const p = Nlp.parse(q, d, HOJE);
    assert.ok(!['unknown', 'empty', 'help'].includes(p.intent), `"${q}" não foi entendida`);
    if (p.intent === 'register') { assert.ok(p.draft.amount > 0 && p.draft.account_id, `"${q}": rascunho incompleto`); continue; }
    if (p.intent === 'doc' || p.intent === 'statement') continue; // geram documento / abrem o extrato
    const a = Nlp.answer(p, d, HOJE);
    const txt = JSON.stringify(a);
    assert.ok(a && a.title, `"${q}" sem título`);
    assert.ok(!/NaN|undefined|null,"value"/.test(txt), `"${q}" com valor inválido: ${txt.slice(0, 200)}`);
  }
});

test('patrimônio total: tudo convertido para reais', () => {
  const a = Nlp.answer(Nlp.parse('Qual meu patrimônio total?', ds(), HOJE), ds(), HOJE);
  // Itaú 2500+4200-89,9 · Nubank 1340,9-230,5-32 · reserva 6000 · US$ 1000 × 5,49
  assert.equal(a.total, 'R$ 19.178,50');
});

test('onde mais gastei: categorias em ordem, só do mês', () => {
  const a = Nlp.answer(Nlp.parse('Onde mais gastei este mês?', ds(), HOJE), ds(), HOJE);
  assert.deepEqual(JSON.parse(JSON.stringify(a.lines.map(l => l.label))), ['Alimentação/Compras', 'Lazer/Assinaturas', 'Transporte']);
  assert.equal(a.total, 'R$ 352,40');
});

test('quanto recebi e como está o mês', () => {
  const r = Nlp.answer(Nlp.parse('Quanto recebi este mês?', ds(), HOJE), ds(), HOJE);
  assert.equal(r.total, 'R$ 4.200,00');
  const m = Nlp.answer(Nlp.parse('Como está meu mês?', ds(), HOJE), ds(), HOJE);
  assert.equal(m.total, 'R$ 3.847,60');
  assert.ok(m.lines.some(l => l.label === 'Sobrou' && l.value === 'R$ 3.847,60'));
  assert.ok(m.lines.some(l => /Contas ainda a pagar \(2\)/.test(l.label) && l.value === 'R$ 1.980,00'));
});

test('gastos somam moedas diferentes convertendo (antes somava euro como real)', () => {
  const d = ds();
  d.transactions.push({ id: 't6', date: '2026-11-04', type: 'despesa', status: 'confirmado', account_id: 'nu', amount: 10, currency: 'EUR', category: 'Viagem', description: 'Café' });
  const a = Nlp.answer(Nlp.parse('Quanto gastei este mês?', d, HOJE), d, HOJE);
  assert.equal(a.total, 'R$ 412,40'); // 352,40 + 10 € × 6
  d.settings.exchange_rates = { USD: { rate: 5.49, fixed: true } }; // sem cotação do euro
  const b = Nlp.answer(Nlp.parse('Quanto gastei este mês?', d, HOJE), d, HOJE);
  assert.equal(b.total, 'R$ 352,40');
  assert.ok(b.notes.some(n => /EUR/.test(n)));
});

test('perguntas do estado financeiro respondem pelo semáforo automático', () => {
  const d = ds();
  for (const q of ['Como estou financeiramente?', 'Quanto posso guardar?', 'Qual conta devo pagar primeiro?', 'O que preciso fazer para sair do vermelho?', 'Como está o semáforo?'])
    assert.equal(Nlp.parse(q, d, HOJE).intent, 'light', q);
  const p = Nlp.parse('Se eu guardar R$ 500, meu semáforo muda?', d, HOJE);
  assert.equal(p.intent, 'light'); assert.equal(p.save, 500);
  const a = Nlp.answer(p, d, HOJE);
  assert.equal(a.title, 'Seu estado financeiro'); assert.match(a.notes[0], /Se guardar R\$\s?500,00 hoje/);
  assert.ok(a.lines.some(l => /Pode guardar hoje/.test(l.label)));
  // "Como está meu mês?" continua sendo o resumo do mês
  assert.notEqual(Nlp.parse('Como está meu mês?', d, HOJE).intent, 'light');
});
