// Leitor de comprovantes: texto de PDF, campos do comprovante e pedidos às IAs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const L = carregar('Leitor');
const HOJE = { today: '2026-11-05' };

async function deflate(str) {
  const u = new Uint8Array([...str].map(c => c.charCodeAt(0) & 255));
  const cs = new CompressionStream('deflate'); const w = cs.writable.getWriter(); w.write(u); w.close();
  const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let s = ''; out.forEach(b => { s += String.fromCharCode(b); }); return s;
}
// Monta um PDF mínimo com os objetos dados (texto latin1) e devolve os bytes.
function pdf(objs) {
  let s = '%PDF-1.7\n';
  objs.forEach((o, i) => { s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  s += 'trailer\n<< /Root 1 0 R >>\n%%EOF';
  return new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
}
const stream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;

test('PDF com fonte padrão (WinAnsi), compactado: lê o texto com acentos', async () => {
  const content = 'BT /F1 11 Tf 50 800 Td (Comprovante de transfer\\352ncia) Tj 0 -18 Td (05/11/2026) Tj 0 -18 Td (Valor: R$ 1.234,56) Tj 0 -18 Td (Destino) Tj 0 -18 Td (Nome: MARIA DA SILVA) Tj ET';
  const bytes = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream('/Filter /FlateDecode', await deflate(content)), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  const r = await L.pdfText(bytes);
  assert.match(r.text, /Comprovante de transferência/);
  const c = L.parseReceipt(r.text, HOJE);
  assert.equal(c.amount, 1234.56); assert.equal(c.date, '2026-11-05'); assert.equal(c.counterparty, 'Maria da Silva'); assert.equal(c.type, 'despesa');
});

test('PDF estilo navegador (Identity-H + ToUnicode, letra por letra): junta as letras e separa colunas', async () => {
  // Códigos 1..: V a l o r R $ espaço 8 9 , 0 P x
  const chars = 'Valor R$89,0Pix enviado';
  const uniq = [...new Set(chars)];
  const code = ch => (uniq.indexOf(ch) + 1).toString(16).padStart(4, '0');
  const hex = str => '<' + [...str].map(code).join('') + '>';
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${uniq.length} beginbfchar ${uniq.map(ch => `<${code(ch)}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`).join(' ')} endbfchar endcmap end end`;
  // "V" e depois "alor" com Td do tamanho da largura do V (600/1000 * 16 = 9.6): não pode virar "V alor".
  const content = [
    'BT /F4 16 Tf 1 0 0 -1 41 100 Tm ' + hex('Pix enviado') + ' Tj ET',
    'BT /F4 16 Tf 1 0 0 -1 41 137 Tm ' + hex('V') + ' Tj 9.6 0 Td ' + hex('alor') + ' Tj ET',
    'BT /F4 16 Tf 1 0 0 -1 600 137 Tm ' + hex('R$ 89,90') + ' Tj ET'
  ].join('\n');
  const bytes = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F4 5 0 R >> >> /Contents 4 0 R >>',
    stream('/Filter /FlateDecode', await deflate(content)),
    '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [600]] >>',
    stream('/Filter /FlateDecode', await deflate(cmap))]);
  const r = await L.pdfText(bytes);
  assert.equal(r.text, 'Pix enviado\nValor R$ 89,90');
  const c = L.parseReceipt(r.text, HOJE);
  assert.equal(c.amount, 89.9); assert.equal(c.method, 'pix');
});

test('arquivo que não é PDF dá erro; PDF protegido por senha não é lido', async () => {
  await assert.rejects(() => L.pdfText(new Uint8Array([1, 2, 3])));
  const r = await L.pdfText(new TextEncoder().encode('%PDF-1.4\ntrailer << /Encrypt 9 0 R >>'));
  assert.equal(r.encrypted, true);
});

test('comprovante de boleto: usa o valor pago e a data do pagamento, não o vencimento', () => {
  const t = `Comprovante de pagamento de boleto
Beneficiário
ENEL DISTRIBUICAO SAO PAULO
Data de vencimento
10/11/2026
Valor do documento
R$ 210,00
Valor pago
R$ 198,40
Data do pagamento
04/11/2026`;
  const c = L.parseReceipt(t, HOJE);
  assert.equal(c.amount, 198.4); assert.equal(c.date, '2026-11-04'); assert.equal(c.method, 'boleto');
  assert.equal(c.counterparty, 'Enel Distribuicao Sao Paulo');
});

test('Pix recebido: vira receita e o nome é de quem pagou', () => {
  const t = `Pix recebido
Valor R$ 350,00
3 de novembro de 2026
Quem pagou
Nome Carlos Lima
Instituição Itaú Unibanco
Quem recebeu
Nome João Pereira`;
  const c = L.parseReceipt(t, HOJE);
  assert.equal(c.type, 'receita'); assert.equal(c.amount, 350); assert.equal(c.date, '2026-11-03');
  assert.equal(c.counterparty, 'Carlos Lima'); assert.equal(c.bank, 'Itaú Unibanco');
});

test('não confunde saldo ou tarifa com o valor; texto sem dados não completa', () => {
  const c = L.parseReceipt('Saldo disponível R$ 5.000,00\nTarifa R$ 0,00\nValor da transferência R$ 42,10\nData 01/11/2026', HOJE);
  assert.equal(c.amount, 42.1);
  const v = L.parseReceipt('Olá, tudo bem?', HOJE);
  assert.equal(v.complete, false); assert.equal(v.amount, null);
});

test('resposta da IA: lê o JSON, tira CPF/CNPJ do nome e ignora texto em volta', () => {
  const r = L.fromAi('Claro! ```json\n{"e_comprovante":true,"valor":"1.234,56","data":"2026-11-02","direcao":"saida","meio":"pix","contraparte":"Padaria Pão Quente 12.345.678/0001-90","banco_contraparte":"Banco do Brasil","descricao_curta":"Pix padaria"}\n```');
  assert.equal(r.amount, 1234.56); assert.equal(r.date, '2026-11-02'); assert.equal(r.type, 'despesa');
  assert.equal(r.counterparty, 'Padaria Pão Quente'); assert.equal(r.methodLabel, 'Pix'); assert.equal(r.complete, true);
  const e = L.fromAi('{"e_comprovante":false,"valor":null,"data":null,"direcao":"entrada"}');
  assert.equal(e.notReceipt, true); assert.equal(e.amount, null); assert.equal(e.type, 'receita');
  assert.throws(() => L.fromAi('não sei'));
});

test('pedidos às IAs: chave no cabeçalho certo e o arquivo no formato de cada uma', () => {
  const img = { mime: 'image/jpeg', base64: 'QUJD' }, pdfF = { mime: 'application/pdf', base64: 'UERG' };
  const g = L.readRequest('gemini', 'AIzaX', 'gemini-2.5-flash', img);
  assert.match(g.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(g.init.headers['x-goog-api-key'], 'AIzaX'); assert.doesNotMatch(g.url, /AIzaX/); // chave fora da URL
  assert.equal(JSON.parse(g.init.body).contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  const o = JSON.parse(L.readRequest('openai', 'sk-1', 'gpt-x-mini', pdfF).init.body);
  assert.equal(o.messages[0].content[1].type, 'file'); assert.equal(o.response_format.type, 'json_object');
  const a = L.readRequest('anthropic', 'sk-ant-1', 'claude-opus-5-5', img);
  assert.equal(a.init.headers['x-api-key'], 'sk-ant-1'); assert.equal(a.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  const ab = JSON.parse(a.init.body); assert.equal(ab.messages[0].content[0].type, 'image'); assert.equal(ab.temperature, undefined);
  const t = JSON.parse(L.readRequest('anthropic', 'k', 'm', null, 'Valor R$ 10,00').init.body);
  assert.equal(t.messages[0].content.length, 1); assert.match(t.messages[0].content[0].text, /Valor R\$ 10,00/);
});

test('lista de modelos: escolhe um que lê imagem e é barato/grátis', () => {
  const g = L.pickModels('gemini', { models: [
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] });
  assert.equal(g[0], 'gemini-2.5-flash'); assert.ok(!g.some(x => /tts|embedding/.test(x)));
  const o = L.pickModels('openai', { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'whisper-1' }, { id: 'gpt-4o-realtime-preview' }] });
  assert.equal(o[0], 'gpt-4o-mini'); assert.ok(!o.includes('whisper-1'));
  const c = L.pickModels('anthropic', { data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] });
  assert.equal(c[0], 'claude-opus-5-5');
});

test('mensagens de erro em português', () => {
  assert.match(L.explainError('gemini', 429, {}), /limite do plano grátis/);
  assert.match(L.explainError('openai', 401, { error: { message: 'Incorrect API key' } }), /recusada/);
  assert.match(L.explainError('gemini', 400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), /não é válida/);
});

test('cupom fiscal: valor a pagar, sem confundir com troco ou valor recebido', () => {
  const t = `SUPERMERCADO BOM PRECO LTDA
CNPJ 12.345.678/0001-90
Qtd. total de itens 7
Valor total R$ 152,30
Descontos R$ 2,30
Valor a pagar R$ 150,00
Dinheiro 200,00
Troco R$ 50,00
Emissão: 04/11/2026 18:22`;
  const c = L.parseReceipt(t, HOJE);
  assert.equal(c.amount, 150); assert.equal(c.date, '2026-11-04');
});

test('IA: categoria só se for da lista, forma de pagamento dinheiro e regras extras no pedido', () => {
  const cats = ['Alimentação/Compras', 'Saúde'];
  const r = L.fromAi('{"e_comprovante":true,"tipo_documento":"cupom_fiscal","valor":150,"data":"2026-11-04","direcao":"saida","meio":"dinheiro","contraparte":"Supermercado Bom Preço","categoria":"Alimentação/Compras"}', cats);
  assert.equal(r.category, 'Alimentação/Compras'); assert.equal(r.methodLabel, 'Dinheiro'); assert.equal(r.docLabel, 'Cupom fiscal');
  assert.equal(L.fromAi('{"valor":10,"direcao":"saida","categoria":"Inventada"}', cats).category, undefined);
  assert.equal(L.fromAi('{"valor":10,"direcao":"entrada","categoria":"Saúde"}', cats).category, undefined);
  const body = JSON.parse(L.readRequest('gemini', 'k', 'm', null, 'texto', { categories: cats, rules: 'Pix para Maria é aluguel' }).init.body);
  const txt = body.contents[0].parts[0].text;
  assert.match(txt, /LISTA DE CATEGORIAS: Alimentação\/Compras \| Saúde/); assert.match(txt, /Pix para Maria é aluguel/); assert.match(txt, /cupom fiscal/i);
});
