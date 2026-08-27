create table if not exists public.profile_views (
  visitor_uid uuid primary key,
  view_count bigint not null default 1 check (view_count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.profile_views is
  'Visualizacoes do perfil registradas pelo backend do Auxiliar Prisma.';

comment on column public.profile_views.visitor_uid is
  'Identificador anonimo e persistente gerado pelo navegador.';

create index if not exists profile_views_last_seen_at_idx
  on public.profile_views (last_seen_at desc);

alter table public.profile_views enable row level security;

revoke all on table public.profile_views from anon, authenticated;
grant all on table public.profile_views to service_role;

create or replace function public.register_profile_view(p_visitor_uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with inserted as (
    insert into public.profile_views (visitor_uid)
    values (p_visitor_uid)
    on conflict (visitor_uid) do nothing
    returning true as is_new
  ),
  updated as (
    update public.profile_views
    set view_count = view_count + 1,
        last_seen_at = now()
    where visitor_uid = p_visitor_uid
      and not exists (select 1 from inserted)
    returning false as is_new
  )
  select is_new from inserted
  union all
  select is_new from updated
  limit 1;
$$;

revoke all on function public.register_profile_view(uuid) from public, anon, authenticated;
grant execute on function public.register_profile_view(uuid) to service_role;
