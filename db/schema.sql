-- ============================================================
-- DAY7 サッカー出欠管理：データベースの設計図
--
-- Supabase の SQL Editor にこのファイルの中身を丸ごと貼って
-- 「Run」を押してください。何度貼っても壊れないように書いてあります。
--
-- 【この設計のいちばん大事な考え方】
--   テーブルには誰も直接触れません。
--   RLS（行レベルセキュリティ）を全テーブルで ON にして、
--   許可ルールをひとつも書いていません。＝ anon キーでは何も読めない・書けない。
--   読み書きはすべて、下の方にある「関数」だけを窓口にして通します。
--   関数はトークン（個人リンクに埋まっている合言葉）を必ず確かめます。
--   だから、リンクを持っている本人は自分の欄しか動かせません。
-- ============================================================


-- ============================================================
-- 1. テーブル
-- ============================================================

-- チームの設定。1行だけ入る。
create table if not exists team_config (
  id          int  primary key default 1,
  team_name   text not null default 'わがチーム',
  admin_token text not null,
  constraint team_config_single_row check (id = 1)
);

-- メンバー名簿。token が「その人だけの合言葉」。
create table if not exists members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  number     text,                                  -- 背番号。文字列にしておくと "7" も "GK" も入る
  token      text not null unique,
  active     boolean not null default true,         -- false にすると休会（過去の記録は残る）
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 試合・練習の予定。
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  event_date date not null,
  start_time time,                                  -- 未定なら空でよい
  kind       text not null default 'practice' check (kind in ('match','practice')),
  place      text,
  note       text,                                  -- 対戦相手・持ち物など
  created_at timestamptz not null default now()
);

