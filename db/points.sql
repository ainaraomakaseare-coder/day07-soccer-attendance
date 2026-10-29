-- access.sql の後に適用。参加費のポイント制（PayPayチャージ→会計係が付与→参加予定で消費）。
-- 残数 = 累計（付与・調整の合計） − 開始日以降のメイン予定で「出席」と回答した数（未来の予定も含む）。
-- 付与・調整は管理者だけ。メンバーは自分の残数・累計の閲覧と追加申請だけ。助っ人は対象外。
alter table team_config add column if not exists points_start date default '2026-12-01';
alter table team_config add column if not exists charge_unit int not null default 2000 check (charge_unit between 1 and 1000000);
alter table events add column if not exists points_target boolean not null default true;
alter table team_ledger add column if not exists charge_member_id uuid references members(id) on delete set null;
alter table team_config add column if not exists charge_points int not null default 11 check (charge_points between 1 and 1000);

create table if not exists team_points (
 id uuid primary key default gen_random_uuid(),
 member_id uuid not null references members(id) on delete cascade,
 delta int not null check (delta between -1000 and 1000 and delta<>0),
 amount int not null default 0 check (amount between 0 and 10000000),
 reason text not null check (length(reason) between 1 and 200),
 request_id uuid, ledger_id uuid,
 created_by text not null default '', created_at timestamptz not null default now()
);
create table if not exists team_point_requests (
 id uuid primary key default gen_random_uuid(),
 member_id uuid not null references members(id) on delete cascade,
 amount int not null check (amount between 1 and 10000000),
 status text not null default 'pending' check (status in ('pending','approved','cancelled')),
 created_at timestamptz not null default now(), resolved_at timestamptz, resolved_by text not null default ''
);
-- 列追加前にボタンから会計へ記録したチャージは、ポイント側の記録から対象メンバーを補う。
update team_ledger l set charge_member_id=p.member_id from team_points p
 where p.ledger_id=l.id and l.charge_member_id is null;
create index if not exists team_points_member_idx on team_points(member_id);
create index if not exists team_point_requests_member_idx on team_point_requests(member_id,status);
alter table team_points enable row level security;
alter table team_point_requests enable row level security;
revoke all on team_points,team_point_requests from public,anon,authenticated;

create or replace function app_member_points(p_member uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare start_date date; total bigint; used bigint;
begin
 select points_start into start_date from team_config where id=1;
 select coalesce(sum(delta),0) into total from team_points where member_id=p_member;
 select count(*) into used from attendance a join events e on e.id=a.event_id
  where a.member_id=p_member and a.status='yes' and e.squad='main' and e.points_target and start_date is not null and e.event_date>=start_date;
 return jsonb_build_object('total',total,'used',used,'remaining',total-used);
end $$;
revoke all on function app_member_points(uuid) from public,anon,authenticated;

-- 開始日以降のメイン予定へ新しく「出席」にするとき、残数が0以下なら拒否する。
-- すでに出席の回答を直す（車・伝達事項の変更など）ときは追加消費がないので通す。
create or replace function app_points_guard(p_member uuid,p_event uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare start_date date; ev events;
begin
 select points_start into start_date from team_config where id=1;
 select * into ev from events where id=p_event;
 if start_date is null or not found or ev.squad<>'main' or not ev.points_target or ev.event_date<start_date then return; end if;
 if exists(select 1 from attendance where member_id=p_member and event_id=p_event and status='yes') then return; end if;
 if (app_member_points(p_member)->>'remaining')::int<=0 then
  raise exception 'ポイント残数が0のため「出席」を選べません。チャージをしてポイントの追加申請をしてください' using errcode='P0001';
 end if;
end $$;
revoke all on function app_points_guard(uuid,uuid) from public,anon,authenticated;

create or replace function app_points_home(p_result jsonb,p_me members,p_admin boolean,p_scope text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg team_config; r jsonb:=p_result;
begin
 if p_scope='junior' then return r; end if;
 select * into cfg from team_config where id=1;
 r:=r||jsonb_build_object('points_start',cfg.points_start,'charge_unit',cfg.charge_unit,'charge_points',cfg.charge_points,'finance',app_finance_summary());
 if p_me.id is not null and r->'me' is not null and jsonb_typeof(r->'me')='object' then
  r:=jsonb_set(r,'{me,points}',app_member_points(p_me.id));
  r:=r||jsonb_build_object('my_point_requests',coalesce((select jsonb_agg(jsonb_build_object('id',id,'amount',amount,'created_at',created_at) order by created_at)
   from team_point_requests where member_id=p_me.id and status='pending'),'[]'::jsonb));
 end if;
 if p_admin is true then
  r:=r||jsonb_build_object(
   'points',coalesce((select jsonb_object_agg(id,app_member_points(id)) from members where squad='main'),'{}'::jsonb),
   'point_requests',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'member_id',q.member_id,'amount',q.amount,'created_at',q.created_at) order by q.created_at)
    from team_point_requests q where q.status='pending'),'[]'::jsonb));
 end if;
 return r;
