-- Researcher profiles: one row per Supabase auth user.
--
-- Groundwork only. The schema is deliberately generic (not tied to lung
-- cancer or any one tumour model) so later models, saved runs and
-- collaboration can reference it unchanged.
--
-- Security model
--   * Rows are created by a trigger on auth.users, never by the client.
--   * RLS: an authenticated user can read and update only their own row.
--   * No insert / delete for clients; deleting the auth user cascades.
--   * Column grants: clients may edit descriptive fields only. id,
--     created_at and updated_at are system-managed, and orcid_id is reserved
--     for a future verified ORCID sign-in, so nobody can claim someone
--     else's iD (it is unique) by typing it in.

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 120),
  institution   text,
  department    text,
  research_role text,
  orcid_id      text unique,
  avatar_url    text,
  bio           text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Researcher profile, one per auth user. Created automatically; owner-only access via RLS.';
comment on column public.profiles.orcid_id is
  'Reserved for a verified ORCID sign-in flow. Not writable by clients.';

-- ── updated_at ───────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ── a profile for every new auth user ────────────────────────────────────
-- security definer: runs as the function owner, because the auth service
-- inserting into auth.users has no rights on public.profiles. The empty
-- search_path stops anyone shadowing the objects it uses.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'Researcher'
      ),
      120
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger functions cannot be called directly, but keep them off the API surface anyway.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── access control ───────────────────────────────────────────────────────

alter table public.profiles enable row level security;

-- Table privileges first (defence in depth under RLS): anonymous visitors get
-- nothing; signed-in users may read, and update descriptive columns only.
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name, institution, department, research_role, avatar_url, bio)
  on table public.profiles to authenticated;

create policy "Researchers can read their own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "Researchers can update their own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
