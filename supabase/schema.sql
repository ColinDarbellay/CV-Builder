-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Replace YOUR_EMAIL_HERE with the e-mail you will sign in with.

-- Who may read and edit the data (only you).
create table if not exists public.members (email text primary key);
insert into public.members (email) values ('YOUR_EMAIL_HERE') on conflict do nothing;

-- All app data: CV versions and profile items, one JSON document per row.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (collection, id)
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where lower(m.email) = lower(auth.jwt() ->> 'email'));
$$;

alter table public.docs enable row level security;
alter table public.members enable row level security;

drop policy if exists "members read docs" on public.docs;
drop policy if exists "members add docs" on public.docs;
drop policy if exists "members change docs" on public.docs;
drop policy if exists "members remove docs" on public.docs;
drop policy if exists "see own membership" on public.members;

create policy "members read docs"   on public.docs for select to authenticated using (public.is_member());
create policy "members add docs"    on public.docs for insert to authenticated with check (public.is_member());
create policy "members change docs" on public.docs for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "members remove docs" on public.docs for delete to authenticated using (public.is_member());
create policy "see own membership"  on public.members for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

-- Live updates between your devices.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