end $$;
revoke all on function app_points_home(jsonb,members,boolean,text) from public,anon,authenticated;

-- 会計の行にチャージしたメンバーを指定すると、金額に応じてポイントを付与する。
-- 行の修正・削除ではポイントも作り直す（その行に紐づくポイントだけ）。未確定の行は付与しない。
create or replace function app_ledger_charge_sync(p_ledger uuid,p_member uuid,p_request uuid,p_actor text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg team_config; l team_ledger; target members; amt int; q team_point_requests;
begin
 select * into cfg from team_config where id=1;
 select * into l from team_ledger where id=p_ledger;
 if not found then return; end if;
 delete from team_points where ledger_id=p_ledger;
 update team_ledger set charge_member_id=p_member where id=p_ledger;
 if p_member is null then
  if p_request is not null then raise exception 'チャージしたメンバーを選んでください'; end if;
  return;
 end if;
 if l.squad<>'main' then raise exception 'チャージはメイン会計に記録してください'; end if;
 select * into target from members where id=p_member and squad='main' and active;
 if not found then raise exception 'チャージしたメンバーはメインの有効なメンバーを選んでください'; end if;
 amt:=coalesce(l.income,l.fee*l.people);
 if amt<cfg.charge_unit or amt%cfg.charge_unit<>0 or l.expense<>0 then
  raise exception 'チャージの行は、収入を%円単位にして支出を0にしてください',cfg.charge_unit;
 end if;
 if p_request is not null then
  select * into q from team_point_requests where id=p_request and status='pending' for update;
  if not found or q.member_id<>p_member then raise exception '対象の追加申請が見つかりません。更新してください'; end if;
  update team_point_requests set status='approved',resolved_at=now(),resolved_by=p_actor where id=q.id;
 end if;
 if l.planned then return; end if;
 insert into team_points(member_id,delta,amount,reason,request_id,ledger_id,created_by)
  values(p_member,amt/cfg.charge_unit*cfg.charge_points,amt,'チャージ（会計）',q.id,p_ledger,p_actor);
end $$;
revoke all on function app_ledger_charge_sync(uuid,uuid,uuid,text) from public,anon,authenticated;

-- 会計の概要（全員に公開）。明細は管理者だけ。
-- 口座残高 = 開始残高＋確定済みの収入−支出。チャージ残高 = 有効メンバーの未使用ポイントの返金相当額
-- （残数×1回の参加費。ちょうど1回分のチャージ数ならチャージ額）。余剰金 = 口座残高−チャージ残高。
create or replace function app_finance_summary() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cfg team_config; account bigint; charge bigint;
begin
 select * into cfg from team_config where id=1;
 select cfg.main_opening+coalesce(sum(coalesce(income,fee*people)-expense),0) into account from team_ledger where squad='main' and not planned;
 select coalesce(sum(case when r=cfg.charge_points then cfg.charge_unit when r>0 then r*cfg.main_fee else 0 end),0) into charge
  from (select (app_member_points(id)->>'remaining')::int r from members where squad='main' and active) x;
 return jsonb_build_object('account_balance',account,'charge_balance',charge,'surplus',account-charge,'point_value',cfg.main_fee);
end $$;
revoke all on function app_finance_summary() from public,anon,authenticated;

-- ポイント操作の入口。request/cancel_request は本人（取り消しは管理者も）、charge/adjust は管理者だけ。
create or replace function team_points(p_key text,p_admin boolean,p_version bigint,p_actor text,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare me members; cfg team_config; actor_name text; mid uuid; amt int; pts int; q team_point_requests; lid uuid;
 ids uuid[]; d int; why text; target members; n int; jst_today date:=(now() at time zone 'Asia/Tokyo')::date;
begin
 if p_admin is not true and coalesce(p_key,'')<>'' then raise exception 'ポイントはメインのメンバーだけが利用できます' using errcode='42501'; end if;
 perform app_team_access(p_key,p_admin);
 if coalesce(p_key,'')='' then me:=app_main_member(); end if;
 select * into cfg from team_config where id=1 for update;
 if p_version is distinct from cfg.data_version then raise exception '他の人の変更があります。更新してからもう一度入力してください' using errcode='PT409'; end if;
 if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception '入力形式が正しくありません'; end if;
 actor_name:=trim(case when me.id is not null then me.name else p_actor end);
 if actor_name is null or length(actor_name) not between 1 and 80 then raise exception '入力者名を1〜80文字で入力してください'; end if;
 if p_action in ('charge','adjust') and p_admin is not true then raise exception '管理者だけがポイントを付与できます' using errcode='42501'; end if;

 if p_action='request' then
  if me.id is null then raise exception '追加申請は本人がGoogleログインして行ってください' using errcode='42501'; end if;
  amt:=(p_data->>'amount')::int;
  if amt is null or amt<cfg.charge_unit or amt%cfg.charge_unit<>0 or amt>100000 then
   raise exception 'チャージ金額は%円単位で入力してください',cfg.charge_unit;
  end if;
  if exists(select 1 from team_point_requests where member_id=me.id and status='pending') then raise exception 'すでに追加申請中です。会計係の確認をお待ちください'; end if;
  insert into team_point_requests(member_id,amount) values(me.id,amt) returning * into q;
  insert into team_history(actor,action,entity,after_value,squad) values(actor_name,'points_request','member:'||me.id,jsonb_build_object('name',me.name,'amount',amt),'main');

 elsif p_action='cancel_request' then
  select * into q from team_point_requests where id=nullif(p_data->>'id','')::uuid and status='pending' for update;
  if not found then raise exception '申請が見つかりません'; end if;
  if p_admin is not true and q.member_id is distinct from me.id then raise exception '自分の申請だけ取り消せます' using errcode='42501'; end if;
  update team_point_requests set status='cancelled',resolved_at=now(),resolved_by=actor_name where id=q.id;
  insert into team_history(actor,action,entity,before_value,squad)
   select actor_name,'points_request_cancel','member:'||q.member_id,jsonb_build_object('name',name,'amount',q.amount),'main' from members where id=q.member_id;

 elsif p_action='charge' then
  mid:=nullif(p_data->>'member_id','')::uuid;
  select * into target from members where id=mid and squad='main' and active;
  if not found then raise exception 'メインの有効なメンバーを選んでください'; end if;
  amt:=(p_data->>'amount')::int;
  if amt is null or amt<cfg.charge_unit or amt%cfg.charge_unit<>0 or amt>100000 then
   raise exception 'チャージ金額は%円単位で入力してください',cfg.charge_unit;
  end if;
  pts:=amt/cfg.charge_unit*cfg.charge_points;
  if nullif(p_data->>'request_id','') is not null then
   select * into q from team_point_requests where id=(p_data->>'request_id')::uuid and status='pending' for update;
   if not found or q.member_id<>mid then raise exception '対象の追加申請が見つかりません。更新してください'; end if;
   update team_point_requests set status='approved',resolved_at=now(),resolved_by=actor_name where id=q.id;
  end if;
  if coalesce((p_data->>'ledger')::boolean,false) then
   insert into team_ledger(squad,entry_date,description,income,note)
    values('main',jst_today,'チャージ（'||target.name||'）',amt,pts||'ポイント付与') returning id into lid;
   update team_ledger set charge_member_id=mid where id=lid;
  end if;
  insert into team_points(member_id,delta,amount,reason,request_id,ledger_id,created_by) values(mid,pts,amt,'チャージ',q.id,lid,actor_name);
  insert into team_history(actor,action,entity,after_value,squad)
   values(actor_name,'points_charge','member:'||mid,jsonb_build_object('name',target.name,'amount',amt,'delta',pts,'ledger',lid is not null)||app_member_points(mid),'main');

 elsif p_action='adjust' then
  if jsonb_typeof(p_data->'member_ids')<>'array' then raise exception 'メンバーを選んでください'; end if;
  select array_agg(distinct x::uuid) into ids from jsonb_array_elements_text(p_data->'member_ids') x;
  n:=coalesce(array_length(ids,1),0);
  if n=0 or n>200 then raise exception 'メンバーを選んでください'; end if;
  if (select count(*) from members where id=any(ids) and squad='main' and active)<>n then raise exception 'メインの有効なメンバーだけ選べます'; end if;
  d:=(p_data->>'delta')::int;
  if d is null or d=0 or d not between -100 and 100 then raise exception '増減するポイントは-100〜100（0以外）で入力してください'; end if;
  why:=trim(coalesce(p_data->>'reason',''));
  if length(why) not between 1 and 200 then raise exception '理由を入力してください（例：無料デー、入力ミスの修正）'; end if;
  insert into team_points(member_id,delta,reason,created_by) select unnest(ids),d,why,actor_name;
  insert into team_history(actor,action,entity,after_value,squad)
   select actor_name,'points_adjust','member:'||m.id,jsonb_build_object('name',m.name,'delta',d,'reason',why)||app_member_points(m.id),'main' from members m where m.id=any(ids);
 else raise exception '対応していない操作です';
 end if;
 update team_config set data_version=data_version+1 where id=1;
 return team_home(p_key,p_admin);
end $$;
revoke all on function team_points(text,boolean,bigint,text,text,jsonb) from public;
grant execute on function team_points(text,boolean,bigint,text,text,jsonb) to anon,authenticated;
