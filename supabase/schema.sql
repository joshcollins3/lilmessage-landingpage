-- Lil Message forum schema. Run once in the Supabase SQL Editor.
--
-- Security model: the website only holds the public "anon" key, so everything
-- has to be enforced here. Visitors can read boards, threads, replies and
-- usernames. Every write goes through a function below, which checks who is
-- calling, whether they're banned, and how fast they're posting. Nobody gets
-- direct write access to a table.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Tables ---------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  is_admin boolean not null default false,
  banned_at timestamptz,
  accepted_terms_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index profiles_username_unique on public.profiles (lower(username));

create table public.boards (
  id smallint generated always as identity primary key,
  slug text not null unique,
  name text not null,
  description text not null,
  cover text,
  sort smallint not null
);

create table public.threads (
  id bigint generated always as identity primary key,
  board_id smallint not null references public.boards (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index threads_board_idx on public.threads (board_id);
create index threads_author_created_idx on public.threads (author_id, created_at);

create table public.posts (
  id bigint generated always as identity primary key,
  thread_id bigint not null references public.threads (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index posts_thread_created_idx on public.posts (thread_id, created_at);
create index posts_author_created_idx on public.posts (author_id, created_at);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  thread_id bigint references public.threads (id) on delete cascade,
  post_id bigint references public.posts (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  check (num_nonnulls(thread_id, post_id) = 1),
  unique (reporter_id, thread_id),
  unique (reporter_id, post_id)
);
create index reports_thread_idx on public.reports (thread_id);
create index reports_post_idx on public.reports (post_id);

insert into public.boards (slug, name, description, cover, sort) values
  ('general', 'General', 'Anything and everything.', null, 0),
  ('clearer-lens', 'Clearer Lens', 'Seven songs about splitting in half and learning to see straight.', 'clearer-lens.jpg', 1),
  ('reconstruction', 'Reconstruction', 'Rebuilding a self after it was taken apart.', 'reconstruction.jpg', 2),
  ('cultivation-of-self', 'Cultivation of Self', 'Inheritance, language, reclamation, becoming.', 'cultivation-of-self.jpg', 3),
  ('lesion', 'Lesion', 'Medication, neurology, surveillance, and being legible.', 'lesion.jpg', 4),
  ('breathe', 'Breathe', 'Breaking illusions, cutting wires, finding space.', 'breathe.jpg', 5),
  ('the-digital-panopticon', 'The Digital Panopticon', 'Surveillance, control, and the illusion of freedom.', 'the-digital-panopticon.jpg', 6),
  ('the-message-of-the-real-you', 'The Message of the Real You', 'Memory, truth, identity, and becoming the real you.', 'the-message-of-the-real-you.jpg', 7),
  ('deliverance', 'Deliverance', 'From Sunday School to Deliverance.', 'deliverance.jpg', 8),
  ('a-cult-classic', 'A Cult Classic', 'Where it all began.', 'album-cover.jpg', 9);

-- Read access ----------------------------------------------------------------

create view public.thread_summaries with (security_invoker = true) as
  select
    t.id, t.board_id, t.title, t.created_at,
    b.slug as board_slug, b.name as board_name,
    p.username as author,
    (select count(*) from public.posts r where r.thread_id = t.id) as reply_count,
    greatest(t.created_at, (select max(r.created_at) from public.posts r where r.thread_id = t.id)) as last_activity
  from public.threads t
  join public.boards b on b.id = t.board_id
  join public.profiles p on p.id = t.author_id;

create view public.board_summaries with (security_invoker = true) as
  select
    b.id, b.slug, b.name, b.description, b.cover, b.sort,
    (select count(*) from public.threads t where t.board_id = b.id) as thread_count
  from public.boards b;

alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.threads enable row level security;
alter table public.posts enable row level security;
alter table public.reports enable row level security;

create policy "public read" on public.profiles for select using (true);
create policy "public read" on public.boards for select using (true);
create policy "public read" on public.threads for select using (true);
create policy "public read" on public.posts for select using (true);
-- reports has no policy on purpose: only admin_reports() below can read it.

-- Supabase grants everything to these roles by default, so start from nothing.
revoke all on all tables in schema public from anon, authenticated;
grant select (id, username, is_admin, banned_at, created_at) on public.profiles to anon, authenticated;
grant select on public.boards, public.threads, public.posts,
  public.thread_summaries, public.board_summaries to anon, authenticated;

-- Internal helpers -----------------------------------------------------------

-- Returns the caller's id, or stops them if they can't post right now. The lock
-- makes simultaneous requests from one person queue, so they can't slip past
-- the rate limits by firing in parallel.
create function private.require_active_user() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  banned timestamptz;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  select banned_at into banned from public.profiles where id = uid;
  if not found then
    raise exception 'Choose a username first.' using errcode = 'P0001';
  end if;
  if banned is not null then
    raise exception 'This account has been banned.' using errcode = 'P0001';
  end if;
  return uid;
end $$;

create function private.require_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_active_user();
begin
  if not exists (select 1 from public.profiles where id = uid and is_admin) then
    raise exception 'Admins only.' using errcode = 'P0001';
  end if;
  return uid;
end $$;

create function private.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

-- Writes ---------------------------------------------------------------------

create function public.claim_username(new_username text, accepted_terms boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  squashed text := lower(replace(coalesce(new_username, ''), '_', ''));
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = 'P0001';
  end if;
  if not coalesce(accepted_terms, false) then
    raise exception 'You need to accept the rules to join.' using errcode = 'P0001';
  end if;
  if coalesce(new_username, '') !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Usernames are 3 to 20 letters, numbers or underscores.' using errcode = 'P0001';
  end if;
  if squashed like '%lilmessage%' or squashed like '%admin%' or squashed like '%moderator%'
     or squashed in ('mod', 'mods', 'staff', 'support', 'official', 'deleted') then
    raise exception 'That username is reserved.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where id = uid) then
    raise exception 'You already have a username.' using errcode = 'P0001';
  end if;
  insert into public.profiles (id, username, accepted_terms_at) values (uid, new_username, now());
exception
  when unique_violation then
    raise exception 'That username is taken.' using errcode = 'P0001';
end $$;

create function public.create_thread(board smallint, new_title text, new_body text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_active_user();
  clean_title text := btrim(coalesce(new_title, ''));
  clean_body text := btrim(coalesce(new_body, ''));
  new_id bigint;
begin
  if char_length(clean_title) not between 3 and 120 then
    raise exception 'Titles are 3 to 120 characters.' using errcode = 'P0001';
  end if;
  if char_length(clean_body) not between 1 and 10000 then
    raise exception 'Posts are 1 to 10,000 characters.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.threads
      where author_id = uid and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You can start 5 threads an hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.threads (board_id, author_id, title, body)
    values (board, uid, clean_title, clean_body) returning id into new_id;
  return new_id;
end $$;

create function public.create_post(thread bigint, new_body text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_active_user();
  clean_body text := btrim(coalesce(new_body, ''));
  new_id bigint;
begin
  if char_length(clean_body) not between 1 and 10000 then
    raise exception 'Posts are 1 to 10,000 characters.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.posts
      where author_id = uid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'You can post 10 replies every 10 minutes. Try again shortly.' using errcode = 'P0001';
  end if;
  insert into public.posts (thread_id, author_id, body)
    values (thread, uid, clean_body) returning id into new_id;
  return new_id;
end $$;

-- Deleting doesn't require an active account: people who were banned can still
-- remove their own words.
create function public.delete_thread(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  delete from public.threads
    where id = target and (author_id = uid or private.is_admin(uid));
  if not found then
    raise exception 'You can''t delete that.' using errcode = 'P0001';
  end if;
end $$;

create function public.delete_post(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  delete from public.posts
    where id = target and (author_id = uid or private.is_admin(uid));
  if not found then
    raise exception 'You can''t delete that.' using errcode = 'P0001';
  end if;
end $$;

create function public.report_content(thread bigint, post bigint, new_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_active_user();
  clean_reason text := btrim(coalesce(new_reason, ''));
begin
  if char_length(clean_reason) not between 1 and 500 then
    raise exception 'Reasons are 1 to 500 characters.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.reports
      where reporter_id = uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You can send 10 reports an hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.reports (reporter_id, thread_id, post_id, reason)
    values (uid, thread, post, clean_reason)
    on conflict do nothing;
end $$;

-- Removes the person's sign-in and, through the cascades above, their profile,
-- threads (including other people's replies to them), replies and reports.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = 'P0001';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Moderation -----------------------------------------------------------------

create function public.admin_reports()
returns table (
  id bigint, reason text, created_at timestamptz, reporter text,
  thread_id bigint, post_id bigint, excerpt text, author text, author_id uuid
)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
    select
      r.id, r.reason, r.created_at, reporter.username,
      coalesce(r.thread_id, p.thread_id), r.post_id,
      left(coalesce(p.body, t.title || E'\n' || t.body), 400),
      author.username, author.id
    from public.reports r
    join public.profiles reporter on reporter.id = r.reporter_id
    left join public.threads t on t.id = r.thread_id
    left join public.posts p on p.id = r.post_id
    join public.profiles author on author.id = coalesce(p.author_id, t.author_id)
    order by r.created_at;
end $$;

create function public.dismiss_report(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  delete from public.reports where id = target;
end $$;

create function public.ban_user(target uuid, remove_content boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if private.is_admin(target) then
    raise exception 'Admins can''t be banned.' using errcode = 'P0001';
  end if;
  update public.profiles set banned_at = now() where id = target;
  if remove_content then
    delete from public.threads where author_id = target;
    delete from public.posts where author_id = target;
  end if;
end $$;

create function public.unban_user(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.profiles set banned_at = null where id = target;
end $$;

-- Only signed-in people can call these, and each one still checks permissions.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function
  public.claim_username(text, boolean),
  public.create_thread(smallint, text, text),
  public.create_post(bigint, text),
  public.delete_thread(bigint),
  public.delete_post(bigint),
  public.report_content(bigint, bigint, text),
  public.delete_my_account(),
  public.admin_reports(),
  public.dismiss_report(bigint),
  public.ban_user(uuid, boolean),
  public.unban_user(uuid)
from public, anon;
grant execute on function
  public.claim_username(text, boolean),
  public.create_thread(smallint, text, text),
  public.create_post(bigint, text),
  public.delete_thread(bigint),
  public.delete_post(bigint),
  public.report_content(bigint, bigint, text),
  public.delete_my_account(),
  public.admin_reports(),
  public.dismiss_report(bigint),
  public.ban_user(uuid, boolean),
  public.unban_user(uuid)
to authenticated;
