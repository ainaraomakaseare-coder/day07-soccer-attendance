const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {createDB,rpc,root}=require('./team-fixture');const M=require('../js/team-model');
test('main identity, junior scope, vehicle memory and guest permissions',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const c=(await db.query('select * from team_config')).rows[0];
 const uid='11111111-1111-4111-8111-111111111111',otherUid='22222222-2222-4222-8222-222222222222';
 const home=(mode='main')=>rpc(db,'team_home',{p_key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',p_admin:mode==='admin'},mode==='main'?uid:mode==='other'?otherUid:'');
 const write=async(action,payload,mode='main',version)=>rpc(db,'team_write',{p_key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',p_admin:mode==='admin',p_version:version??(await home(mode)).version,p_actor:'偽の入力者',p_action:action,p_data:payload},mode==='main'?uid:mode==='other'?otherUid:'');
 const removeGuest=async(id,mode='main',version)=>rpc(db,'team_delete_guest',{p_key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',p_admin:mode==='admin',p_version:version??(await home(mode)).version,p_actor:'偽の入力者',p_id:id},mode==='main'?uid:mode==='other'?otherUid:'');
 await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[uid,'PLAYER@example.com',otherUid,'other@example.com']);
 let mid,other,jid,eid,jeid;
 await t.test('main needs verified registered email; mapping is automatic',async()=>{
  await assert.rejects(home(),/登録されていません/);
  let h=await write('member',{squad:'main',name:'本人',email:'player@example.com'},'admin');mid=h.members[0].id;
  h=await write('member',{squad:'main',name:'別の人',email:'other@example.com'},'admin');other=h.members.find(m=>m.name==='別の人').id;
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[uid]);
  await assert.rejects(home(),/登録されていません/);
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[uid]);
  h=await home();assert.equal(h.me.id,mid);assert.equal(h.scope,'main');
  assert.equal((await db.query('select auth_user_id from members where id=$1',[mid])).rows[0].auth_user_id,uid);
  await assert.rejects(rpc(db,'team_home',{p_key:'',p_admin:false}),/ログイン/);
  await home('other');
 });
 await t.test('junior visitors can register and answer junior only',async()=>{
  let h=await write('member',{squad:'junior',name:'ジュニア選手'},'junior');jid=h.members[0].id;
  h=await write('event',{squad:'main',event_date:'2026-09-01',asks_car:true},'admin');eid=h.events.find(e=>e.squad==='main').id;
  h=await write('event',{squad:'junior',event_date:'2026-09-02',asks_car:false},'admin');jeid=h.events.find(e=>e.squad==='junior').id;
  h=await write('answer',{event_id:jeid,member_id:jid,status:'yes'},'junior');assert.equal(h.answers[0].status,'yes');
  assert.equal(h.members.length,1);assert.equal(h.events.length,1);assert.equal(h.me,null);
  assert.ok(!JSON.stringify(h).includes(mid));
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'no'},'junior'),/グループ/);
  await assert.rejects(write('member',{squad:'main',name:'侵入'},'junior'),/グループ/);
  await assert.rejects(write('member',{squad:'junior',name:'侵入',email:'x@example.com'},'junior'));
 });
 await t.test('main can only answer self; admin may proxy; plate required and remembered',async()=>{
  await assert.rejects(write('answer',{event_id:eid,member_id:other,status:'yes'}),/自分/);
  await assert.rejects(write('member',{squad:'main',name:'自分で追加'}),/管理者/);
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'yes',car:'yes'}),/ナンバー/);
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'yes',car:'yes',vehicle_plate:'1234'}),/ナンバー/);
  let h=await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'yes',vehicle_plate:'横浜 300 あ 1234'});
  assert.equal(h.me.vehicle_plate,'横浜 300 あ 1234');assert.equal(h.me.has_vehicle_plate,true);assert.equal(h.answers.find(a=>a.member_id===mid).vehicle_plate,undefined);assert.equal((await home('admin')).answers.find(a=>a.member_id===mid).vehicle_plate,'横浜 300 あ 1234');
  assert.equal(h.history[0].actor,'本人');
  h=await home('other');assert.equal(h.answers.find(a=>a.member_id===mid).vehicle_plate,undefined);assert.ok(!JSON.stringify(h.history).includes('横浜 300 あ 1234'));
  h=await write('answer',{event_id:eid,member_id:mid,status:'no'});assert.equal(h.me.vehicle_plate,'横浜 300 あ 1234');assert.equal(h.me.has_vehicle_plate,true);assert.equal(h.answers[0].vehicle_plate,undefined);
  const hist=h.history[0].id;
  await assert.rejects(write('undo_answer',{history_id:hist},'other'),/自分/);
  h=await write('undo_answer',{history_id:hist});assert.equal(h.answers[0].vehicle_plate,undefined);assert.equal((await home('admin')).answers.find(a=>a.member_id===mid).vehicle_plate,'横浜 300 あ 1234');await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'yes'});
  h=await write('answer',{event_id:eid,member_id:other,status:'yes'},'admin');assert.ok(h.answers.some(a=>a.member_id===other));
 });
 await t.test('financial values and history are only returned to administrators',async()=>{
  await write('ledger',{squad:'main',entry_date:'2026-09-01',description:'非公開の会計',expense:9876,fee:300,people:2},'admin');
  const ah=await home('admin');assert.ok(ah.ledger.length);assert.ok(ah.history.some(h=>h.action==='ledger'));
  for(const mode of ['main','other','junior']){const h=await home(mode);assert.deepEqual(h.ledger,[]);assert.equal(h.main_opening,undefined);assert.equal(h.main_fee,undefined);assert.ok(!JSON.stringify(h).includes('非公開の会計'));assert.ok(!h.history.some(x=>['ledger','delete_ledger','settings'].includes(x.action)));}
 });
 await t.test('stale versions rejected on main and notices belong to self',async()=>{
  const h=await home();await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'no'});
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'no'},'main',h.version),/他の人/);
  await assert.rejects(write('notice',{squad:'main',member_id:other,body:'偽装',notice_date:'2026-09-01'}),/自分/);
  const saved=await write('notice',{squad:'main',member_id:mid,body:'遅れます',notice_date:'2026-09-01'});
  await assert.rejects(write('notice',{...saved.notices[0],member_id:other},'other'),/他の人/);
 });
 await t.test('guest creator is authenticated inviter; only creator/admin edits or deletes',async()=>{
  let h=await write('guest',{event_id:eid,name:'助っ人',invited_by:'偽装',status:'yes',car:true,vehicle_plate:'横浜 500 い 5678'});
  assert.ok(!JSON.stringify(h).includes('横浜 500 い 5678'));const g=h.guests[0];assert.equal(g.created_by,mid);assert.equal(g.invited_by,'本人');
  await assert.rejects(write('guest',{...g,name:'書き換え'},'other'),/追加者/);
  assert.equal((await home('other')).guests[0].vehicle_plate,undefined);
  h=await write('guest',{...g,note:'集合確認'});assert.equal(h.guests[0].note,'集合確認');
  h=await write('guest',{...g,status:'no'},'admin');assert.equal(h.guests[0].vehicle_plate,'');
  await assert.rejects(removeGuest(g.id,'other'),/追加者/);
  h=await removeGuest(g.id);assert.equal(h.guests.length,0);assert.equal(h.history[0].action,'delete_guest');
  h=await write('guest',{event_id:eid,name:'管理削除用',status:'no',car:false});
  h=await removeGuest(h.guests[0].id,'admin');assert.equal(h.guests.length,0);
 });
 await t.test('all old member entry points revoked; ordinary payloads contain no email',async()=>{
  const privileges=await db.query(`select proname,has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u from pg_proc where pronamespace='public'::regnamespace and proname in ('member_home','set_status','event_detail','claim_member','roster_by_code','claim_member_by_code','me_home','me_set_status','me_event_detail','me_set_name')`);
  assert.ok(privileges.rows.length>=10);for(const p of privileges.rows){assert.equal(p.a,false,p.proname);assert.equal(p.u,false,p.proname);}
  assert.ok(!JSON.stringify(await home()).includes('@example.com'));
  assert.ok(!JSON.stringify(await home('junior')).includes('@example.com'));
 });
 await t.test('Google admin role grants management, records real actor and cannot be self-granted',async()=>{
  const manage=(id)=>rpc(db,'team_home',{p_key:'',p_admin:true},id);
  await assert.rejects(manage(uid),/管理者/);
  await assert.rejects(manage(otherUid),/管理者/);
  await db.query('update members set is_admin=true where id=$1',[mid]);
  assert.equal((await home()).can_admin,true);
  let h=await manage(uid);assert.equal(h.me.id,mid);assert.equal(h.scope,'all');
  h=await rpc(db,'team_write',{p_key:'',p_admin:true,p_version:h.version,p_actor:'偽装',p_action:'answer',p_data:{event_id:eid,member_id:other,status:'no'}},uid);
  assert.equal(h.answers.find(a=>a.member_id===other).status,'no');assert.equal(h.history[0].actor,'本人');
  await write('member',{id:other,squad:'main',name:'別の人',is_admin:true},'admin');
  assert.equal((await home('other')).can_admin,false);await assert.rejects(manage(otherUid),/管理者/);
  await assert.rejects(write('grant_admin',{id:other},'other'),/管理者/);
  await assert.rejects(write('grant_admin',{id:other},'junior'),/管理者/);
  await assert.rejects(write('grant_admin',{id:jid},'admin'),/Googleメール/);
  const stale=(await manage(uid)).version;
  h=await rpc(db,'team_write',{p_key:'',p_admin:true,p_version:stale,p_actor:'偽装',p_action:'grant_admin',p_data:{id:other}},uid);
  assert.equal(h.members.find(m=>m.id===other).is_admin,true);assert.equal(h.history[0].action,'grant_admin');assert.equal(h.history[0].actor,'本人');
  assert.equal((await manage(otherUid)).can_admin,true);
  await assert.rejects(write('grant_admin',{id:other},'admin',stale),/他の人/);
  const count=(await db.query("select count(*)::int n from team_history where action='grant_admin'")).rows[0].n;
  await write('grant_admin',{id:other},'admin');
  assert.equal((await db.query("select count(*)::int n from team_history where action='grant_admin'")).rows[0].n,count);
  await db.query('update members set is_admin=false where id in ($1,$2)',[mid,other]);
  await assert.rejects(manage(uid),/管理者/);
 });
 await t.test('4 digit self-registration is authenticated, rate-limited, private and idempotent',async()=>{
  const newUid='33333333-3333-4333-8333-333333333333';
  await db.query("insert into auth.users(id,email) values($1,'new@example.com')",[newUid]);
  const code=(await home('admin')).registration_code;assert.match(code,/^\d{4}$/);
  assert.equal((await home()).registration_code,undefined);
  const bad=code==='0000'?'0001':'0000';
  await assert.rejects(rpc(db,'join_main',{p_code:code,p_name:'新規'}));
  for(let i=0;i<5;i++)assert.equal((await rpc(db,'join_main',{p_code:bad,p_name:'新規'},newUid)).ok,false);
  let r=await rpc(db,'join_main',{p_code:code,p_name:'新規'},newUid);assert.match(r.error,/15分/);
  await db.query("update team_signup_attempts set window_start=now()-interval '16 minutes' where user_id=$1",[newUid]);
  r=await rpc(db,'join_main',{p_code:code,p_name:'本人'},newUid);assert.match(r.error,/同じ名前/);
  r=await rpc(db,'join_main',{p_code:code,p_name:'新規'},newUid);assert.equal(r.ok,true);assert.equal(r.home.can_admin,false);
  const id=r.home.me.id;
  r=await rpc(db,'join_main',{p_code:code,p_name:'別名'},newUid);assert.equal(r.home.me.id,id);assert.equal(r.home.me.name,'新規');
  await assert.rejects(rpc(db,'admin_registration_code',{p_admin:'',p_code:'5678'},newUid),/管理者/);
  const changed=await rpc(db,'admin_registration_code',{p_admin:c.admin_token,p_code:'5678'});assert.equal(changed.registration_code,'5678');
  await assert.rejects(rpc(db,'admin_registration_code',{p_admin:c.admin_token,p_code:'12345'}),/4桁/);
 });
 await t.test('bicycle replies persist, clear on absence and restore with undo',async()=>{
  let h=await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'no',uses_bicycle:true,vehicle_plate:'品川 い 5678'});assert.equal(h.answers.find(a=>a.member_id===mid).uses_bicycle,true);assert.equal((await home('admin')).answers.find(a=>a.member_id===mid).vehicle_plate,'品川 い 5678');
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'yes',car:'yes',uses_bicycle:true,vehicle_plate:'横浜 300 あ 1234'}),/どちらか/);
  h=await write('answer',{event_id:eid,member_id:mid,status:'no',uses_bicycle:true});assert.equal(h.answers.find(a=>a.member_id===mid).uses_bicycle,false);
  h=await write('undo_answer',{history_id:h.history[0].id});assert.equal(h.answers.find(a=>a.member_id===mid).uses_bicycle,true);
 });
});
test('old four-table database upgrades without losing membership, answers or management key',async(t)=>{
 const db=await createDB(async(old)=>{
  const schema=fs.readFileSync(path.join(root,'db/schema.sql'),'utf8');
  await old.exec(schema.slice(0,schema.indexOf('-- Google アカウントとの紐付け先')));
  await old.exec(`insert into team_config(id,team_name,admin_token) values(1,'旧テストチーム','preserved-admin');
   insert into members(id,name,token) values('00000000-0000-0000-0000-000000000001','旧メンバー','preserved-member');
   insert into events(id,event_date) values('00000000-0000-0000-0000-000000000002','2026-08-01');
   insert into attendance(event_id,member_id,status) values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','yes');`);
 });t.after(()=>db.close());
 const config=(await db.query('select admin_token,shared_token from team_config')).rows[0];assert.equal(config.admin_token,'preserved-admin');
 const result=await rpc(db,'team_home',{p_key:config.admin_token,p_admin:true});
 assert.equal(result.members.length,1);assert.equal(result.events.length,1);assert.equal(result.answers[0].status,'yes');
});
test('isolated PostgreSQL: migration, legacy tests and team workflows',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const cfg=async()=> (await db.query('select * from team_config')).rows[0];
 let c=await cfg();const admin=c.admin_token;const key=c.shared_token;
 const home=(isAdmin=true)=>rpc(db,'team_home',{p_key:isAdmin?admin:key,p_admin:isAdmin});
 const write=async(action,data,isAdmin=true,version)=>rpc(db,'team_write',{p_key:isAdmin?admin:key,p_admin:isAdmin,p_version:version??(await home()).version,p_actor:'テスト入力者',p_action:action,p_data:data});
 await t.test('fresh initialization creates both keys and a six-digit code',async()=>{
  assert.match(c.join_code,/^\d{6}$/);assert.equal(key.length,32);assert.notEqual(key,admin);
 });
 await t.test('reapplying both SQL files preserves keys and data',async()=>{
  await db.exec(fs.readFileSync(path.join(root,'db/schema.sql'),'utf8'));await db.exec(fs.readFileSync(path.join(root,'db/team.sql'),'utf8'));
  assert.equal((await cfg()).shared_token,key);assert.equal((await cfg()).admin_token,admin);
 });
 await t.test('generated migration is transactional and does not print the admin key',async()=>{
  require('node:child_process').execFileSync(process.execPath,[path.join(root,'scripts/prepare-migration.js')]);
  const sql=fs.readFileSync(path.join(root,'work/migration.sql'),'utf8');
  assert.ok(sql.includes('BEGIN;'));assert.ok(sql.includes('COMMIT;'));assert.ok(!sql.includes('select admin_token as'));
  await db.exec(sql);assert.equal((await cfg()).admin_token,admin);assert.equal((await cfg()).shared_token,key);
 });
 await t.test('all original 33 DB cases pass',async()=>{
  await db.exec(fs.readFileSync(path.join(root,'test/db.test.sql'),'utf8').replace(/^\\.*$/mg,''));
  // 旧テストは管理トークンを変更するので検証環境だけ元に戻す。
  await db.query('update team_config set admin_token=$1',[admin]);
 });
 await t.test('all internal helpers reject anon/authenticated and RLS covers every application table',async()=>{
  const helpers=await db.query(`select proname,has_function_privilege('anon',oid,'execute') as a,has_function_privilege('authenticated',oid,'execute') as u from pg_proc where pronamespace='public'::regnamespace and starts_with(proname,'app_')`);
  assert.ok(helpers.rows.length>=8);for(const h of helpers.rows){assert.equal(h.a,false,h.proname);assert.equal(h.u,false,h.proname);}
  const tables=await db.query(`select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'`);
  for(const r of tables.rows)assert.equal(r.relrowsecurity,true,r.relname);
  await assert.rejects(rpc(db,'team_home',{p_key:'bad',p_admin:false}));
  await assert.rejects(rpc(db,'team_home',{p_key:key,p_admin:true}));
  for(const role of ['anon','authenticated']){
   await db.exec(`grant select,insert on all tables in schema public to ${role};set role ${role};`);
   try{
    const visible=(await db.query('select count(*) as n from team_config')).rows[0].n;assert.equal(Number(visible),0);
    await assert.rejects(db.query("insert into team_notices(squad,body) values('main','blocked')"));
   }finally{await db.exec('reset role');}
  }
 });
 let member,junior,event,jevent;
 await t.test('admin registers main and junior members without exposing tokens',async()=>{
  let h=await write('member',{name:'共同テスト',squad:'main',member_role:'player',jersey:'07'});member=h.members.find(m=>m.name==='共同テスト').id;
  h=await write('member',{name:'ジュニアテスト',squad:'junior',member_role:'player',grade:'小3'});junior=h.members.find(m=>m.name==='ジュニアテスト').id;
  assert.ok(!JSON.stringify(h).includes(admin));assert.ok(!JSON.stringify(h).includes(key));
  for(const m of h.members){assert.equal(m.token,undefined);assert.equal(m.auth_user_id,undefined);assert.equal(m.email,null);}
 });
 await t.test('admin creates group-specific events; normal visitors cannot',async()=>{
  await assert.rejects(write('event',{squad:'main',event_date:'2026-09-01'},false));
  let h=await write('event',{squad:'main',event_date:'2026-09-01',start_time:'17:00',end_time:'19:00',deadline:'2026-08-25',asks_car:true,booking_person:'予約担当'},true);event=h.events.at(-1).id;
  h=await write('event',{squad:'junior',event_date:'2026-09-02',asks_car:false,cleaning:true},true);jevent=h.events.find(e=>e.squad==='junior').id;
  await assert.rejects(write('event',{squad:'main',event_date:'2026-09-01',start_time:'19:00',end_time:'17:00'},true));
 });
 await t.test('proxy answers persist; absence clears cars; cross-group writes are blocked',async()=>{
  let h=await write('answer',{event_id:event,member_id:member,status:'yes',car:'yes',vehicle_plate:'横浜 300 あ 1234',note:'30分遅刻',confirmed:true});assert.equal(h.answers[0].car,'yes');
  h=await write('answer',{event_id:event,member_id:member,status:'no',car:'yes'});assert.equal(h.answers[0].car,null);
  await assert.rejects(write('answer',{event_id:event,member_id:junior,status:'yes'}));
  h=await write('answer',{event_id:jevent,member_id:junior,status:'yes',car:'yes'});assert.equal(h.answers.find(a=>a.member_id===junior).car,null);
 });
 await t.test('optimistic concurrency rejects stale edits and legacy updates also change version',async()=>{
  const version=(await home()).version;await write('answer',{event_id:event,member_id:member,status:'yes'});
  await assert.rejects(write('answer',{event_id:event,member_id:member,status:'no'},true,version),/他の人の変更/);
  const before=(await home()).version;await db.query("update attendance set note='legacy' where event_id=$1",[event]);assert.notEqual((await home()).version,before);
 });
 await t.test('answer undo restores prior value, and repeated or superseded undo fails',async()=>{
  let h=await write('answer',{event_id:event,member_id:member,status:'no'});const hist=h.history[0].id;
  h=await write('undo_answer',{history_id:hist});assert.equal(h.answers.find(a=>a.member_id===member).status,'yes');
  await assert.rejects(write('undo_answer',{history_id:hist}));
 });
 await t.test('event guests and cars aggregate independently of registered members',async()=>{
  const h=await write('guest',{event_id:event,name:'助っ人テスト',invited_by:'声掛けテスト',status:'yes',car:true,vehicle_plate:'横浜 300 あ 5678'});
  const counts=M.count(h,h.events.find(e=>e.id===event));assert.equal(counts.guests,1);assert.equal(counts.total,2);assert.equal(counts.cars,1);
 });
 await t.test('notices support confirmation and resolution',async()=>{
  let h=await write('notice',{squad:'main',member_id:member,body:'集合場所を確認',notice_date:'2026-09-01'});const n=h.notices[0];
  h=await write('notice',{...n,confirmed:true,resolved:true});assert.equal(h.notices[0].confirmed_by,'テスト入力者');assert.equal(h.notices[0].resolved,true);
 });
 await t.test('ledger is admin-only; receipts, planned balances and group isolation work',async()=>{
  const row={squad:'main',entry_date:'2026-09-01',description:'体育館',expense:2600,fee:300,people:20};
  await assert.rejects(write('ledger',row,false));await write('ledger',row,true);
  const h=await write('ledger',{...row,description:'予定',planned:true,income:0,expense:1000},true);
  const result=M.ledger(h,'main');assert.equal(result.balance,3400);assert.equal(result.projected,2400);assert.equal(M.ledger(h,'junior').balance,0);
 });
 await t.test('bib assignment, return workflow and duplicate numbers',async()=>{
  let h=await write('bib',{number:'01',member_id:junior,state:'loaned',loan_date:'2026-08-28'});const b=h.bibs[0];
  h=await write('bib',{...b,state:'returned',return_date:'2026-09-01'});assert.equal(h.bibs[0].state,'returned');
  await assert.rejects(write('bib',{number:'01',state:'available'}));
  await assert.rejects(write('bib',{number:'02',member_id:member,state:'loaned'}));
 });
 await t.test('archive keeps records; ordinary users cannot archive; token rotation revokes old link',async()=>{
  await assert.rejects(write('archive_member',{id:member,active:false},false));
  await assert.rejects(write('delete_member',{id:member},true),/先にメンバーを削除済み/);
  const h=await write('archive_member',{id:member,active:false},true);assert.ok(h.answers.some(a=>a.member_id===member));
  await assert.rejects(write('delete_member',{id:member},false),/管理者/);
  const deleted=await write('delete_member',{id:member},true);assert.ok(!deleted.members.some(m=>m.id===member));assert.ok(!deleted.answers.some(a=>a.member_id===member));assert.equal(deleted.history[0].action,'delete_member');
  await write('rotate_link',{},true);await assert.rejects(home(false));assert.ok((await home(true)).members.length);
 });
});
test('annual count: fiscal year boundary, only past/current days, no other-member answers',()=>{
 const d={year_start_month:4,events:[{id:'a',squad:'main',event_date:'2025-03-31'},{id:'b',squad:'main',event_date:'2025-04-01'},{id:'c',squad:'main',event_date:'2099-05-01'}],answers:[{event_id:'a',member_id:'m',status:'yes'},{event_id:'b',member_id:'m',status:'yes'},{event_id:'b',member_id:'n',status:'yes'},{event_id:'c',member_id:'m',status:'yes'}]};
 assert.equal(M.annual(d,{id:'m',squad:'main'},2025),1);assert.equal(M.annual(d,{id:'m',squad:'main'},2099),0);assert.equal(M.yearFor('2026-03-31',4),2025);
});
test('participation points: charge, request, consumption, zero-balance block and privacy',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const c=(await db.query('select * from team_config')).rows[0];
 const uid='44444444-4444-4444-8444-444444444444',otherUid='55555555-5555-4555-8555-555555555555';
 await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[uid,'pt@example.com',otherUid,'pt2@example.com']);
 const as=mode=>({key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',admin:mode==='admin',user:mode==='main'?uid:mode==='other'?otherUid:''});
 const home=(mode='main')=>{const a=as(mode);return rpc(db,'team_home',{p_key:a.key,p_admin:a.admin},a.user);};
 const write=async(action,payload,mode='main')=>{const a=as(mode);return rpc(db,'team_write',{p_key:a.key,p_admin:a.admin,p_version:(await home(mode)).version,p_actor:'会計係',p_action:action,p_data:payload},a.user);};
 const points=async(action,payload,mode='main')=>{const a=as(mode);return rpc(db,'team_points',{p_key:a.key,p_admin:a.admin,p_version:(await home(mode)).version,p_actor:'会計係',p_action:action,p_data:payload},a.user);};
 let h=await write('member',{squad:'main',name:'ポイント本人',email:'pt@example.com'},'admin');const mid=h.members[0].id;
 h=await write('member',{squad:'main',name:'ポイント別人',email:'pt2@example.com'},'admin');const other=h.members.find(m=>m.name==='ポイント別人').id;
 const ev={};
 for(const d of ['2026-11-29','2026-12-01','2026-12-06','2026-12-13']){h=await write('event',{squad:'main',event_date:d,asks_car:false},'admin');ev[d]=h.events.find(e=>e.event_date===d).id;}
 h=await write('event',{squad:'junior',event_date:'2026-12-02'},'admin');const jev=h.events.find(e=>e.squad==='junior').id;
 const mine=async()=>(await home()).me.points;
 await t.test('starts at zero; answers before the start date are free',async()=>{
  assert.equal((await home()).points_start,'2026-12-01');
  assert.deepEqual(await mine(),{total:0,used:0,remaining:0});
  await write('answer',{event_id:ev['2026-11-29'],member_id:mid,status:'yes'});
  assert.deepEqual(await mine(),{total:0,used:0,remaining:0});
  await assert.rejects(write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'yes'}),/ポイント残数が0/);
  await assert.rejects(write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'yes'},'admin'),/ポイント残数が0/);
  await write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'no'});
 });
 await t.test('members request a charge; only admins grant points',async()=>{
  await assert.rejects(points('request',{amount:3000}),/2000円単位/);
  await assert.rejects(points('request',{amount:0}),/2000円単位/);
  h=await points('request',{amount:4000});assert.equal(h.my_point_requests[0].amount,4000);
  await assert.rejects(points('request',{amount:2000}),/申請中/);
  await assert.rejects(points('charge',{member_id:mid,amount:4000}),/管理者/);
  await assert.rejects(points('adjust',{member_ids:[mid],delta:5,reason:'不正'}),/管理者/);
  const a=await home('admin');assert.equal(a.point_requests.length,1);assert.equal(a.point_requests[0].member_id,mid);
  await assert.rejects(points('charge',{member_id:other,amount:4000,request_id:a.point_requests[0].id},'admin'),/追加申請/);
  await assert.rejects(points('charge',{member_id:mid,amount:5000},'admin'),/2000円単位/);
  h=await points('charge',{member_id:mid,amount:4000,request_id:a.point_requests[0].id,ledger:true},'admin');
  assert.deepEqual(h.points[mid],{total:22,used:0,remaining:22});assert.equal(h.point_requests.length,0);
  const l=h.ledger.find(x=>x.description==='チャージ（ポイント本人）');assert.equal(l.income,4000);assert.equal(l.squad,'main');assert.equal(l.planned,false);
  assert.equal(h.history[0].action,'points_charge');assert.equal(h.history[0].after_value.delta,22);
  h=await home();assert.deepEqual(h.me.points,{total:22,used:0,remaining:22});assert.deepEqual(h.my_point_requests,[]);
  await points('charge',{member_id:other,amount:2000},'admin');
  assert.equal((await home('admin')).ledger.filter(x=>x.description.startsWith('チャージ')).length,1);
 });
 await t.test('attending consumes a point, including future events; re-saving does not double count',async()=>{
  await write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'yes'});
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'yes'});
  assert.deepEqual(await mine(),{total:22,used:2,remaining:20});
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'yes',note:'遅刻します'});
  assert.deepEqual(await mine(),{total:22,used:2,remaining:20});
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'no'});
  assert.deepEqual(await mine(),{total:22,used:1,remaining:21});
  await write('answer',{event_id:jev,member_id:(await write('member',{squad:'junior',name:'Jr'},'admin')).members.find(m=>m.squad==='junior').id,status:'yes'},'admin');
 });
 await t.test('adjust selected members; reaching zero blocks new attendance until topped up',async()=>{
  await assert.rejects(points('adjust',{member_ids:[mid],delta:0,reason:'x'},'admin'),/0以外/);
  await assert.rejects(points('adjust',{member_ids:[mid],delta:-21,reason:''},'admin'),/理由/);
  await assert.rejects(points('adjust',{member_ids:[],delta:1,reason:'x'},'admin'),/メンバー/);
  h=await points('adjust',{member_ids:[mid],delta:-21,reason:'入力ミスの修正'},'admin');assert.equal(h.points[mid].remaining,0);
  await assert.rejects(write('answer',{event_id:ev['2026-12-06'],member_id:mid,status:'yes'}),/ポイント残数が0/);
  // 既に出席の予定は残数0でも内容を直せる
  await write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'yes',note:'変更'});
  h=await points('adjust',{member_ids:[mid,other],delta:1,reason:'無料デー'},'admin');
  assert.equal(h.points[mid].remaining,1);assert.equal(h.points[other].total,12);
  await write('answer',{event_id:ev['2026-12-06'],member_id:mid,status:'yes'});
  assert.equal((await mine()).remaining,0);
  // 欠席に変えた後、残数0のまま出席へ取り消すことはできない
  await write('answer',{event_id:ev['2026-12-06'],member_id:mid,status:'no'});
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'yes'});
  const hist=(await home()).history.find(x=>x.action==='answer'&&x.entity.includes(ev['2026-12-06'])).id;
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'no'});
  await write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'no'});
  await write('answer',{event_id:ev['2026-12-13'],member_id:mid,status:'yes'});await write('answer',{event_id:ev['2026-12-01'],member_id:mid,status:'yes'});
  assert.equal((await mine()).remaining,-1+1);
  await assert.rejects(write('undo_answer',{history_id:hist}),/ポイント残数が0/);
 });
 await t.test('cancelling requests and privacy of balances',async()=>{
  h=await points('request',{amount:2000});const id=h.my_point_requests[0].id;
  await assert.rejects(points('cancel_request',{id},'other'),/自分/);
  h=await points('cancel_request',{id});assert.deepEqual(h.my_point_requests,[]);
  h=await home('other');assert.equal(h.points,undefined);assert.equal(h.point_requests,undefined);assert.equal(h.me.points.total,12);
  assert.ok(!h.history.some(x=>x.action.startsWith('points_')));assert.deepEqual(h.ledger,[]);
  const j=await home('junior');assert.equal(j.points_start,undefined);assert.equal(j.points,undefined);
  await assert.rejects(rpc(db,'team_points',{p_key:c.shared_token,p_admin:false,p_version:j.version,p_actor:'x',p_action:'request',p_data:{amount:2000}}),/メイン/);
  await assert.rejects(rpc(db,'team_points',{p_key:'',p_admin:false,p_version:j.version,p_actor:'x',p_action:'request',p_data:{amount:2000}}),/ログイン/);
  await assert.rejects(rpc(db,'team_points',{p_key:'',p_admin:false,p_version:0,p_actor:'x',p_action:'request',p_data:{amount:2000}},uid),/他の人/);
 });
 await t.test('admin can move or disable the start date from settings',async()=>{
  const a=await home('admin');
  const base={year_start_month:a.year_start_month,main_fee:200,junior_fee:a.junior_fee,main_opening:a.main_opening,junior_opening:a.junior_opening,bib_guide:a.bib_guide};
  await assert.rejects(write('settings',{...base,points_start:''}),/管理者/);
  h=await write('settings',{...base,points_start:''},'admin');assert.equal(h.points_start,null);assert.equal(h.main_fee,200);
  await write('answer',{event_id:ev['2026-12-06'],member_id:mid,status:'yes'});
  assert.equal((await mine()).used,0);
  h=await write('settings',{...base,points_start:'2026-12-01'},'admin');assert.equal(h.points[mid].used,3);
  h=await write('settings',base,'admin');assert.equal(h.points_start,'2026-12-01');
 });
});
test('points: non-target events, charges entered in the ledger and the public finance summary',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const c=(await db.query('select * from team_config')).rows[0];
 const uid='66666666-6666-4666-8666-666666666666';
 await db.query('insert into auth.users(id,email) values($1,$2)',[uid,'acc@example.com']);
 const as=mode=>({key:mode==='admin'?c.admin_token:'',admin:mode==='admin',user:mode==='main'?uid:''});
 const home=(mode='main')=>{const a=as(mode);return rpc(db,'team_home',{p_key:a.key,p_admin:a.admin},a.user);};
 const write=async(action,payload,mode='main')=>{const a=as(mode);return rpc(db,'team_write',{p_key:a.key,p_admin:a.admin,p_version:(await home(mode)).version,p_actor:'会計係',p_action:action,p_data:payload},a.user);};
 const points=async(action,payload,mode='main')=>{const a=as(mode);return rpc(db,'team_points',{p_key:a.key,p_admin:a.admin,p_version:(await home(mode)).version,p_actor:'会計係',p_action:action,p_data:payload},a.user);};
 let h=await write('member',{squad:'main',name:'会計本人',email:'acc@example.com'},'admin');const mid=h.members[0].id;
 h=await write('event',{squad:'main',event_date:'2026-12-29',asks_car:false,points_target:false},'admin');const tour=h.events[0].id;
 assert.equal(h.events[0].points_target,false);
 h=await write('event',{squad:'main',event_date:'2026-12-06',asks_car:false},'admin');const prac=h.events.find(e=>e.id!==tour).id;
 assert.equal(h.events.find(e=>e.id===prac).points_target,true);
 await t.test('events outside the point system neither block nor consume',async()=>{
  await write('answer',{event_id:tour,member_id:mid,status:'yes'});
  assert.deepEqual((await home()).me.points,{total:0,used:0,remaining:0});
  await assert.rejects(write('answer',{event_id:prac,member_id:mid,status:'yes'}),/ポイント残数が0/);
  // 後から対象に戻すと、その予定の出席分が消費に入る
  const e=(await home('admin')).events.find(x=>x.id===tour);
  h=await write('event',{...e,points_target:true},'admin');assert.equal(h.points[mid].remaining,-1);
  h=await write('event',{...e,points_target:false},'admin');assert.equal(h.points[mid].remaining,0);
 });
 await t.test('a charge entered in the ledger grants points; edits and deletion follow it',async()=>{
  const base={squad:'main',entry_date:'2026-12-01',description:'チャージ（会計本人）',expense:0,fee:0,people:0};
  await assert.rejects(write('ledger',{...base,income:3000,charge_member_id:mid},'admin'),/2000円単位/);
  await assert.rejects(write('ledger',{...base,income:2000,expense:100,charge_member_id:mid},'admin'),/支出を0/);
  await assert.rejects(write('ledger',{...base,squad:'junior',income:2000,charge_member_id:mid},'admin'),/メイン会計/);
  h=await points('request',{amount:4000});const req=h.my_point_requests[0].id;
  h=await write('ledger',{...base,income:4000,charge_member_id:mid,point_request_id:req},'admin');
  const row=h.ledger.find(l=>l.charge_member_id===mid);
  assert.deepEqual(h.points[mid],{total:22,used:0,remaining:22});assert.equal(h.point_requests.length,0);
  h=await write('ledger',{...row,income:2000,charge_member_id:mid},'admin');assert.equal(h.points[mid].total,11);
  h=await write('ledger',{...row,income:2000,charge_member_id:mid,planned:true},'admin');assert.equal(h.points[mid].total,0);
  h=await write('ledger',{...row,income:2000,charge_member_id:mid,planned:false},'admin');assert.equal(h.points[mid].total,11);
  h=await write('ledger',{...row,income:2000,charge_member_id:''},'admin');assert.equal(h.points[mid].total,0);
  h=await write('ledger',{...row,income:2000,charge_member_id:mid},'admin');assert.equal(h.points[mid].total,11);
  h=await write('delete_ledger',{id:row.id},'admin');assert.equal(h.points[mid].total,0);
  // ボタンからのチャージも会計の行と結びつき、行を消すとポイントも消える
  h=await points('charge',{member_id:mid,amount:2000,ledger:true},'admin');
  const linked=h.ledger.find(l=>l.charge_member_id===mid);assert.ok(linked);assert.equal(h.points[mid].total,11);
  h=await write('ledger',{...linked,note:'メモ追記'},'admin');assert.equal(h.points[mid].total,11);
  h=await points('charge',{member_id:mid,amount:2000},'admin');assert.equal(h.points[mid].total,22);
  h=await write('delete_ledger',{id:linked.id},'admin');assert.equal(h.points[mid].total,11);
 });
 await t.test('everyone sees the finance summary, but not the ledger rows',async()=>{
  await write('settings',{year_start_month:4,main_fee:200,junior_fee:100,main_opening:10000,junior_opening:0,bib_guide:''},'admin');
  await write('ledger',{squad:'main',entry_date:'2026-12-06',description:'体育館',expense:2600,fee:0,people:0},'admin');
  await write('ledger',{squad:'main',entry_date:'2026-12-20',description:'未確定',expense:5000,fee:0,people:0,planned:true},'admin');
  // 口座：10000 + 2000（ボタンチャージ分は行を消したので0）… 実際の行で検算する
  const a=await home('admin');const account=M.ledger(a,'main').balance;
  await write('answer',{event_id:prac,member_id:mid,status:'yes'});
  const me=await home();assert.deepEqual(me.ledger,[]);
  assert.equal(me.finance.account_balance,account);assert.equal(me.points_start,'2026-12-01');
  assert.equal(me.me.points.remaining,10);
  assert.equal(me.finance.charge_balance,10*200);assert.equal(me.finance.surplus,account-2000);
  assert.ok(!JSON.stringify(me).includes('体育館'));
 });
});
test('points migration links earlier button charges to their ledger rows',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const c=(await db.query('select * from team_config')).rows[0];
 const call=async(fn,action,data)=>rpc(db,fn,{p_key:c.admin_token,p_admin:true,p_version:(await rpc(db,'team_home',{p_key:c.admin_token,p_admin:true})).version,p_actor:'会計係',p_action:action,p_data:data});
 let h=await call('team_write','member',{squad:'main',name:'旧チャージ'});const mid=h.members[0].id;
 h=await call('team_points','charge',{member_id:mid,amount:2000,ledger:true});
 await db.exec('update team_ledger set charge_member_id=null');
 await db.exec(fs.readFileSync(path.join(root,'db/points.sql'),'utf8'));
 h=await rpc(db,'team_home',{p_key:c.admin_token,p_admin:true});const row=h.ledger[0];
 assert.equal(row.charge_member_id,mid);
 h=await call('team_write','ledger',{...row,note:'修正'});assert.equal(h.points[mid].total,11);
});