-- 出欠の回答。
-- 「未回答」は行が無い状態で表します。行を消せば未回答に戻ります。
create table if not exists attendance (
  event_id   uuid not null references events(id)  on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  status     text not null check (status in ('yes','no')),
  updated_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

create index if not exists attendance_event_idx on attendance(event_id);

-- Google アカウントとの紐付け先。null なら「まだログインしていない人」。
-- 既にデータが入っていても壊れないよう、後から足せる形にしてある。
alter table members add column if not exists auth_user_id uuid;
create unique index if not exists members_auth_user_idx on members(auth_user_id);

-- 名簿に載せる Google アカウントのメールアドレス。
-- ここが埋まっている人は、ログインするだけで自動的に本人と分かる。
-- 招待リンクも合言葉も要らない。
alter table members add column if not exists email text;
create unique index if not exists members_email_idx on members(lower(email));

-- 予定ごとに「車を出せるか」も聞くかどうか。
-- スプレッドシートでも、聞く回と聞かない回がある。
alter table events add column if not exists asks_car boolean not null default true;

-- 車を出せるかの回答。null は未回答。
alter table attendance add column if not exists car text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_car_check') then
    alter table attendance add constraint attendance_car_check check (car in ('yes','no'));
  end if;
end $$;

-- チーム共通の合言葉（6桁）。メールが名簿に無い人が、自分の名前を選ぶときに使う。
alter table team_config add column if not exists join_code text;
update team_config
   set join_code = lpad((floor(random() * 1000000))::int::text, 6, '0')
 where id = 1 and join_code is null;
create index if not exists events_date_idx      on events(event_date);


-- ============================================================
-- 2. 鍵を全部かける（RLS）
--
-- enable した上でポリシーを1つも書かない＝ anon キーからは何も見えない。
-- ここを忘れると、リンクを知らない人でも全データを読み書きできてしまいます。
-- 今日いちばん大事な4行です。
-- ============================================================

alter table team_config enable row level security;
alter table members     enable row level security;
alter table events      enable row level security;
alter table attendance  enable row level security;


-- ============================================================
-- 3. 最初の1行（チーム設定）を作る
--    admin_token は管理用リンクに入る合言葉。ここで自動生成します。
-- ============================================================

insert into team_config (id, team_name, admin_token)
values (1, 'わがチーム', replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;


-- ============================================================
-- 4. 窓口になる関数
--
--  security definer = 「関数の持ち主の権限で動く」。だから RLS を越えてテーブルを読める。
--  set search_path  = 関数が変なテーブルを掴まされないようにする安全対策。おまじないと思ってOK。
-- ============================================================

-- ---- 内部用：トークンからメンバーを引く。無ければエラー ----
create or replace function app_member_of(p_token text)
returns members
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  select * into v_member from members where token = p_token and active;
  if not found then
    raise exception 'リンクが正しくありません' using errcode = '28000';
  end if;
  -- 一度ログインして名簿と結びついた人の招待リンクは、そこで役目を終える。
  -- 転送された古いリンクでは入れない。
  if v_member.auth_user_id is not null then
    raise exception 'この招待リンクは使用済みです。ログインして開いてください' using errcode = '28000';
  end if;
  return v_member;
end;
$$;

-- ---- 内部用：ログイン中の人のメールアドレス ----
-- Supabase は auth.users に本人のメールを持っている。
create or replace function app_auth_email()
returns text
language sql stable security definer set search_path = public, auth, pg_temp
as $$
  select lower(u.email) from auth.users u where u.id = auth.uid()
$$;

-- ---- 内部用：ログイン中の Google アカウントから名簿を引く ----
-- auth.uid() は Supabase が用意する「いま誰がログインしているか」を返す関数。
-- 名簿にメールが載っている人は、ログインした時点で自動的に結びつける。
-- 書き込みをするので stable にはできない。
create or replace function app_member_of_auth()
returns members
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_member members;
  v_email  text;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません' using errcode = '28000';
  end if;

  -- すでに結びついている
  select * into v_member from members where auth_user_id = auth.uid() and active;
  if found then
    return v_member;
  end if;

  -- 名簿にこのメールが載っていれば、その場で結びつける
  v_email := app_auth_email();
  if v_email is not null and v_email <> '' then
    select * into v_member
      from members
     where lower(email) = v_email and auth_user_id is null and active
       for update;
    if found then
      update members set auth_user_id = auth.uid()
       where id = v_member.id
      returning * into v_member;
      return v_member;
    end if;
  end if;

  raise exception 'このアカウントはまだ名簿と結びついていません' using errcode = '28000';
end;
$$;

-- ---- 内部用：管理トークンの確認 ----
create or replace function app_check_admin(p_admin text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from team_config where id = 1 and admin_token = p_admin) then
    raise exception '管理用リンクが正しくありません' using errcode = '28000';
  end if;
end;
$$;

-- ---- 内部用：予定1件を集計つきの JSON にする ----
create or replace function app_event_json(p_event events, p_member_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',         p_event.id,
    'date',       p_event.event_date,
    'start_time', p_event.start_time,
    'kind',       p_event.kind,
    'place',      p_event.place,
    'note',       p_event.note,
    'asks_car',   p_event.asks_car,
    'my_status',  (select a.status from attendance a
                    where a.event_id = p_event.id and a.member_id = p_member_id),
    'my_car',     (select a.car from attendance a
                    where a.event_id = p_event.id and a.member_id = p_member_id),
    'yes_count',  (select count(*) from attendance a join members m on m.id = a.member_id
                    where a.event_id = p_event.id and a.status = 'yes' and m.active),
    'no_count',   (select count(*) from attendance a join members m on m.id = a.member_id
                    where a.event_id = p_event.id and a.status = 'no'  and m.active),
    'car_count',  (select count(*) from attendance a join members m on m.id = a.member_id
                    where a.event_id = p_event.id and a.car = 'yes' and m.active)
  );
$$;


-- ============================================================
-- 4-1. メンバー用の関数
-- ============================================================

-- ---- 内部用：ホーム画面の中身。窓口が2つ（招待リンク／ログイン）あるので切り出す ----
create or replace function app_home_json(v_member members)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  return jsonb_build_object(
    'team',         (select team_name from team_config where id = 1),
    'me',           jsonb_build_object('id', v_member.id, 'name', v_member.name,
                      'number', v_member.number, 'linked', v_member.auth_user_id is not null),
    'member_count', (select count(*) from members where active),
    'events', coalesce((
      select jsonb_agg(app_event_json(e, v_member.id) order by e.event_date, e.start_time nulls last)
      from events e
      where e.event_date >= v_today
    ), '[]'::jsonb),
    'past', coalesce((
      select jsonb_agg(app_event_json(e, v_member.id) order by e.event_date desc)
      from events e
      where e.event_date < v_today
    ), '[]'::jsonb)
  );
end;
$$;

-- 招待リンクを開いたときに呼ぶ（まだログインしていない人）。
create or replace function member_home(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  return app_home_json(app_member_of(p_token));
end;
$$;

-- ログイン済みの人が開いたときに呼ぶ。引数は要らない。誰かは auth.uid() が知っている。
create or replace function me_home()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return app_home_json(app_member_of_auth());
end;
$$;

-- 出席・欠席を答える。p_status に null を渡すと未回答に戻る。
-- p_car は「車を出せるか」。引数を増やしたので、古い形は先に消す。
drop function if exists set_status(text, uuid, text);
create or replace function set_status(p_token text, p_event_id uuid, p_status text,
                                      p_car text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  v_member := app_member_of(p_token);

  if p_car is not null and p_car not in ('yes','no') then
    raise exception '車の値が不正です';
  end if;

  if p_status is null then
    delete from attendance where event_id = p_event_id and member_id = v_member.id;
  elsif p_status in ('yes','no') then
    insert into attendance (event_id, member_id, status, car, updated_at)
    values (p_event_id, v_member.id, p_status, p_car, now())
    on conflict (event_id, member_id)
      do update set status = excluded.status, car = excluded.car, updated_at = now();
  else
    raise exception '出欠の値が不正です';
  end if;

  return member_home(p_token);
end;
$$;

-- 予定を開いたときに「誰が出席で誰が未回答か」を見る。
create or replace function event_detail(p_token text, p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app_member_of(p_token);

  return jsonb_build_object(
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'number', m.number,
               'status', (select a.status from attendance a
                           where a.event_id = p_event_id and a.member_id = m.id),
               'car', (select a.car from attendance a
                        where a.event_id = p_event_id and a.member_id = m.id))
             order by m.sort_order, m.name)
      from members m where m.active
    ), '[]'::jsonb)
  );
end;
$$;


-- 招待リンクを、いまログインしている Google アカウントに結びつける。
-- これが「一度きりの招待状」の実体。成功するとホーム画面の中身が返る。
create or replace function claim_member(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  if auth.uid() is null then
    raise exception 'ログインしてから招待リンクを開いてください' using errcode = '28000';
  end if;

  -- for update で行を押さえる。押さえないと、同じ招待リンクを2人が同時に開いたとき
  -- 双方が「まだ空いている」と判断して、後から書いた方が席を奪える。
  select * into v_member from members where token = p_token and active for update;
  if not found then
    raise exception '招待リンクが正しくありません' using errcode = '28000';
  end if;

  -- 他人が使い終わった招待リンクは受け付けない
  if v_member.auth_user_id is not null and v_member.auth_user_id <> auth.uid() then
    raise exception 'この招待リンクは既に使われています' using errcode = '28000';
  end if;

  -- 同じアカウントが二人分の席を持たないようにする
  if exists (select 1 from members m where m.auth_user_id = auth.uid() and m.id <> v_member.id) then
    raise exception 'このアカウントは既に別のメンバーとして登録されています' using errcode = '28000';
  end if;

  update members set auth_user_id = auth.uid() where id = v_member.id
    returning * into v_member;

  return app_home_json(v_member);
end;
$$;

-- 合言葉を入れて、まだ誰にも結びついていない名簿の一覧を見る。
-- ログインしている人にしか返さない。
create or replace function roster_by_code(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください' using errcode = '28000';
  end if;
  if p_code is null or p_code <> (select join_code from team_config where id = 1) then
    raise exception '合言葉が違います' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'team', (select team_name from team_config where id = 1),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'number', m.number)
             order by m.sort_order, m.name)
      from members m where m.active and m.auth_user_id is null
    ), '[]'::jsonb));
