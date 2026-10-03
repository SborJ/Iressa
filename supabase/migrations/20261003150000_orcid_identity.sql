-- Verified ORCID researchers.
--
-- Researchers may sign in with ORCID (Supabase Auth custom OIDC provider
-- "custom:orcid"). Supabase verifies ORCID's signed ID token and records an
-- identity in auth.identities; only that identity is trusted here. The iD is
-- copied onto the profile with the time it was verified. Clients still cannot
-- write orcid_id or orcid_verified_at (see the column grants in the profiles
-- migration), so the only way to become a verified ORCID researcher is to
-- authenticate with ORCID.

alter table public.profiles
  add column orcid_verified_at timestamptz;

comment on column public.profiles.orcid_verified_at is
  'When ORCID itself authenticated this iD for the user. Null means not verified.';

-- ORCID sign-ups carry a name but never an email address.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(meta ->> 'display_name'), ''),
        nullif(btrim(meta ->> 'full_name'), ''),
        nullif(btrim(meta ->> 'name'), ''),
        nullif(btrim(concat_ws(' ', meta ->> 'given_name', meta ->> 'family_name')), ''),
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

create or replace function public.handle_orcid_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  orcid text;
begin
  if new.provider not in ('custom:orcid', 'orcid') then
    return new;
  end if;

  orcid := regexp_replace(
    coalesce(nullif(new.identity_data ->> 'sub', ''), new.provider_id),
    '^https?://(sandbox\.)?orcid\.org/', ''
  );
  if orcid !~ '^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$' then
    raise warning 'ORCID identity for user % has an unexpected iD format; not recorded', new.user_id;
    return new;
  end if;

  begin
    update public.profiles
       set orcid_id = orcid,
           orcid_verified_at = coalesce(orcid_verified_at, now())
     where id = new.user_id;
  exception when unique_violation then
    -- The iD is already verified on another account. Never block sign-in over it.
    raise warning 'ORCID iD already recorded on another profile; not copied to user %', new.user_id;
  end;
  return new;
end;
$$;

revoke execute on function public.handle_orcid_identity() from public, anon, authenticated;

create trigger on_auth_identity_orcid
  after insert or update of identity_data on auth.identities
  for each row execute function public.handle_orcid_identity();
