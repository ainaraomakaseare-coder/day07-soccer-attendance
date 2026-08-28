const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {createDB,rpc,root}=require('./team-fixture');const M=require('../js/team-model');
test('main identity, junior scope, vehicle memory and guest permissions',async(t)=>{
 const db=await createDB();t.after(()=>db.close());
 const c=(await db.query('select * from team_config')).rows[0];
 const uid='11111111-1111-4111-8111-111111111111',otherUid='22222222-2222-4222-8222-222222222222';
 const home=(mode='main')=>rpc(db,'team_home',{p_key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',p_admin:mode==='admin'},mode==='main'?uid:mode==='other'?otherUid:'');
 const write=async(action,payload,mode='main',version)=>rpc(db,'team_write',{p_key:mode==='admin'?c.admin_token:mode==='junior'?c.shared_token:'',p_admin:mode==='admin',p_version:version??(await home(mode)).version,p_actor:'偽の入力者',p_action:action,p_data:payload},mode==='main'?uid:mode==='other'?otherUid:'');
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
  assert.equal(h.me.vehicle_plate,'横浜 300 あ 1234');assert.equal(h.answers.find(a=>a.member_id===mid).vehicle_plate,h.me.vehicle_plate);
  assert.equal(h.history[0].actor,'本人');
  h=await home('other');assert.equal(h.answers.find(a=>a.member_id===mid).vehicle_plate,undefined);assert.ok(!JSON.stringify(h.history).includes('横浜 300 あ 1234'));
  h=await write('answer',{event_id:eid,member_id:mid,status:'no'});assert.equal(h.me.vehicle_plate,'横浜 300 あ 1234');assert.equal(h.answers[0].vehicle_plate,'');
  const hist=h.history[0].id;
  await assert.rejects(write('undo_answer',{history_id:hist},'other'),/自分/);
  h=await write('undo_answer',{history_id:hist});assert.equal(h.answers[0].vehicle_plate,'横浜 300 あ 1234');
  h=await write('answer',{event_id:eid,member_id:other,status:'yes'},'admin');assert.ok(h.answers.some(a=>a.member_id===other));
 });
 await t.test('stale versions rejected on main and notices belong to self',async()=>{
  const h=await home();await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'no'});
  await assert.rejects(write('answer',{event_id:eid,member_id:mid,status:'no'},'main',h.version),/他の人/);
  await assert.rejects(write('notice',{squad:'main',member_id:other,body:'偽装',notice_date:'2026-09-01'}),/自分/);
  const saved=await write('notice',{squad:'main',member_id:mid,body:'遅れます',notice_date:'2026-09-01'});
  await assert.rejects(write('notice',{...saved.notices[0],member_id:other},'other'),/他の人/);
 });
 await t.test('guest creator is authenticated inviter; only creator/admin edits',async()=>{
  let h=await write('guest',{event_id:eid,name:'助っ人',invited_by:'偽装',status:'yes',car:true,vehicle_plate:'横浜 500 い 5678'});
  const g=h.guests[0];assert.equal(g.created_by,mid);assert.equal(g.invited_by,'本人');
  await assert.rejects(write('guest',{...g,name:'書き換え'},'other'),/追加者/);
  assert.equal((await home('other')).guests[0].vehicle_plate,undefined);
  h=await write('guest',{...g,note:'集合確認'});assert.equal(h.guests[0].note,'集合確認');
  h=await write('guest',{...g,status:'no'},'admin');assert.equal(h.guests[0].vehicle_plate,'');
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
  await db.query('update members set is_admin=false where id=$1',[mid]);
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
  let h=await write('answer',{event_id:eid,member_id:mid,status:'yes',car:'no',uses_bicycle:true});assert.equal(h.answers.find(a=>a.member_id===mid).uses_bicycle,true);
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
  const h=await write('archive_member',{id:member,active:false},true);assert.ok(h.answers.some(a=>a.member_id===member));
  await write('rotate_link',{},true);await assert.rejects(home(false));assert.ok((await home(true)).members.length);
 });
});
test('annual count: fiscal year boundary, only past/current days, no other-member answers',()=>{
 const d={year_start_month:4,events:[{id:'a',squad:'main',event_date:'2025-03-31'},{id:'b',squad:'main',event_date:'2025-04-01'},{id:'c',squad:'main',event_date:'2099-05-01'}],answers:[{event_id:'a',member_id:'m',status:'yes'},{event_id:'b',member_id:'m',status:'yes'},{event_id:'b',member_id:'n',status:'yes'},{event_id:'c',member_id:'m',status:'yes'}]};
 assert.equal(M.annual(d,{id:'m',squad:'main'},2025),1);assert.equal(M.annual(d,{id:'m',squad:'main'},2099),0);assert.equal(M.yearFor('2026-03-31',4),2025);
});
