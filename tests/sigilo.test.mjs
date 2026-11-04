// Criptografia da sincronização: senha, recuperação, chave do cofre, registros e assinaturas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './carregar.mjs';

const S = carregar('Sigilo');
const ITER = 1000; // nos testes, poucas iterações para rodar rápido (o app usa 600 mil)

test('senha: mesma senha e e-mail geram a mesma prova; senha diferente não', async () => {
  const a = await S.fromPassword('Eu@Exemplo.com ', 'frase secreta longa', ITER);
  const b = await S.fromPassword('eu@exemplo.com', 'frase secreta longa', ITER);
  const c = await S.fromPassword('eu@exemplo.com', 'outra senha', ITER);
  assert.equal(a.authSecret, b.authSecret);
  assert.notEqual(a.authSecret, c.authSecret);
  assert.ok(!a.authSecret.includes('frase'));
});

test('chaves privadas: destrancam com a senha certa ou a recuperação, nunca com a errada', async () => {
  const keys = await S.newUserKeys();
  const { kek } = await S.fromPassword('eu@x.com', 'senha certa 123', ITER);
  const code = S.newRecoveryCode();
  assert.equal(code.replace(/-/g, '').length, 52);
  const locked = await S.lockPrivate(keys, kek);
  const lockedRec = await S.lockPrivate(keys, await S.recoveryKek(code));
  assert.ok(await S.unlockPrivate(locked, kek));
  // a recuperação aceita letras minúsculas, espaços e O/0 trocados
  const digitada = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
  assert.ok(await S.unlockPrivate(lockedRec, await S.recoveryKek(digitada)));
  const errada = await S.fromPassword('eu@x.com', 'senha errada 123', ITER);
  await assert.rejects(S.unlockPrivate(locked, errada.kek), /incorreta/);
  await assert.rejects(S.recoveryKek('ABC'), /12 palavras/);
});

test('trocar senha: retranca sem perder as chaves', async () => {
  const keys = await S.newUserKeys();
  const v = await S.fromPassword('eu@x.com', 'antiga 1234567', ITER), n = await S.fromPassword('eu@x.com', 'nova 12345678', ITER);
  const locked2 = await S.relock(await S.lockPrivate(keys, v.kek), v.kek, n.kek);
  assert.ok(await S.unlockPrivate(locked2, n.kek));
  await assert.rejects(S.unlockPrivate(locked2, v.kek));
});

async function pessoa(email) {
  const keys = await S.newUserKeys(), pub = await S.publicKeys(keys);
  const { kek } = await S.fromPassword(email, 'senha ' + email, ITER);
  const priv = await S.unlockPrivate(await S.lockPrivate(keys, kek), kek);
  return { pub, priv };
}

test('chave do cofre: só abre para quem ela foi trancada', async () => {
  const dono = await pessoa('dono@x.com'), esposa = await pessoa('esposa@x.com'), estranho = await pessoa('e@x.com');
  const vault = 'cofre-1', secret = S.newVaultSecret();
  const paraEsposa = await S.lockForMember(secret, esposa.pub.enc_public_key, vault);
  const aberta = await S.unlockVaultSecret(paraEsposa, esposa.priv.encPrivate, vault);
  assert.deepEqual(Array.from(aberta), Array.from(secret));
  await assert.rejects(S.unlockVaultSecret(paraEsposa, estranho.priv.encPrivate, vault));
  await assert.rejects(S.unlockVaultSecret(paraEsposa, esposa.priv.encPrivate, 'outro-cofre')); // não serve noutro cofre
  assert.ok(!paraEsposa.includes(Buffer.from(secret).toString('base64')));
  void dono;
});

