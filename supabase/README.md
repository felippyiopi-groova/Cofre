# Servidor do Cofre (Supabase)

Projeto `cofre` · região São Paulo (`sa-east-1`) · plano gratuito.

- URL: `https://rahpgtuaxbxdtjjohubi.supabase.co`
- Chave publicável (pode ficar no app): `sb_publishable_cr2fcV_wC58GLFAgdO_ijg_hccormKO`
- A chave **service_role** nunca entra neste repositório nem no app.

## O que o servidor guarda

Só dados embaralhados no aparelho (criptografia de ponta a ponta). O servidor não
consegue ler valores, contas, bancos ou descrições. Veja o plano completo no
documento "Cofre — Plano de acesso privado e compartilhamento".

| Tabela | Conteúdo | Quem acessa |
| --- | --- | --- |
| `profiles` | chaves públicas de cada pessoa | a própria pessoa e quem divide cofre com ela |
| `user_keys` | chaves privadas trancadas (senha e recuperação) | só a própria pessoa |
| `vaults` | cofres (nome embaralhado) | membros; só o dono altera |
| `vault_members` | membros, papel e chave do cofre trancada para cada um | membros veem; só o dono altera |
| `vault_invites` | convites (só o hash do segredo do link) | só o dono do cofre |
| `records` | registros embaralhados, com revisão para sincronizar | membros leem; dono e "pode editar" gravam |

## Migrações

Em `migrations/`, na ordem em que foram aplicadas. Regras de acesso testadas em
2026-11-04 com três usuários simulados (dono, convidada e estranho): 22 de 22 verificações ok.