end;
$$;

-- 合言葉つきで、名簿の自分を選んで結びつける。
create or replace function claim_member_by_code(p_code text, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください' using errcode = '28000';
  end if;
  if p_code is null or p_code <> (select join_code from team_config where id = 1) then
    raise exception '合言葉が違います' using errcode = '28000';
  end if;

  select * into v_member from members where id = p_member_id and active for update;
  if not found then
    raise exception 'その人は名簿にいません' using errcode = '28000';
  end if;
  if v_member.auth_user_id is not null then
    raise exception 'その人は既に登録済みです' using errcode = '28000';
  end if;
  if exists (select 1 from members m where m.auth_user_id = auth.uid()) then
    raise exception 'このアカウントは既に別のメンバーとして登録されています' using errcode = '28000';
  end if;

  update members
     set auth_user_id = auth.uid(),
         email = coalesce(email, app_auth_email())
   where id = v_member.id
  returning * into v_member;

  return app_home_json(v_member);
end;
$$;

-- 出席・欠席を答える（ログイン済み）。null を渡すと未回答に戻る。
drop function if exists me_set_status(uuid, text);
create or replace function me_set_status(p_event_id uuid, p_status text,
                                         p_car text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  v_member := app_member_of_auth();

  if p_car is not null and p_car not in ('yes','no') then
    raise exception '車の値が不正です';
  end if;

  if p_status is null then
    delete from attendance where event_id = p_event_id and member_id = v_member.id;
  elsif p_status in ('yes','no') then
    insert into attendance (event_id, member_id, status, car, updated_at)
    values (p_event_id, v_member.id, p_status, p_car, now())
    on conflict (event_id, member_id)
      do update set status = excluded.status, car = excluded.car, updated_at = now();
  else
    raise exception '出欠の値が不正です';
  end if;

  return app_home_json(v_member);
end;
$$;

-- 予定を開いたときに「誰が出席で誰が未回答か」を見る（ログイン済み）。
create or replace function me_event_detail(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_member_of_auth();

  return jsonb_build_object(
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'number', m.number,
               'status', (select a.status from attendance a
                           where a.event_id = p_event_id and a.member_id = m.id),
               'car', (select a.car from attendance a
                        where a.event_id = p_event_id and a.member_id = m.id))
             order by m.sort_order, m.name)
      from members m where m.active
    ), '[]'::jsonb)
  );
