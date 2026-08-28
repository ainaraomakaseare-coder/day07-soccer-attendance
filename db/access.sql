-- schema.sql → team.sql → access.sql の順に同一トランザクションで適用。
-- メインはGoogleログイン本人/管理者。共有鍵で入れるのはジュニアだけ。
alter table members add column if not exists vehicle_plate text not null default '';
alter table attendance add column if not exists vehicle_plate text not null default '';
alter table team_guests add column if not exists vehicle_plate text not null default '';
alter table team_guests add column if not exists created_by uuid references members(id) on delete set null;
alter table team_history add column if not exists squad text;
alter table members add column if not exists is_admin boolean not null default false;
alter table members add column if not exists preferred_position text not null default '';
alter table members add column if not exists position_note text not null default '';
alter table attendance add column if not exists uses_bicycle boolean not null default false;
alter table team_guests add column if not exists uses_bicycle boolean not null default false;
alter table team_config add column if not exists registration_code text;
update team_config set registration_code=lpad(((('x'||substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint)%10000)::text,4,'0') where registration_code is null;
create table if not exists team_signup_attempts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 attempts integer not null default 0,
 window_start timestamptz not null default now()
);
alter table team_signup_attempts enable row level security;
revoke all on team_signup_attempts from public,anon,authenticated;

-- 管理鍵に加え、明示的に管理者に指定されたGoogle本人を認可する。
create or replace function app_check_admin(p_admin text) returns void
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if coalesce(p_admin,'')<>'' and exists(select 1 from team_config where id=1 and admin_token=p_admin) then return; end if;
 if coalesce(p_admin,'')='' and auth.uid() is not null and exists(
  select 1 from members m join auth.users u on u.id=auth.uid()
  where m.active and m.squad='main' and m.is_admin and
   (m.auth_user_id=u.id or (m.auth_user_id is null and u.email_confirmed_at is not null and lower(m.email)=lower(trim(u.email))))
 ) then return; end if;
 raise exception '管理者権限がありません' using errcode='28000';
end $$;
revoke all on function app_check_admin(text) from public,anon,authenticated;

create or replace function app_main_member() returns members
language plpgsql security definer set search_path=public,pg_temp as $$
declare m members; mail text;
begin
 if auth.uid() is null then raise exception 'メインはGoogleログインが必要です' using errcode='28000'; end if;
 select * into m from members where auth_user_id=auth.uid() and squad='main' and active;
 if found then return m; end if;
 select lower(trim(email)) into mail from auth.users where id=auth.uid() and email_confirmed_at is not null;
 if mail is not null then
  select * into m from members where lower(email)=mail and squad='main' and active for update;
  if found and (m.auth_user_id is null or m.auth_user_id=auth.uid()) then
   update members set auth_user_id=auth.uid() where id=m.id returning * into m;
   return m;
  end if;
 end if;
 raise exception '名簿にこのGoogleアカウントが登録されていません。管理者にメールアドレスの登録を依頼してください' using errcode='28000';
end $$;
revoke all on function app_main_member() from public,anon,authenticated;

