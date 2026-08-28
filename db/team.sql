-- schema.sql の後に適用。チーム共有リンクはアカウント不要の共同編集用の鍵。
-- 管理鍵とは別。すべてのテーブルはRLS、入口はteam_home/team_writeだけ。
alter table team_config add column if not exists shared_token text;
alter table team_config add column if not exists data_version bigint not null default 0;
alter table team_config add column if not exists year_start_month int not null default 4;
alter table team_config add column if not exists main_fee int not null default 300;
alter table team_config add column if not exists junior_fee int not null default 100;
alter table team_config add column if not exists main_opening bigint not null default 0;
alter table team_config add column if not exists junior_opening bigint not null default 0;
alter table team_config add column if not exists bib_guide text not null default '各自で持ち帰り、洗濯・管理。卒部・退会時に返却してください。';
update team_config set shared_token = replace(gen_random_uuid()::text,'-','') where shared_token is null;

alter table members add column if not exists squad text not null default 'main' check (squad in ('main','junior'));
alter table members add column if not exists member_role text not null default 'player' check (member_role in ('player','staff','ac','guest'));
alter table members add column if not exists affiliation text not null default '';
alter table members add column if not exists grade text not null default '';
alter table members add column if not exists proxy_name text not null default '';
alter table members add column if not exists jersey text not null default '';
alter table events add column if not exists squad text not null default 'main' check (squad in ('main','junior'));
alter table events add column if not exists end_time time;
alter table events add column if not exists deadline date;
alter table events add column if not exists booking_person text not null default '';
alter table events add column if not exists cleaning boolean not null default false;
alter table attendance add column if not exists note text not null default '';
alter table attendance add column if not exists confirmed boolean not null default false;

create table if not exists team_guests (
 id uuid primary key default gen_random_uuid(), event_id uuid not null references events(id) on delete cascade,
 name text not null check (length(name) between 1 and 80), invited_by text not null default '',
 status text not null default 'yes' check (status in ('yes','no')), car boolean not null default false,
 note text not null default ''
);
create table if not exists team_notices (
 id uuid primary key default gen_random_uuid(), squad text not null check (squad in ('main','junior')),
 member_id uuid references members(id) on delete set null, body text not null check (length(body) between 1 and 2000),
 notice_date date not null default current_date, resolved boolean not null default false,
 confirmed_by text not null default '', created_at timestamptz not null default now()
);
create table if not exists team_ledger (
 id uuid primary key default gen_random_uuid(), squad text not null check (squad in ('main','junior')),
 entry_date date not null, description text not null check (length(description) between 1 and 200),
 expense int not null default 0 check (expense between 0 and 100000000),
 fee int not null default 0 check (fee between 0 and 1000000),
 people int not null default 0 check (people between 0 and 10000),
 income int check (income between 0 and 100000000),
 planned boolean not null default false, note text not null default '', created_at timestamptz not null default now()
);
create table if not exists team_bibs (
 id uuid primary key default gen_random_uuid(), number text not null unique check (length(number) between 1 and 20),
 member_id uuid references members(id) on delete set null,
 state text not null default 'available' check (state in ('available','loaned','return_due','returned')),
 loan_date date, return_date date, note text not null default ''
);
create table if not exists team_history (
 id bigint generated always as identity primary key, actor text not null, action text not null,
 entity text not null, before_value jsonb, after_value jsonb, created_at timestamptz not null default now()
);
create index if not exists team_guests_event_idx on team_guests(event_id);
create index if not exists team_notices_squad_idx on team_notices(squad, notice_date);
create index if not exists team_ledger_squad_idx on team_ledger(squad, entry_date);
create index if not exists team_history_entity_idx on team_history(entity,id);
alter table team_guests enable row level security;
alter table team_notices enable row level security;
alter table team_ledger enable row level security;
alter table team_bibs enable row level security;
alter table team_history enable row level security;

create or replace function app_team_access(p_key text, p_admin boolean) returns void
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from team_config where id=1 and
   case when p_admin is true then admin_token=p_key else shared_token=p_key end) then
   raise exception 'チームの共有リンクまたは管理リンクを確認してください' using errcode='28000';
 end if;
