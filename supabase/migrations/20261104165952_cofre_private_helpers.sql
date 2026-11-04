-- Funções auxiliares das regras de acesso saem da API pública (esquema private não é exposto).
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.vault_role(uuid) set schema private;
alter function public.is_vault_owner(uuid) set schema private;
alter function public.shares_vault_with(uuid) set schema private;
-- As regras (RLS) passam a apontar para private.* automaticamente (referência por OID).