end;
$$;

-- 自分の表示名を変える。実名で運用するので、表記のゆれは本人が直せる方がよい。
create or replace function me_set_name(p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_member members;
  v_name   text := btrim(coalesce(p_name, ''));
begin
  v_member := app_member_of_auth();

  if v_name = '' then
    raise exception '名前を入力してください';
  end if;
  if length(v_name) > 40 then
    raise exception '名前が長すぎます（40文字まで）';
  end if;

  update members set name = v_name where id = v_member.id
    returning * into v_member;

  return app_home_json(v_member);
end;
$$;


-- ============================================================
-- 4-2. 管理用の関数（すべて管理トークンを確かめる）
-- ============================================================

create or replace function admin_home(p_admin text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  perform app_check_admin(p_admin);

  return jsonb_build_object(
    'team', (select team_name from team_config where id = 1),
    'join_code', (select join_code from team_config where id = 1),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'number', m.number,
               'active', m.active, 'token', m.token, 'sort_order', m.sort_order,
               'linked', m.auth_user_id is not null, 'email', m.email)
             order by m.sort_order, m.name)
      from members m
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'date', e.event_date, 'start_time', e.start_time,
               'kind', e.kind, 'place', e.place, 'note', e.note,
               'asks_car', e.asks_car,
               'yes_count', (select count(*) from attendance a join members m on m.id = a.member_id
                              where a.event_id = e.id and a.status = 'yes' and m.active),
               'no_count',  (select count(*) from attendance a join members m on m.id = a.member_id
                              where a.event_id = e.id and a.status = 'no'  and m.active),
               'car_count', (select count(*) from attendance a join members m on m.id = a.member_id
                              where a.event_id = e.id and a.car = 'yes' and m.active),
               'answers',   (select coalesce(jsonb_object_agg(a.member_id, a.status), '{}'::jsonb)
                              from attendance a where a.event_id = e.id),
               'cars',      (select coalesce(jsonb_object_agg(a.member_id, a.car), '{}'::jsonb)
                              from attendance a where a.event_id = e.id and a.car is not null))
             order by e.event_date desc, e.start_time nulls last)
      from events e
      where e.event_date >= v_today - 90
    ), '[]'::jsonb)
  );