end $$;
revoke all on function app_team_access(text,boolean) from public,anon,authenticated;

create or replace function app_team_home_core(p_key text,p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 perform app_team_access(p_key,p_admin);
 select jsonb_build_object('team',team_name,'version',data_version,'year_start_month',year_start_month,
   'main_fee',main_fee,'junior_fee',junior_fee,'main_opening',main_opening,'junior_opening',junior_opening,
   'bib_guide',bib_guide,'admin',p_admin is true) into result from team_config where id=1;
 -- メール、個人鍵、認証ID、管理鍵は共同編集画面に返さない。
 return result || jsonb_build_object(
  'members',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'number',number,'active',active,
   'squad',squad,'member_role',member_role,'affiliation',affiliation,'grade',grade,'proxy_name',proxy_name,'jersey',jersey)
   order by sort_order,created_at,id) from members),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(to_jsonb(e) order by event_date,start_time,id) from events e),'[]'::jsonb),
  'answers',coalesce((select jsonb_agg(to_jsonb(a)) from attendance a),'[]'::jsonb),
  'guests',coalesce((select jsonb_agg(to_jsonb(g) order by id) from team_guests g),'[]'::jsonb),
  'notices',coalesce((select jsonb_agg(to_jsonb(n) order by notice_date desc,created_at desc) from team_notices n),'[]'::jsonb),
  'ledger',coalesce((select jsonb_agg(to_jsonb(l) order by entry_date,created_at,id) from team_ledger l),'[]'::jsonb),
  'bibs',coalesce((select jsonb_agg(to_jsonb(b) order by number) from team_bibs b),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(to_jsonb(h) order by id desc) from
   (select * from team_history order by id desc limit 200) h),'[]'::jsonb));
end $$;

create or replace function admin_shared_link(p_admin text) returns text
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 perform app_check_admin(p_admin);
 return (select shared_token from team_config where id=1);
end $$;

