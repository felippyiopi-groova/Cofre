-- Cofre: sincronização com criptografia de ponta a ponta.
-- O servidor só guarda dados embaralhados (ciphertext) e chaves trancadas.
-- Nada aqui permite ler valores, contas ou descrições.

-- Chaves públicas de cada pessoa (podem ser vistas por quem divide cofre com ela).
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enc_public_key text not null,      -- ECDH P-256 (JWK), para receber chaves de cofre
  sign_public_key text not null,     -- ECDSA P-256 (JWK), para verificar autoria
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Chaves privadas TRANCADAS (pela senha e pela chave de recuperação). Só o dono lê.
create table public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wrapped_private_keys text not null,        -- trancadas com chave derivada da senha
  recovery_wrapped_private_keys text not null, -- trancadas com a chave de recuperação
  kdf jsonb not null,                        -- sal e iterações (não são segredo)
  updated_at timestamptz not null default now()
);

create table public.vaults (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  key_version int not null default 1,
  meta_ct text,                      -- nome do cofre, embaralhado
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vault_members (
  vault_id uuid not null references public.vaults(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  wrapped_vault_key text not null,   -- chave do cofre trancada com a chave pública do membro
  key_version int not null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (vault_id, user_id)
);
create index vault_members_user_idx on public.vault_members(user_id);

-- Convite: o link leva um segredo; o servidor guarda só o hash dele.
create table public.vault_invites (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references public.vaults(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '48 hours',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'approved', 'revoked')),
  accepted_by uuid references auth.users(id) on delete cascade,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index vault_invites_vault_idx on public.vault_invites(vault_id);

-- Registros embaralhados. rid = HMAC opaco (o ID real, ex.: "tx-...-uber", não vaza).
create sequence public.records_rev_seq;
create table public.records (
  vault_id uuid not null references public.vaults(id) on delete cascade,
  rid text not null,
  ciphertext text not null,
  iv text not null,
  key_version int not null,
  sig text,                          -- assinatura do autor sobre o conteúdo
  deleted boolean not null default false,
  rev bigint not null default nextval('public.records_rev_seq'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (vault_id, rid)
);
create index records_sync_idx on public.records(vault_id, rev);

-- A cada alteração: nova revisão (cursor de sincronização), autor e hora definidos pelo servidor.
create function public.records_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.rev := nextval('public.records_rev_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger user_keys_touch before update on public.user_keys for each row execute function public.touch_updated_at();
create trigger vaults_touch before update on public.vaults for each row execute function public.touch_updated_at();

-- Funções auxiliares (security definer evita recursão nas regras de acesso).
-- (movidas para o esquema private na migração seguinte)
create function public.vault_role(v uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.vault_members m where m.vault_id = v and m.user_id = auth.uid()
$$;
create function public.is_vault_owner(v uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vaults x where x.id = v and x.owner_id = auth.uid())
$$;
create function public.shares_vault_with(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.vault_members a join public.vault_members b on a.vault_id = b.vault_id
    where a.user_id = auth.uid() and b.user_id = u)
  or exists (
    select 1 from public.vault_invites i join public.vaults x on x.id = i.vault_id
    where x.owner_id = auth.uid() and i.accepted_by = u and i.status = 'accepted')
$$;

-- ===== Regras de acesso (RLS) =====
alter table public.profiles enable row level security;
alter table public.user_keys enable row level security;
alter table public.vaults enable row level security;
alter table public.vault_members enable row level security;
alter table public.vault_invites enable row level security;
alter table public.records enable row level security;

-- profiles: cada um cria/edita o seu; lê o próprio e o de quem divide cofre (ou pediu para entrar).
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or public.shares_vault_with(user_id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- user_keys: só o próprio usuário, em tudo.
create policy user_keys_all on public.user_keys for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- vaults: membros leem; qualquer usuário cria um cofre seu; só o dono altera/apaga.
create policy vaults_select on public.vaults for select to authenticated
  using (owner_id = (select auth.uid()) or public.vault_role(id) is not null);
create policy vaults_insert on public.vaults for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy vaults_update on public.vaults for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy vaults_delete on public.vaults for delete to authenticated
  using (owner_id = (select auth.uid()));

-- vault_members: membros veem a lista; só o dono adiciona, troca papel/chave ou remove.
-- Exceção: um membro pode sair do cofre (apagar a própria linha), menos o dono.
create policy members_select on public.vault_members for select to authenticated
  using (public.vault_role(vault_id) is not null);
create policy members_insert on public.vault_members for insert to authenticated
  with check (public.is_vault_owner(vault_id));
create policy members_update on public.vault_members for update to authenticated
  using (public.is_vault_owner(vault_id)) with check (public.is_vault_owner(vault_id));
create policy members_delete on public.vault_members for delete to authenticated
  using (public.is_vault_owner(vault_id) or (user_id = (select auth.uid()) and role <> 'owner'));

-- vault_invites: só o dono do cofre vê e gerencia. O convidado aceita pela função accept_invite.
create policy invites_owner on public.vault_invites for all to authenticated
  using (public.is_vault_owner(vault_id))
  with check (public.is_vault_owner(vault_id) and created_by = (select auth.uid()));

-- records: membros leem; dono e "pode editar" gravam. Ninguém apaga linha (exclusão = marca deleted).
create policy records_select on public.records for select to authenticated
  using (public.vault_role(vault_id) is not null);
create policy records_insert on public.records for insert to authenticated
  with check (public.vault_role(vault_id) in ('owner', 'editor'));
create policy records_update on public.records for update to authenticated
  using (public.vault_role(vault_id) in ('owner', 'editor'))
  with check (public.vault_role(vault_id) in ('owner', 'editor'));

-- Aceitar convite: o convidado prova que tem o segredo do link. Não recebe nenhuma chave aqui:
-- o dono ainda precisa conferir o código de 6 dígitos e aprovar.
create function public.accept_invite(token text) returns table (vault_id uuid, role text)
language plpgsql security definer set search_path = '' as $$
declare inv public.vault_invites;
begin
  if auth.uid() is null then raise exception 'login necessário'; end if;
  select * into inv from public.vault_invites
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
    for update;
  if not found or inv.status <> 'pending' or inv.expires_at < now() then
    raise exception 'convite inválido ou expirado';
  end if;
  if exists (select 1 from public.vault_members m where m.vault_id = inv.vault_id and m.user_id = auth.uid()) then
    raise exception 'você já é membro deste cofre';
  end if;
  update public.vault_invites set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
    where id = inv.id;
  return query select inv.vault_id, inv.role;
end $$;

-- Funções só para usuários logados.
revoke execute on function public.accept_invite(text) from public, anon;
revoke execute on function public.vault_role(uuid) from public, anon;
revoke execute on function public.is_vault_owner(uuid) from public, anon;
revoke execute on function public.shares_vault_with(uuid) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.vault_role(uuid) to authenticated;
grant execute on function public.is_vault_owner(uuid) to authenticated;
grant execute on function public.shares_vault_with(uuid) to authenticated;
revoke all on function public.records_touch() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- Tempo real: avisa os outros aparelhos quando um registro muda (respeita as regras acima).
alter publication supabase_realtime add table public.records;