end;
$$;

-- 名簿の一括登録。スプレッドシートから名前を貼り付けて使う。
-- 同じ名前が既にいる場合は飛ばす。
create or replace function admin_add_members(p_admin text, p_names text[])
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name  text;
  v_next  int;
  v_added int := 0;
begin
  perform app_check_admin(p_admin);
  select coalesce(max(sort_order), 0) into v_next from members;

  foreach v_name in array p_names loop
    v_name := btrim(v_name);
    continue when v_name = '';
    continue when exists (select 1 from members m where m.name = v_name);

    v_next := v_next + 1;
    insert into members (name, token, sort_order)
    values (v_name, replace(gen_random_uuid()::text, '-', ''), v_next);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added) || admin_home(p_admin);
end;
$$;

create or replace function admin_update_member(
  p_admin text, p_member_id uuid, p_name text, p_number text, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update members
     set name   = coalesce(nullif(btrim(p_name), ''), name),
         number = nullif(btrim(coalesce(p_number, '')), ''),
         active = coalesce(p_active, active)
   where id = p_member_id;
  return admin_home(p_admin);
end;
$$;

-- 個人リンクが流出したとき用。合言葉を作り直すと、古いリンクは無効になる。
create or replace function admin_reissue_token(p_admin text, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update members set token = replace(gen_random_uuid()::text, '-', '') where id = p_member_id;
  return admin_home(p_admin);
end;
$$;

drop function if exists admin_save_event(text, uuid, date, time, text, text, text);
create or replace function admin_save_event(
  p_admin text, p_event_id uuid, p_date date, p_time time,
  p_kind text, p_place text, p_note text, p_asks_car boolean default true)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);

  if p_kind not in ('match','practice') then
    raise exception '種別は match か practice です';
  end if;

  if p_event_id is null then
    insert into events (event_date, start_time, kind, place, note, asks_car)
    values (p_date, p_time, p_kind, nullif(btrim(coalesce(p_place,'')),''),
            nullif(btrim(coalesce(p_note,'')),''), coalesce(p_asks_car, true));
  else
    update events
       set event_date = p_date, start_time = p_time, kind = p_kind,
           place = nullif(btrim(coalesce(p_place,'')),''),
           note  = nullif(btrim(coalesce(p_note,'')),''),
           asks_car = coalesce(p_asks_car, asks_car)
     where id = p_event_id;
  end if;

  return admin_home(p_admin);
end;
$$;

create or replace function admin_delete_event(p_admin text, p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  delete from events where id = p_event_id;   -- 出欠も一緒に消える（on delete cascade）
  return admin_home(p_admin);
end;
$$;

-- マネージャーによる代理入力。LINEで個別に返事が来たとき用。
drop function if exists admin_set_status(text, uuid, uuid, text);
create or replace function admin_set_status(
  p_admin text, p_event_id uuid, p_member_id uuid, p_status text,
  p_car text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);

  if p_car is not null and p_car not in ('yes','no') then
    raise exception '車の値が不正です';
  end if;

  if p_status is null then
    delete from attendance where event_id = p_event_id and member_id = p_member_id;
  elsif p_status in ('yes','no') then
    insert into attendance (event_id, member_id, status, car, updated_at)
    values (p_event_id, p_member_id, p_status, p_car, now())
    on conflict (event_id, member_id)
      do update set status = excluded.status, car = excluded.car, updated_at = now();
  else
    raise exception '出欠の値が不正です';
  end if;

  return admin_home(p_admin);
end;
$$;

-- 管理用リンクが漏れたとき用。これが無いと Supabase の SQL Editor を開くしかない。
-- 新しいトークンを返すので、押した本人はそのまま新しいURLへ移れる。
create or replace function admin_reissue_admin_token(p_admin text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_new text := replace(gen_random_uuid()::text, '-', '');
begin
  perform app_check_admin(p_admin);
  update team_config set admin_token = v_new where id = 1;
  return jsonb_build_object('admin_token', v_new);
end;
$$;

-- 合言葉を作り直す。漏れたとき用。
create or replace function admin_reissue_join_code(p_admin text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update team_config
     set join_code = lpad((floor(random() * 1000000))::int::text, 6, '0')
   where id = 1;
  return admin_home(p_admin);
end;
$$;

-- 名簿にメールアドレスを登録する。ここが埋まっている人は、
-- ログインするだけで自動的に本人と判別される。
create or replace function admin_set_member_email(p_admin text, p_member_id uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform app_check_admin(p_admin);

  if v_email = '' then
    update members set email = null where id = p_member_id;
    return admin_home(p_admin);
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'メールアドレスの形になっていません: %', v_email;
  end if;
  if exists (select 1 from members m where lower(m.email) = v_email and m.id <> p_member_id) then
    raise exception 'そのメールアドレスは別のメンバーに登録済みです';
  end if;

  update members set email = v_email where id = p_member_id;
  return admin_home(p_admin);
end;
$$;

-- スプレッドシートから「名前<タブ>メール」を貼って一括で取り込む。
-- 既にいる名前は、メールだけ更新する。
create or replace function admin_import_members(p_admin text, p_rows text[])
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row     text;
  v_parts   text[];
  v_name    text;
  v_email   text;
  v_next    int;
  v_added   int := 0;
  v_updated int := 0;
  v_id      uuid;
begin
  perform app_check_admin(p_admin);
  select coalesce(max(sort_order), 0) into v_next from members;

  foreach v_row in array p_rows loop
    v_parts := regexp_split_to_array(v_row, E'[\t,]');
    v_name  := btrim(coalesce(v_parts[1], ''));
    v_email := lower(btrim(coalesce(v_parts[2], '')));
    continue when v_name = '';
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      v_email := null;
    end if;

    select id into v_id from members m where m.name = v_name;
    if found then
      if v_email is not null
         and not exists (select 1 from members x where lower(x.email) = v_email and x.id <> v_id) then
        update members set email = v_email where id = v_id;
        v_updated := v_updated + 1;
      end if;
    else
      if v_email is not null and exists (select 1 from members x where lower(x.email) = v_email) then
        v_email := null;   -- 既に他の人に使われている
      end if;
      v_next := v_next + 1;
      insert into members (name, email, token, sort_order)
      values (v_name, v_email, replace(gen_random_uuid()::text, '-', ''), v_next);
      v_added := v_added + 1;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_updated) || admin_home(p_admin);
end;
$$;

create or replace function admin_rename_team(p_admin text, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update team_config set team_name = coalesce(nullif(btrim(p_name),''), team_name) where id = 1;
  return admin_home(p_admin);
end;
$$;


-- ============================================================
-- 5. 内部用の関数は外から呼べないようにする
-- ============================================================

revoke execute on function app_member_of(text)        from anon, authenticated;
revoke execute on function app_check_admin(text)      from anon, authenticated;
revoke execute on function app_event_json(events,uuid) from anon, authenticated;
revoke execute on function app_member_of_auth()        from anon, authenticated;
revoke execute on function app_home_json(members)      from anon, authenticated;
revoke execute on function app_auth_email()            from anon, authenticated;


-- ============================================================
-- 6. 管理用リンクの合言葉を確認する
--    ここに出た文字列が、あなただけの管理画面の鍵です。
--    admin.html#<この文字列> で管理画面が開きます。人に見せないでください。
-- ============================================================

select admin_token as "管理用トークン（admin.html# のうしろに貼る）" from team_config where id = 1;
