-- Template Maker: cloud storage schema for Supabase.
-- Run once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- Every user can only see and change their own templates (Row Level Security).

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Untitled',
  width integer not null,
  height integer not null,
  objects jsonb not null default '[]'::jsonb, -- Fabric.js text objects
  thumbnail text,                              -- small JPEG data URL for the Open dialog
  background_path text,                        -- storage path of the cleaned background
  original_path text,                          -- storage path of the untouched photo
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists templates_user_updated on public.templates (user_id, updated_at desc);

alter table public.templates enable row level security;

drop policy if exists "templates: read own" on public.templates;
drop policy if exists "templates: insert own" on public.templates;
drop policy if exists "templates: update own" on public.templates;
drop policy if exists "templates: delete own" on public.templates;
create policy "templates: read own" on public.templates
  for select to authenticated using (user_id = auth.uid());
create policy "templates: insert own" on public.templates
  for insert to authenticated with check (user_id = auth.uid());
create policy "templates: update own" on public.templates
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "templates: delete own" on public.templates
  for delete to authenticated using (user_id = auth.uid());

-- Private bucket for images. Files live under <user id>/<template id>/.
insert into storage.buckets (id, name, public)
values ('template-assets', 'template-assets', false)
on conflict (id) do nothing;

drop policy if exists "template-assets: read own" on storage.objects;
drop policy if exists "template-assets: insert own" on storage.objects;
drop policy if exists "template-assets: update own" on storage.objects;
drop policy if exists "template-assets: delete own" on storage.objects;
create policy "template-assets: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'template-assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "template-assets: insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'template-assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "template-assets: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'template-assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "template-assets: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'template-assets' and (storage.foldername(name))[1] = auth.uid()::text);
