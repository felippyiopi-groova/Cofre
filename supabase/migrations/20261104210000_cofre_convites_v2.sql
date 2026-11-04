-- E-mail no perfil: só quem divide cofre com a pessoa (ou o dono, ao aprovar o pedido dela) consegue ver.
alter table public.profiles add column if not exists email text;

-- Versão 2 do aceite de convite: devolve também o e-mail e a chave pública do DONO, para o convidado
-- calcular o código de 6 dígitos e conferir com o dono antes da aprovação.
-- (A versão 1, accept_invite, continua existindo sem uso; será removida depois.)
create function public.accept_invite_v2(token text)
returns table (vault_id uuid, role text, owner_email text, owner_enc_public_key text)
language plpgsql security definer set search_path = '' as $$
declare inv public.vault_invites;
begin
  if auth.uid() is null then raise exception 'login necessário'; end if;
  if not exists (select 1 from public.profiles p where p.user_id = auth.uid()) then
    raise exception 'crie suas chaves antes de aceitar o convite';
  end if;
  select * into inv from public.vault_invites i
    where i.token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
    for update;
  if not found or inv.status <> 'pending' or inv.expires_at < now() then
    raise exception 'convite inválido, já usado ou expirado';
  end if;
  if exists (select 1 from public.vault_members m where m.vault_id = inv.vault_id and m.user_id = auth.uid()) then
    raise exception 'você já é membro deste cofre';
  end if;
  update public.vault_invites set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
    where id = inv.id;
  return query
    select inv.vault_id, inv.role, p.email, p.enc_public_key
    from public.vaults v join public.profiles p on p.user_id = v.owner_id
    where v.id = inv.vault_id;
end $$;
revoke execute on function public.accept_invite_v2(text) from public, anon;
grant execute on function public.accept_invite_v2(text) to authenticated;