create or replace function app_team_access(p_key text,p_admin boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_admin is true then perform app_check_admin(p_key);
 elsif coalesce(p_key,'')<>'' then
  if not exists(select 1 from team_config where id=1 and shared_token=p_key) then
   raise exception 'ジュニアの共有リンクを確認してください' using errcode='28000';
  end if;
 else perform app_main_member();
 end if;
end $$;
revoke all on function app_team_access(text,boolean) from public,anon,authenticated;

create or replace function team_home(p_key text default '',p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; me members; scope text; event_ids jsonb;
begin
 perform app_team_access(p_key,p_admin);
 scope:=case when p_admin is true then 'all' when coalesce(p_key,'')<>'' then 'junior' else 'main' end;
 if scope='main' or (p_admin is true and coalesce(p_key,'')='') then me:=app_main_member(); end if;
 result:=app_team_home_core(p_key,p_admin);
 -- 認証されていないジュニア利用者にメインの名簿/出欠/履歴を返さない。
 select coalesce(jsonb_agg(x),'[]'::jsonb) into event_ids from jsonb_array_elements(result->'events') x where scope='all' or x->>'squad'=scope;
 result:=result||jsonb_build_object('scope',scope,'events',event_ids,
  'can_admin',coalesce(me.is_admin,false),
  'me',case when me.id is not null then jsonb_build_object('id',me.id,'name',me.name,'has_vehicle_plate',me.vehicle_plate<>'') || case when p_admin is true then jsonb_build_object('vehicle_plate',me.vehicle_plate) else '{}'::jsonb end else null end,
  'members',coalesce((select jsonb_agg(x || case when p_admin is true then
    jsonb_build_object('email',m.email,'vehicle_plate',m.vehicle_plate) else '{}'::jsonb end)
    from jsonb_array_elements(result->'members') x join members m on m.id=(x->>'id')::uuid where scope='all' or m.squad=scope),'[]'::jsonb),
  'answers',coalesce((select jsonb_agg(case when p_admin is true then x else (x-'vehicle_plate')||jsonb_build_object('has_vehicle_plate',coalesce(x->>'vehicle_plate','')<>'') end)
    from jsonb_array_elements(result->'answers') x where exists(select 1 from jsonb_array_elements(event_ids) e where e->>'id'=x->>'event_id')),'[]'::jsonb),
  'guests',coalesce((select jsonb_agg(case when p_admin is true then x else (x-'vehicle_plate')||jsonb_build_object('has_vehicle_plate',coalesce(x->>'vehicle_plate','')<>'') end)
    from jsonb_array_elements(result->'guests') x where exists(select 1 from jsonb_array_elements(event_ids) e where e->>'id'=x->>'event_id')),'[]'::jsonb),
  'notices',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'notices') x where scope='all' or x->>'squad'=scope),'[]'::jsonb),
  'ledger',case when p_admin is not true then '[]'::jsonb else coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'ledger') x where scope='all' or x->>'squad'=scope),'[]'::jsonb) end,
  'bibs',case when scope='main' then '[]'::jsonb else result->'bibs' end,
  'history',coalesce((select jsonb_agg(case when p_admin is true then x else x||jsonb_build_object('before_value',nullif(x->'before_value','null'::jsonb)-'vehicle_plate','after_value',nullif(x->'after_value','null'::jsonb)-'vehicle_plate') end)
    from jsonb_array_elements(result->'history') x where p_admin is true or (x->>'squad'=scope and x->>'action' not in ('ledger','delete_ledger','settings'))),'[]'::jsonb));
 if p_admin is true then result:=result||jsonb_build_object('registration_code',(select registration_code from team_config where id=1)); end if;
 if p_admin is not true then result:=result-'main_opening'-'junior_opening'-'main_fee'-'junior_fee'; end if;
 return result;
end $$;

create or replace function app_validate_plate(p_plate text) returns text
language plpgsql immutable as $$
declare v text:=trim(coalesce(p_plate,''));
begin
 -- 登録地・分類番号・かな/英字・一連番号を含む自由入力。特殊な地域表記も残す。
 if length(v) not between 7 and 40 or v !~ '[0-9０-９]' or v !~ '[ぁ-んァ-ヶ一-龠A-Za-z]' or v ~ '^[0-9０-９ .・ー－-]+$' then
  raise exception 'ナンバー全体を入力してください（例：横浜 300 あ 1234）';
 end if;
 return v;
end $$;
revoke all on function app_validate_plate(text) from public,anon,authenticated;

