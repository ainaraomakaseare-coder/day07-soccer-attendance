// ローカル専用・架空データ。メモリDBはプロセス終了時に消える。本番で公開しない。
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {createDB,rpc,root}=require('./team-fixture');
const port=Number(process.env.PREVIEW_PORT||8173);
const publicFiles=['team.html','team.css','js/export-template.js','js/export.js','js/team.js','js/team-model.js','js/db.js','js/auth.js','teian.html'];
(async()=>{
 const db=await createDB();
 const admin='a'.repeat(32),key='b'.repeat(32);
 await db.query("update team_config set team_name='FCアガペ（検証用）',admin_token=$1,shared_token=$2",[admin,key]);
 const write=async(action,payload)=>{const c=(await db.query('select data_version from team_config')).rows[0];return rpc(db,'team_write',{p_key:admin,p_admin:true,p_version:c.data_version,p_actor:'デモ担当',p_action:action,p_data:payload});};
 for(const [squad,names] of [['main',['テスト選手A','テスト選手B','テスト選手C','テストスタッフ']],['junior',['ジュニアA','ジュニアB','ジュニアスタッフ']]]){
  for(const name of names)await write('member',{name,squad,member_role:name.includes('スタッフ')?'staff':'player',affiliation:'サンプルクラブ',grade:squad==='junior'?'小3':''});
 }
 const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
 for(const [squad,n,place,car] of [['main',2,'泉スポーツセンター',true],['main',9,'中外',true],['junior',4,'ひぐみ体育館',false],['main',-8,'泉スポーツセンター',true]])await write('event',{squad,event_date:day(n),start_time:'17:00',end_time:'19:00',deadline:day(n-5),place,asks_car:car,booking_person:'デモ担当',note:'動作確認用の予定です。実際の予定ではありません。',cleaning:squad==='junior'});
 let h=await rpc(db,'team_home',{p_key:admin,p_admin:true});
 const m=h.members.find(m=>m.squad==='main'),j=h.members.find(m=>m.squad==='junior'),e=h.events.find(e=>e.event_date>=day(0)&&e.squad==='main');
 const uid='11111111-1111-4111-8111-111111111111';
 await db.query("insert into auth.users(id,email) values($1,'preview@example.com')",[uid]);
 await db.query("update members set email='preview@example.com',is_admin=true where id=$1",[m.id]);
 const signupUid='33333333-3333-4333-8333-333333333333';
 await db.query("insert into auth.users(id,email) values($1,'signup@example.com')",[signupUid]);
 await db.exec("update team_config set registration_code='2468'");
 await write('answer',{event_id:e.id,member_id:m.id,status:'yes',car:'yes',vehicle_plate:'横浜 300 あ 1234'});
 await write('guest',{event_id:e.id,name:'体験ゲスト',invited_by:'テスト選手B',status:'yes',car:false});
 await write('notice',{squad:'main',body:'飲み物を忘れずに。遅刻の連絡は各予定の回答欄に記入できます。',notice_date:day(0)});
 await write('ledger',{squad:'main',entry_date:day(-8),description:'体育館利用',expense:2600,fee:300,people:20});
 await write('bib',{number:'01',member_id:j.id,state:'loaned',loan_date:day(-3)});
 let queue=Promise.resolve();
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');const reply=(status,type,body)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);};
  if(req.method==='POST'&&url.pathname.startsWith('/rest/v1/rpc/')){
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>30000){reply(413,'text/plain','Too large');return;}}
   const task=async()=>{try{const args=JSON.parse(raw);reply(200,'application/json',JSON.stringify(await rpc(db,url.pathname.split('/').pop(),args,req.headers.authorization==='Bearer local-preview-user'?uid:req.headers.authorization==='Bearer local-preview-new'?signupUid:'')));}catch(e){reply(400,'application/json',JSON.stringify({message:e.message}));}};
   queue=queue.then(task,task);return;
  }
  if(url.pathname==='/config.local.js'){reply(200,'application/javascript',`window.APP_CONFIG={SUPABASE_URL:location.origin,SUPABASE_ANON_KEY:'preview-only'};`);return;}
  // この仮ログインはローカル検証サーバーだけが提供し、公開用ファイルには含めない。
  if(url.pathname==='/preview-auth.js'){reply(200,'application/javascript',`window.Auth={loggedIn:()=>true,token:async()=> 'local-preview-user',absorbRedirect:()=>({}),signOut:async()=>{},signIn:()=>{}};`);return;}
  if(url.pathname==='/preview-signup-auth.js'){reply(200,'application/javascript',`window.Auth={loggedIn:()=>true,token:async()=> 'local-preview-new',absorbRedirect:()=>({}),signOut:async()=>{},signIn:()=>{}};`);return;}
  const file=url.pathname==='/'?'team.html':url.pathname.slice(1);
  if(!publicFiles.includes(file)){reply(404,'text/plain','Not found');return;}
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  let body=fs.readFileSync(path.join(root,file));
  if(file==='team.html'&&url.searchParams.get('preview')==='main')body=body.toString().replace('./js/auth.js','./preview-auth.js').replace('<body>','<body><p style="padding:8px;text-align:center;background:#fff3cc">ローカル検証：仮ログイン（実際のGoogle認証ではありません）</p>');
  if(file==='team.html'&&url.searchParams.get('preview')==='join')body=body.toString().replace('./js/auth.js','./preview-signup-auth.js').replace('<body>','<body><p>ローカル検証：新規アカウントの仮ログイン</p>');
  reply(200,types[path.extname(file)],body);
 }).listen(port,'127.0.0.1',()=>console.log(`Local test only: http://127.0.0.1:${port}/team.html#team=${key}\nManager test: http://127.0.0.1:${port}/team.html#admin=${admin}`));
 const stop=()=>server.close(()=>db.close().then(()=>process.exit(0)));process.on('SIGINT',stop);process.on('SIGTERM',stop);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