create or replace function app_team_write_core(p_key text,p_admin boolean,p_version bigint,p_actor text,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare old_value jsonb; new_value jsonb; entity_key text; item uuid; mid uuid; eid uuid;
 cfg team_config; hist team_history; current_value jsonb; s text; name_value text;
begin
 -- 全更新を短い行ロックで直列化し、別端末の変更を黙って上書きしない。
 select * into cfg from team_config where id=1 for update;
 perform app_team_access(p_key,p_admin);
 if p_version is distinct from cfg.data_version then
  raise exception '他の人の変更があります。更新してからもう一度入力してください' using errcode='40001';
 end if;
 if p_actor is null or length(trim(p_actor)) not between 1 and 80 then raise exception '入力者名を1〜80文字で入力してください'; end if;
 if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception '入力形式が正しくありません'; end if;
 if octet_length(p_data::text)>20000 then raise exception '入力が長すぎます'; end if;
 if p_action in ('event','delete_event','ledger','delete_ledger','archive_member','settings','rotate_link') and p_admin is not true then
  raise exception '管理者だけが変更できます' using errcode='42501';
 end if;
 item := nullif(p_data->>'id','')::uuid;
 if p_action='member' then
  s := p_data->>'squad'; name_value := trim(p_data->>'name');
  if name_value is null or length(name_value) not between 1 and 80 then raise exception '名前を1〜80文字で入力してください'; end if;
  if s is null or s not in ('main','junior') then raise exception 'グループを選んでください'; end if;
  if item is null then
   insert into members(name,token,squad,member_role) values(name_value,replace(gen_random_uuid()::text,'-',''),s,coalesce(p_data->>'member_role','player')) returning id into item;
  else
   select jsonb_build_object('id',id,'name',name,'squad',squad,'member_role',member_role,'number',number,'affiliation',affiliation,'grade',grade,'jersey',jersey,'proxy_name',proxy_name)
    into old_value from members where id=item and active;
   if not found then raise exception 'メンバーが見つかりません'; end if;
   if s <> old_value->>'squad' then raise exception '登録後のグループ変更はできません'; end if;
  end if;
  update members set name=name_value, member_role=coalesce(p_data->>'member_role','player'),number=left(coalesce(p_data->>'number',''),20),
   affiliation=left(coalesce(p_data->>'affiliation',''),200),grade=left(coalesce(p_data->>'grade',''),40),
   jersey=left(coalesce(p_data->>'jersey',''),20),proxy_name=left(coalesce(p_data->>'proxy_name',''),80) where id=item;
  select jsonb_build_object('id',id,'name',name,'squad',squad,'member_role',member_role,'number',number,'affiliation',affiliation,'grade',grade,'jersey',jersey,'proxy_name',proxy_name)
   into new_value from members where id=item;
  entity_key := 'member:'||item;
 elsif p_action='archive_member' then
  select jsonb_build_object('id',id,'name',name,'active',active) into old_value from members where id=item;
  if not found then raise exception 'メンバーが見つかりません'; end if;
  update members set active=coalesce((p_data->>'active')::boolean,false) where id=item;
  new_value := old_value||jsonb_build_object('active',coalesce((p_data->>'active')::boolean,false)); entity_key:='member:'||item;
 elsif p_action='event' then
  if item is null then
   insert into events(event_date,squad) values((p_data->>'event_date')::date,p_data->>'squad') returning id into item;
  else
   select to_jsonb(e) into old_value from events e where id=item;
   if not found then raise exception '予定が見つかりません'; end if;
   if p_data->>'squad' is distinct from old_value->>'squad' then raise exception '登録後のグループ変更はできません'; end if;
  end if;
  if nullif(p_data->>'start_time','')::time >= nullif(p_data->>'end_time','')::time then raise exception '終了時刻は開始より後にしてください'; end if;
  if nullif(p_data->>'deadline','')::date > (p_data->>'event_date')::date then raise exception '締切は開催日以前にしてください'; end if;
  update events set event_date=(p_data->>'event_date')::date, start_time=nullif(p_data->>'start_time','')::time,
   end_time=nullif(p_data->>'end_time','')::time,deadline=nullif(p_data->>'deadline','')::date,
   kind=coalesce(p_data->>'kind','practice'),place=left(coalesce(p_data->>'place',''),200),note=left(coalesce(p_data->>'note',''),2000),
   booking_person=left(coalesce(p_data->>'booking_person',''),80),cleaning=coalesce((p_data->>'cleaning')::boolean,false),
   asks_car=coalesce((p_data->>'asks_car')::boolean,false) where id=item;
  if not (select asks_car from events where id=item) then
   update attendance set car=null where event_id=item;
   update team_guests set car=false where event_id=item;
  end if;
  select to_jsonb(e) into new_value from events e where id=item; entity_key:='event:'||item;
 elsif p_action='delete_event' then
  select to_jsonb(e) into old_value from events e where id=item;
  if not found then raise exception '予定が見つかりません'; end if;
  delete from events where id=item; entity_key:='event:'||item;
 elsif p_action='answer' then
  mid := (p_data->>'member_id')::uuid; eid := (p_data->>'event_id')::uuid;
  if not exists(select 1 from members m join events e on e.squad=m.squad where m.id=mid and e.id=eid and m.active) then raise exception '同じグループのメンバーと予定を選んでください'; end if;
  select to_jsonb(a) into old_value from attendance a where member_id=mid and event_id=eid;
  s:=nullif(p_data->>'status','');
  if s is null then
   delete from attendance where member_id=mid and event_id=eid;
  else
   insert into attendance(event_id,member_id,status,car,note,confirmed) values(eid,mid,s,
    case when s='yes' and (select asks_car from events where id=eid) then nullif(p_data->>'car','') else null end,
    left(coalesce(p_data->>'note',''),1000),coalesce((p_data->>'confirmed')::boolean,false))
   on conflict(event_id,member_id) do update set status=excluded.status,car=excluded.car,note=excluded.note,confirmed=excluded.confirmed,updated_at=now();
   select to_jsonb(a) into new_value from attendance a where member_id=mid and event_id=eid;
  end if;
  entity_key:='answer:'||eid||':'||mid;
 elsif p_action='guest' then
  eid:=(p_data->>'event_id')::uuid; name_value:=trim(p_data->>'name');
  if item is not null then
   select to_jsonb(g) into old_value from team_guests g where id=item and event_id=eid;
   if not found then raise exception '助っ人が見つかりません'; end if;
  end if;
  item:=coalesce(item,gen_random_uuid());
  insert into team_guests(id,event_id,name,invited_by,status,car,note)
   values(item,eid,name_value,left(coalesce(p_data->>'invited_by',''),80),coalesce(p_data->>'status','yes'),
   coalesce(p_data->>'status','yes')='yes' and coalesce((p_data->>'car')::boolean,false) and (select asks_car from events where id=eid),left(coalesce(p_data->>'note',''),1000))
   on conflict(id) do update set name=excluded.name,invited_by=excluded.invited_by,status=excluded.status,car=excluded.car,note=excluded.note;
  select to_jsonb(g) into new_value from team_guests g where id=item; entity_key:='guest:'||item;
 elsif p_action='notice' then
  if item is not null then
   select to_jsonb(n) into old_value from team_notices n where id=item;
   if not found then raise exception '伝達事項が見つかりません'; end if;
  end if;
  s:=p_data->>'squad';mid:=nullif(p_data->>'member_id','')::uuid;
  if mid is not null and not exists(select 1 from members where id=mid and squad=s) then raise exception 'グループが一致しません'; end if;
  item:=coalesce(item,gen_random_uuid());
  insert into team_notices(id,squad,member_id,body,notice_date,resolved,confirmed_by)
   values(item,s,mid,trim(p_data->>'body'),(p_data->>'notice_date')::date,coalesce((p_data->>'resolved')::boolean,false),
    case when coalesce((p_data->>'confirmed')::boolean,false) then trim(p_actor) else '' end)
   on conflict(id) do update set member_id=excluded.member_id,body=excluded.body,notice_date=excluded.notice_date,resolved=excluded.resolved,confirmed_by=excluded.confirmed_by;
  select to_jsonb(n) into new_value from team_notices n where id=item; entity_key:='notice:'||item;
 elsif p_action='ledger' then
  if item is not null then
   select to_jsonb(l) into old_value from team_ledger l where id=item;
   if not found then raise exception '会計記録が見つかりません'; end if;
  end if;
  item:=coalesce(item,gen_random_uuid());
  insert into team_ledger(id,squad,entry_date,description,expense,fee,people,income,planned,note)
   values(item,p_data->>'squad',(p_data->>'entry_date')::date,trim(p_data->>'description'),coalesce((p_data->>'expense')::int,0),
    coalesce((p_data->>'fee')::int,0),coalesce((p_data->>'people')::int,0),nullif(p_data->>'income','')::int,
    coalesce((p_data->>'planned')::boolean,false),left(coalesce(p_data->>'note',''),1000))
   on conflict(id) do update set entry_date=excluded.entry_date,description=excluded.description,expense=excluded.expense,
    fee=excluded.fee,people=excluded.people,income=excluded.income,planned=excluded.planned,note=excluded.note;
  select to_jsonb(l) into new_value from team_ledger l where id=item; entity_key:='ledger:'||item;
 elsif p_action='delete_ledger' then
  select to_jsonb(l) into old_value from team_ledger l where id=item;
  if not found then raise exception '会計記録が見つかりません'; end if;
  delete from team_ledger where id=item; entity_key:='ledger:'||item;
 elsif p_action='bib' then
  if item is not null then
   select to_jsonb(b) into old_value from team_bibs b where id=item;
   if not found then raise exception 'ビブスが見つかりません'; end if;
  end if;
  mid:=nullif(p_data->>'member_id','')::uuid;
  if mid is not null and not exists(select 1 from members where id=mid and squad='junior' and active) then raise exception 'ジュニアのメンバーを選んでください'; end if;
  if p_data->>'state' in ('loaned','return_due') and mid is null then raise exception '貸出先を選んでください'; end if;
  item:=coalesce(item,gen_random_uuid());
  insert into team_bibs(id,number,member_id,state,loan_date,return_date,note) values(item,trim(p_data->>'number'),mid,p_data->>'state',
   nullif(p_data->>'loan_date','')::date,nullif(p_data->>'return_date','')::date,left(coalesce(p_data->>'note',''),1000))
   on conflict(id) do update set number=excluded.number,member_id=excluded.member_id,state=excluded.state,loan_date=excluded.loan_date,return_date=excluded.return_date,note=excluded.note;
  select to_jsonb(b) into new_value from team_bibs b where id=item; entity_key:='bib:'||item;
 elsif p_action='settings' then
  if (p_data->>'year_start_month')::int not between 1 and 12 or (p_data->>'main_fee')::int not between 0 and 1000000 or (p_data->>'junior_fee')::int not between 0 and 1000000 then raise exception '設定値を確認してください'; end if;
  old_value:=jsonb_build_object('year_start_month',cfg.year_start_month,'main_fee',cfg.main_fee,'junior_fee',cfg.junior_fee,'main_opening',cfg.main_opening,'junior_opening',cfg.junior_opening,'bib_guide',cfg.bib_guide);
  update team_config set year_start_month=(p_data->>'year_start_month')::int,main_fee=(p_data->>'main_fee')::int,junior_fee=(p_data->>'junior_fee')::int,
   main_opening=(p_data->>'main_opening')::bigint,junior_opening=(p_data->>'junior_opening')::bigint,bib_guide=left(coalesce(p_data->>'bib_guide',''),2000) where id=1;
  new_value:=p_data; entity_key:='settings';
 elsif p_action='rotate_link' then
  update team_config set shared_token=replace(gen_random_uuid()::text,'-','') where id=1;
  entity_key:='shared_link';new_value:='{"rotated":true}'::jsonb;
 elsif p_action='undo_answer' then
  select * into hist from team_history where id=(p_data->>'history_id')::bigint and action='answer';
  if not found then raise exception '取り消せる出欠履歴がありません'; end if;
  if exists(select 1 from team_history where entity=hist.entity and id>hist.id) then raise exception '後から変更されています。最新の回答を確認してください'; end if;
  eid:=split_part(hist.entity,':',2)::uuid;mid:=split_part(hist.entity,':',3)::uuid;
  if not exists(select 1 from events e join members m on m.squad=e.squad where e.id=eid and m.id=mid and m.active) then raise exception '対象の予定またはメンバーは無効です'; end if;
  select to_jsonb(a) into current_value from attendance a where event_id=eid and member_id=mid;
  if current_value is distinct from hist.after_value then raise exception '回答が更新されています'; end if;
  old_value:=current_value;
  delete from attendance where event_id=eid and member_id=mid;
  if hist.before_value is not null then
   insert into attendance(event_id,member_id,status,car,note,confirmed) values(eid,mid,hist.before_value->>'status',
     case when (select asks_car from events where id=eid) then hist.before_value->>'car' else null end,
     coalesce(hist.before_value->>'note',''),coalesce((hist.before_value->>'confirmed')::boolean,false));
  end if;
  select to_jsonb(a) into new_value from attendance a where event_id=eid and member_id=mid;entity_key:=hist.entity;
 else raise exception '対応していない操作です';
 end if;
 insert into team_history(actor,action,entity,before_value,after_value) values(trim(p_actor),p_action,entity_key,old_value,new_value);
 update team_config set data_version=data_version+1 where id=1;
 return team_home(p_key,p_admin);
end $$;

revoke all on function app_team_home_core(text,boolean) from public,anon,authenticated;
revoke all on function app_team_write_core(text,boolean,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function admin_shared_link(text) from public;
grant execute on function admin_shared_link(text) to anon,authenticated;

-- 旧個人画面・旧管理画面からの更新も競合検知に含める。
create or replace function app_team_version() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update team_config set data_version=data_version+1 where id=1;
 return null;
end $$;
revoke all on function app_team_version() from public,anon,authenticated;
drop trigger if exists team_members_version on members;
create trigger team_members_version after insert or update or delete on members for each statement execute function app_team_version();
drop trigger if exists team_events_version on events;
create trigger team_events_version after insert or update or delete on events for each statement execute function app_team_version();
drop trigger if exists team_attendance_version on attendance;
create trigger team_attendance_version after insert or update or delete on attendance for each statement execute function app_team_version();
