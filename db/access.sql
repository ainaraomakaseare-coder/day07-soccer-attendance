-- schema.sql → team.sql → access.sql の順に同一トランザクションで適用。
-- メインはGoogleログイン本人/管理者。共有鍵で入れるのはジュニアだけ。
alter table members add column if not exists vehicle_plate text not null default '';
alter table attendance add column if not exists vehicle_plate text not null default '';
alter table team_guests add column if not exists vehicle_plate text not null default '';
alter table team_guests add column if not exists created_by uuid references members(id) on delete set null;
alter table team_history add column if not exists squad text;

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
 if scope='main' then me:=app_main_member(); end if;
 result:=app_team_home_core(p_key,p_admin);
 -- 認証されていないジュニア利用者にメインの名簿/出欠/履歴を返さない。
 select coalesce(jsonb_agg(x),'[]'::jsonb) into event_ids from jsonb_array_elements(result->'events') x where scope='all' or x->>'squad'=scope;
 result:=result||jsonb_build_object('scope',scope,'events',event_ids,
  'me',case when scope='main' then jsonb_build_object('id',me.id,'name',me.name,'vehicle_plate',me.vehicle_plate) else null end,
  'members',coalesce((select jsonb_agg(x || case when p_admin is true then
    jsonb_build_object('email',m.email,'vehicle_plate',m.vehicle_plate) else '{}'::jsonb end)
    from jsonb_array_elements(result->'members') x join members m on m.id=(x->>'id')::uuid where scope='all' or m.squad=scope),'[]'::jsonb),
  'answers',coalesce((select jsonb_agg(case when p_admin is true or x->>'member_id'=me.id::text then x else x-'vehicle_plate' end)
    from jsonb_array_elements(result->'answers') x where exists(select 1 from jsonb_array_elements(event_ids) e where e->>'id'=x->>'event_id')),'[]'::jsonb),
  'guests',coalesce((select jsonb_agg(case when p_admin is true or x->>'created_by'=me.id::text then x else x-'vehicle_plate' end)
    from jsonb_array_elements(result->'guests') x where exists(select 1 from jsonb_array_elements(event_ids) e where e->>'id'=x->>'event_id')),'[]'::jsonb),
  'notices',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'notices') x where scope='all' or x->>'squad'=scope),'[]'::jsonb),
  'ledger',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'ledger') x where scope='all' or x->>'squad'=scope),'[]'::jsonb),
  'bibs',case when scope='main' then '[]'::jsonb else result->'bibs' end,
  'history',coalesce((select jsonb_agg(case when p_admin is true then x else x||jsonb_build_object('before_value',nullif(x->'before_value','null'::jsonb)-'vehicle_plate','after_value',nullif(x->'after_value','null'::jsonb)-'vehicle_plate') end)
    from jsonb_array_elements(result->'history') x where p_admin is true or x->>'squad'=scope),'[]'::jsonb));
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
 if scope='main' then me:=app_main_member(); end if;
 select data_version into v from team_config where id=1 for update;
 if p_version is distinct from v then raise exception '他の人の変更があります。更新してからもう一度入力してください' using errcode='40001'; end if;
 actual_actor:=case when scope='main' then me.name else p_actor end;
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
  if p_data->>'status'='yes' and p_data->>'car'='yes' and (select asks_car from events where id=target_event) then
   -- 番号を勝手に流用しない。画面で前回値を提示して保存する。
   plate:=app_validate_plate(p_data->>'vehicle_plate');
  end if;
 end if;
 if p_action='guest' then
  if item is not null then
   select * into g from team_guests where id=item;
   if scope='main' and g.created_by is distinct from me.id then raise exception 'このゲストの修正は追加者または管理者が行えます' using errcode='42501'; end if;
  end if;
  if scope='main' then p_data:=p_data||jsonb_build_object('invited_by',case when item is null then me.name else g.invited_by end); end if;
  if coalesce(p_data->>'status','yes')='yes' and coalesce((p_data->>'car')::boolean,false) and (select asks_car from events where id=target_event) then
   plate:=app_validate_plate(p_data->>'vehicle_plate');
  end if;
 end if;
 result:=app_team_write_core(p_key,p_admin,p_version,actual_actor,p_action,p_data);
 select max(id) into h_id from team_history;
 update team_history set squad=target_scope where id=h_id;
 if p_action='answer' then
  update attendance set vehicle_plate=plate where member_id=target_member and event_id=target_event;
  if plate<>'' then update members set vehicle_plate=plate where id=target_member; end if;
  update team_history set after_value=(select to_jsonb(a) from attendance a where member_id=target_member and event_id=target_event) where id=h_id;
 elsif p_action='guest' then
  item:=(select (after_value->>'id')::uuid from team_history where id=h_id);
  update team_guests set vehicle_plate=plate,created_by=case when p_data->>'id' is null and scope='main' then me.id else created_by end where id=item;
  update team_history set after_value=(select to_jsonb(x) from team_guests x where id=item) where id=h_id;
 elsif p_action='undo_answer' then
  original_plate:=coalesce(hist.before_value->>'vehicle_plate','');
  update attendance set vehicle_plate=case when car='yes' then original_plate else '' end where event_id=target_event and member_id=target_member;
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