create or replace function team_write(p_key text,p_admin boolean,p_version bigint,p_actor text,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare me members; scope text; target_scope text; target_member uuid; target_event uuid; item uuid; hist team_history;
 actual_actor text; plate text:=''; v bigint; result jsonb; h_id bigint; g team_guests; original_plate text; mail text;
begin
 perform app_team_access(p_key,p_admin);
 scope:=case when p_admin is true then 'all' when coalesce(p_key,'')<>'' then 'junior' else 'main' end;
 if scope='main' or (p_admin is true and coalesce(p_key,'')='') then me:=app_main_member(); end if;
 select data_version into v from team_config where id=1 for update;
 if p_version is distinct from v then raise exception '他の人の変更があります。更新してからもう一度入力してください' using errcode='40001'; end if;
 actual_actor:=case when me.id is not null then me.name else p_actor end;
 item:=nullif(p_data->>'id','')::uuid;
 target_scope:=p_data->>'squad';
 if p_action='member' and item is not null then select squad into target_scope from members where id=item; end if;
 if p_action in ('answer','guest') then
  target_event:=(p_data->>'event_id')::uuid;select squad into target_scope from events where id=target_event;
 end if;
 if p_action='notice' and item is not null then select squad into target_scope from team_notices where id=item; end if;
 if p_action='notice' and p_data->>'squad' is distinct from target_scope then raise exception 'グループが一致しません' using errcode='42501'; end if;
 if p_action='bib' then target_scope:='junior'; end if;
 if p_action='undo_answer' then
  select * into hist from team_history where id=(p_data->>'history_id')::bigint and action='answer';
  target_event:=split_part(hist.entity,':',2)::uuid;target_member:=split_part(hist.entity,':',3)::uuid;
  select squad into target_scope from events where id=target_event;
 end if;
 if p_action in ('answer','guest','member','notice','bib','undo_answer') then
  if target_scope is null then raise exception '対象が見つかりません'; end if;
  if scope<>'all' and target_scope<>scope then raise exception 'このグループは変更できません' using errcode='42501'; end if;
 end if;
 if scope='main' then
  if p_action='answer' and (p_data->>'member_id')::uuid is distinct from me.id then raise exception '自分の出欠だけ変更できます' using errcode='42501'; end if;
  if p_action='undo_answer' and target_member is distinct from me.id then raise exception '自分の出欠だけ取り消せます' using errcode='42501'; end if;
  if p_action='member' then raise exception 'メインの名簿登録・編集は管理者が行います' using errcode='42501'; end if;
  if p_action='notice' and nullif(p_data->>'member_id','')::uuid is distinct from me.id then raise exception '自分の伝達事項だけ変更できます' using errcode='42501'; end if;
  if p_action='notice' and item is not null and not exists(select 1 from team_notices where id=item and member_id=me.id) then raise exception '他の人の連絡は変更できません' using errcode='42501'; end if;
 end if;
 if p_action='member' and scope='junior' then
  if p_data->>'squad' is distinct from 'junior' or p_data ? 'email' then raise exception 'ジュニア名簿だけ変更できます' using errcode='42501'; end if;
 end if;
 if p_action='answer' then
  target_member:=(p_data->>'member_id')::uuid;
  if coalesce((p_data->>'uses_bicycle')::boolean,false) and p_data->>'car'='yes' then raise exception '車と自転車はどちらかを選んでください'; end if;
  if p_data->>'status'='yes' and p_data->>'car'='yes' and (select asks_car from events where id=target_event) then
   -- 非管理者には番号を返さず、未入力なら本人の保存済み番号を使用する。
   plate:=app_validate_plate(coalesce(nullif(trim(p_data->>'vehicle_plate'),''),(select nullif(vehicle_plate,'') from attendance where member_id=target_member and event_id=target_event),(select vehicle_plate from members where id=target_member)));
  end if;
 end if;
 if p_action='guest' then
  if coalesce((p_data->>'uses_bicycle')::boolean,false) and coalesce((p_data->>'car')::boolean,false) then raise exception '車と自転車はどちらかを選んでください'; end if;
  if item is not null then
   select * into g from team_guests where id=item;
   if scope='main' and g.created_by is distinct from me.id then raise exception 'このゲストの修正は追加者または管理者が行えます' using errcode='42501'; end if;
  end if;
  if scope='main' then p_data:=p_data||jsonb_build_object('invited_by',case when item is null then me.name else g.invited_by end); end if;
  if coalesce(p_data->>'status','yes')='yes' and coalesce((p_data->>'car')::boolean,false) and (select asks_car from events where id=target_event) then
   plate:=app_validate_plate(coalesce(nullif(trim(p_data->>'vehicle_plate'),''),g.vehicle_plate));
  end if;
 end if;
 result:=app_team_write_core(p_key,p_admin,p_version,actual_actor,p_action,p_data);
 select max(id) into h_id from team_history;
 update team_history set squad=target_scope where id=h_id;
 if p_action='answer' then
  update attendance set vehicle_plate=plate,uses_bicycle=(status='yes' and coalesce((p_data->>'uses_bicycle')::boolean,false)) where member_id=target_member and event_id=target_event;
  if plate<>'' then update members set vehicle_plate=plate where id=target_member; end if;
  update team_history set after_value=(select to_jsonb(a) from attendance a where member_id=target_member and event_id=target_event) where id=h_id;
 elsif p_action='guest' then
  item:=(select (after_value->>'id')::uuid from team_history where id=h_id);
  update team_guests set vehicle_plate=plate,uses_bicycle=(status='yes' and coalesce((p_data->>'uses_bicycle')::boolean,false)),created_by=case when p_data->>'id' is null and scope='main' then me.id else created_by end where id=item;
  update team_history set after_value=(select to_jsonb(x) from team_guests x where id=item) where id=h_id;
 elsif p_action='undo_answer' then
  original_plate:=coalesce(hist.before_value->>'vehicle_plate','');
  update attendance set vehicle_plate=case when car='yes' then original_plate else '' end,uses_bicycle=coalesce((hist.before_value->>'uses_bicycle')::boolean,false) where event_id=target_event and member_id=target_member;
  update team_history set after_value=(select to_jsonb(a) from attendance a where member_id=target_member and event_id=target_event) where id=h_id;
 elsif p_action='event' then
  item:=(select (after_value->>'id')::uuid from team_history where id=h_id);
  if not (select asks_car from events where id=item) then
   update attendance set vehicle_plate='' where event_id=item;update team_guests set vehicle_plate='' where event_id=item;
  end if;
 elsif p_action='member' and p_admin is true and p_data ? 'email' then
  item:=(select (after_value->>'id')::uuid from team_history where id=h_id);
  mail:=nullif(lower(trim(p_data->>'email')),'');
  if mail is not null and mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'メールアドレスを確認してください'; end if;
  update members set email=mail,auth_user_id=case when email is distinct from mail then null else auth_user_id end where id=item;
 end if;
 return team_home(p_key,p_admin);
end $$;
revoke all on function team_home(text,boolean),team_write(text,boolean,bigint,text,text,jsonb) from public;
grant execute on function team_home(text,boolean),team_write(text,boolean,bigint,text,text,jsonb) to anon,authenticated;

-- 旧招待コードや旧API経由で「本人だけ」の制約を回避できないよう閉じる。
revoke execute on function member_home(text),set_status(text,uuid,text,text),event_detail(text,uuid),
 claim_member(text),roster_by_code(text),claim_member_by_code(text,uuid),
 me_home(),me_set_status(uuid,text,text),me_event_detail(uuid),me_set_name(text)
 from public,anon,authenticated;

-- Google本人＋4桁コードで新規登録。誤入力回数は例外で戻さずDBに記録する。
create or replace function join_main(p_code text,p_name text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=auth.uid(); mail text; n text:=trim(p_name); a team_signup_attempts; m members; code text;
begin
 if uid is null then raise exception 'Googleログインが必要です' using errcode='28000'; end if;
 select lower(trim(email)) into mail from auth.users where id=uid and email_confirmed_at is not null;
 if mail is null then raise exception '確認済みのGoogleアカウントでログインしてください' using errcode='28000'; end if;
 insert into team_signup_attempts(user_id) values(uid) on conflict do nothing;
 select * into a from team_signup_attempts where user_id=uid for update;
 if a.window_start < now()-interval '15 minutes' then
  update team_signup_attempts set attempts=0,window_start=now() where user_id=uid; a.attempts:=0;
 end if;
 if a.attempts>=5 then return jsonb_build_object('ok',false,'error','入力回数の上限です。15分後にやり直してください'); end if;
 select registration_code into code from team_config where id=1 for update;
 select * into m from members where auth_user_id=uid or lower(email)=mail;
 if found then
  if m.active and m.squad='main' and (m.auth_user_id is null or m.auth_user_id=uid) then
   return jsonb_build_object('ok',true,'home',team_home('',false));
  end if;
  return jsonb_build_object('ok',false,'error','このアカウントの登録は管理者に確認してください');
 end if;
 if p_code is null or p_code !~ '^[0-9]{4}$' or p_code<>code then
  update team_signup_attempts set attempts=attempts+1 where user_id=uid;
  return jsonb_build_object('ok',false,'error','参加コードを確認してください');
 end if;
 if n is null or length(n) not between 1 and 80 then return jsonb_build_object('ok',false,'error','名前を1〜80文字で入力してください'); end if;
 if exists(select 1 from members where squad='main' and regexp_replace(name,'[[:space:]　]+','','g')=regexp_replace(n,'[[:space:]　]+','','g')) then
  return jsonb_build_object('ok',false,'error','同じ名前が名簿にあります。重複登録を避けるため管理者に確認してください');
 end if;
 insert into members(name,email,auth_user_id,token,squad,member_role,sort_order)
 values(n,mail,uid,replace(gen_random_uuid()::text,'-',''),'main','player',coalesce((select max(sort_order)+1 from members),1)) returning * into m;
 insert into team_history(actor,action,entity,after_value,squad) values(n,'member','member:'||m.id,jsonb_build_object('id',m.id,'name',n,'squad','main'),'main');
 return jsonb_build_object('ok',true,'home',team_home('',false));
end $$;
revoke all on function join_main(text,text) from public,anon;
grant execute on function join_main(text,text) to authenticated;

create or replace function admin_registration_code(p_admin text,p_code text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform app_check_admin(p_admin);
 if p_code is null or p_code !~ '^[0-9]{4}$' then raise exception '参加コードは半角数字4桁で入力してください'; end if;
 update team_config set registration_code=p_code,data_version=data_version+1 where id=1;
 return team_home(p_admin,true);
end $$;
revoke all on function admin_registration_code(text,text) from public;
grant execute on function admin_registration_code(text,text) to anon,authenticated;

