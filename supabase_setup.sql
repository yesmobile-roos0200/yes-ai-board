-- ============================================================
--  예스AI 공용 게시판 · Supabase 설정 SQL
--  Supabase Dashboard → SQL Editor → New query → 전체 붙여넣기 → Run
--  여러 번 실행해도 안전합니다 (idempotent).
--
--  실행 전에 아래 ①번의 이메일만 본인 것으로 바꿔 주세요.
--  이 SQL은 기존 테이블(used_stock, used_stock_meta, current_status)은
--  건드리지 않고 새 테이블 3개만 추가합니다.
-- ============================================================

-- ------------------------------------------------------------
-- ① 접근 허용 이메일 목록 (여기 있는 계정만 읽고 쓸 수 있음)
--    'me@example.com' 을 본인 이메일로 바꾼 뒤 실행하세요.
-- ------------------------------------------------------------
create table if not exists public.ai_board_members (
  email      text primary key,
  created_at timestamptz not null default now()
);

insert into public.ai_board_members (email)
values (lower('me@example.com'))
on conflict (email) do nothing;

-- ------------------------------------------------------------
-- ② 게시글
-- ------------------------------------------------------------
create table if not exists public.ai_board_posts (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid(),
  category   text not null,
  author     text not null,
  title      text not null,
  content    text not null default '',
  is_pinned  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- ③ 댓글 (글 지우면 댓글도 함께 삭제)
-- ------------------------------------------------------------
create table if not exists public.ai_board_comments (
  id         bigserial primary key,
  post_id    bigint not null references public.ai_board_posts(id) on delete cascade,
  user_id    uuid not null default auth.uid(),
  author     text not null,
  content    text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- ④ 인덱스
-- ------------------------------------------------------------
create index if not exists ai_board_posts_created_idx  on public.ai_board_posts (created_at desc);
create index if not exists ai_board_posts_category_idx on public.ai_board_posts (category);
create index if not exists ai_board_posts_pinned_idx   on public.ai_board_posts (is_pinned desc, created_at desc);
create index if not exists ai_board_comments_post_idx  on public.ai_board_comments (post_id, created_at);

-- ------------------------------------------------------------
-- ⑤ 트리거: user_id 강제 · updated_at 자동 갱신
-- ------------------------------------------------------------
create or replace function public.ai_board_set_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ai_board_posts_user on public.ai_board_posts;
create trigger trg_ai_board_posts_user
before insert on public.ai_board_posts
for each row execute function public.ai_board_set_user_id();

drop trigger if exists trg_ai_board_comments_user on public.ai_board_comments;
create trigger trg_ai_board_comments_user
before insert on public.ai_board_comments
for each row execute function public.ai_board_set_user_id();

create or replace function public.ai_board_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ai_board_posts_touch on public.ai_board_posts;
create trigger trg_ai_board_posts_touch
before update on public.ai_board_posts
for each row execute function public.ai_board_touch_updated_at();

-- ------------------------------------------------------------
-- ⑥ 허용 목록 확인 함수 (앱이 로그인 직후 호출)
-- ------------------------------------------------------------
create or replace function public.ai_board_is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ai_board_members m
    where m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.ai_board_whoami()
returns table (email text, is_member boolean)
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) as email,
         public.ai_board_is_member() as is_member;
$$;

revoke all on function public.ai_board_is_member() from public;
revoke all on function public.ai_board_whoami() from public;
grant execute on function public.ai_board_is_member() to authenticated;
grant execute on function public.ai_board_whoami() to authenticated;

-- ------------------------------------------------------------
-- ⑦ RLS 활성화 + 권한
-- ------------------------------------------------------------
alter table public.ai_board_posts    enable row level security;
alter table public.ai_board_comments enable row level security;
alter table public.ai_board_members  enable row level security;

grant select, insert, update, delete on public.ai_board_posts    to authenticated;
grant select, insert, update, delete on public.ai_board_comments to authenticated;
grant usage, select on sequence public.ai_board_posts_id_seq    to authenticated;
grant usage, select on sequence public.ai_board_comments_id_seq to authenticated;

-- 허용 목록 테이블은 앱에서 직접 읽지 못하게 막습니다 (함수로만 확인).
revoke all on public.ai_board_members from anon, authenticated;

-- 로그인 안 한 방문자(anon)는 아무 권한도 없음
revoke all on public.ai_board_posts    from anon;
revoke all on public.ai_board_comments from anon;

-- ------------------------------------------------------------
-- ⑧ 정책 (허용된 계정만 / 수정·삭제는 자기 글만)
-- ------------------------------------------------------------
drop policy if exists ai_board_posts_select on public.ai_board_posts;
create policy ai_board_posts_select on public.ai_board_posts
  for select to authenticated
  using (public.ai_board_is_member());

drop policy if exists ai_board_posts_insert on public.ai_board_posts;
create policy ai_board_posts_insert on public.ai_board_posts
  for insert to authenticated
  with check (public.ai_board_is_member() and user_id = auth.uid());

drop policy if exists ai_board_posts_update on public.ai_board_posts;
create policy ai_board_posts_update on public.ai_board_posts
  for update to authenticated
  using (public.ai_board_is_member() and user_id = auth.uid())
  with check (public.ai_board_is_member() and user_id = auth.uid());

drop policy if exists ai_board_posts_delete on public.ai_board_posts;
create policy ai_board_posts_delete on public.ai_board_posts
  for delete to authenticated
  using (public.ai_board_is_member() and user_id = auth.uid());

drop policy if exists ai_board_comments_select on public.ai_board_comments;
create policy ai_board_comments_select on public.ai_board_comments
  for select to authenticated
  using (public.ai_board_is_member());

drop policy if exists ai_board_comments_insert on public.ai_board_comments;
create policy ai_board_comments_insert on public.ai_board_comments
  for insert to authenticated
  with check (public.ai_board_is_member() and user_id = auth.uid());

drop policy if exists ai_board_comments_update on public.ai_board_comments;
create policy ai_board_comments_update on public.ai_board_comments
  for update to authenticated
  using (public.ai_board_is_member() and user_id = auth.uid())
  with check (public.ai_board_is_member() and user_id = auth.uid());

drop policy if exists ai_board_comments_delete on public.ai_board_comments;
create policy ai_board_comments_delete on public.ai_board_comments
  for delete to authenticated
  using (public.ai_board_is_member() and user_id = auth.uid());

-- ------------------------------------------------------------
-- ⑧-2 대시보드 2단계 칸 (2026-11-27 추가) — 상태·중요도·담당·기한
--      모두 비워도 됨. 기존 글에 영향 없음. 여러 번 실행해도 안전.
-- ------------------------------------------------------------
alter table public.ai_board_posts
  add column if not exists status   text,
  add column if not exists priority smallint,
  add column if not exists owner    text,
  add column if not exists due_date date;

do $
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_board_posts_status_chk') then
    alter table public.ai_board_posts add constraint ai_board_posts_status_chk
      check (status is null or status in ('진행', '결정필요', '완료', '보류'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_board_posts_priority_chk') then
    alter table public.ai_board_posts add constraint ai_board_posts_priority_chk
      check (priority is null or priority between 1 and 3);
  end if;
end $;

create index if not exists ai_board_posts_status_idx on public.ai_board_posts (status, due_date);

-- ------------------------------------------------------------
-- ⑨ 확인용 (선택) — 실행하면 지금 상태를 보여 줍니다
-- ------------------------------------------------------------
select
  (select count(*) from public.ai_board_members)  as 허용된_계정수,
  (select count(*) from public.ai_board_posts)    as 글수,
  (select count(*) from public.ai_board_comments) as 댓글수;