test('registros: ida e volta, ID opaco, e o servidor não consegue trocar nem adulterar', async () => {
  const dono = await pessoa('dono@x.com');
  const vk = await S.vaultKeys(S.newVaultSecret());
  const r1 = await S.rid(vk.rid, 'transactions:tx-2026-10-26-uber');
  assert.match(r1, /^[0-9a-f]{40}$/);
  assert.equal(r1, await S.rid(vk.rid, 'transactions:tx-2026-10-26-uber')); // estável
  const item = { c: 'transactions', item: { id: 'tx-1', description: 'Uber', amount: 8 } };
  const box = await S.sealRecord(vk.data, 'v1', r1, 1, item);
  assert.ok(!box.ciphertext.includes('Uber'));
  assert.deepEqual(JSON.parse(JSON.stringify(await S.openRecord(vk.data, 'v1', r1, 1, box))), item);
  await assert.rejects(S.openRecord(vk.data, 'v1', 'outro-rid', 1, box)); // movido de lugar
  await assert.rejects(S.openRecord(vk.data, 'v2', r1, 1, box));          // movido de cofre
  const adulterado = Object.assign({}, box, { ciphertext: box.ciphertext.slice(0, -4) + 'AAAA' });
  await assert.rejects(S.openRecord(vk.data, 'v1', r1, 1, adulterado));
  // assinatura do autor
  const sig = await S.signRecord(dono.priv.signPrivate, 'v1', r1, 1, box.iv, box.ciphertext, false);
  assert.equal(await S.verifyRecord(dono.pub.sign_public_key, 'v1', r1, 1, box.iv, box.ciphertext, false, sig), true);
  assert.equal(await S.verifyRecord(dono.pub.sign_public_key, 'v1', r1, 1, box.iv, box.ciphertext, true, sig), false);
  const outro = await pessoa('o@x.com');
  assert.equal(await S.verifyRecord(outro.pub.sign_public_key, 'v1', r1, 1, box.iv, box.ciphertext, false, sig), false);
});

test('código de 6 dígitos: igual nos dois lados, diferente com outra chave', async () => {
  const a = await pessoa('a@x.com'), b = await pessoa('b@x.com'), c = await pessoa('c@x.com');
  const ab = await S.safetyCode(a.pub.enc_public_key, b.pub.enc_public_key);
  assert.match(ab, /^\d{6}$/);
  assert.equal(ab, await S.safetyCode(b.pub.enc_public_key, a.pub.enc_public_key));
  assert.notEqual(ab, await S.safetyCode(a.pub.enc_public_key, c.pub.enc_public_key));
});

test('12 palavras: geradas da lista, aceitas com erros comuns de digitação', async () => {
  const w = S.newRecoveryWords();
  assert.equal(w.length, 12);
  assert.ok(w.every(x => S.PALAVRAS.includes(x)));
  assert.equal(S.PALAVRAS.length, 2048);
  const keys = await S.newUserKeys();
  const locked = await S.lockPrivate(keys, await S.recoveryKek(w));
  // maiúsculas, acentos, vírgulas, números da lista e erro no fim da palavra (4 primeiras letras bastam)
  const digitado = w.map((x, i) => (i + 1) + '. ' + (i === 0 ? x.toUpperCase() : i === 1 ? x.slice(0, 4) + 'xyz' : x)).join(', ').replace(/a/, 'á');
  assert.ok(await S.unlockPrivate(locked, await S.recoveryKek(digitado)));
  await assert.rejects(S.recoveryKek(w.slice(0, 11).join(' ')), /12 palavras/);
  await assert.rejects(S.recoveryKek(w.slice(0, 11).join(' ') + ' qwerty'), /Não reconheci: qwerty/);
  const outras = S.newRecoveryWords();
  await assert.rejects(S.unlockPrivate(locked, await S.recoveryKek(outras)), /incorreta/);
});

test('esqueci a senha: as 12 palavras retrancam as chaves com a senha nova', async () => {
  const keys = await S.newUserKeys(), w = S.newRecoveryWords();
  const velha = await S.fromPassword('eu@x.com', 'senha esquecida', ITER), nova = await S.fromPassword('eu@x.com', 'senha nova 99', ITER);
  const recLocked = await S.lockPrivate(keys, await S.recoveryKek(w));
  const novoLocked = await S.relock(recLocked, await S.recoveryKek(w.join(' ')), nova.kek);
  const p = await S.unlockPrivate(novoLocked, nova.kek);
  assert.ok(p.encPrivate && p.signPrivate);
  await assert.rejects(S.unlockPrivate(novoLocked, velha.kek));
});
