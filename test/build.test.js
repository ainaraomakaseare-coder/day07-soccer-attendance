const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');
test('main-only UI hides junior entry and ignores previously selected junior group',async()=>{
 const vm=require('node:vm');const source=fs.readFileSync(path.join(root,'js/team.js'),'utf8');
 async function page(hash){
  const elements={app:{innerHTML:''},editor:{showModal(){},close(){}},fields:{innerHTML:''},'form-error':{textContent:''},'edit-form':{elements:{}},toast:{style:{},textContent:''}};
  const handlers={};let calls=0;
  const home={team:'検証チーム',scope:'all',members:[],events:[],answers:[],guests:[],history:[],notices:[],ledger:[],bibs:[],year_start_month:4,main_fee:300,main_opening:0,junior_fee:100,junior_opening:123,bib_guide:'保存対象'};
  const context={console,URLSearchParams,Intl,Date,setTimeout,clearTimeout,location:{hash,pathname:'/team.html',origin:'http://localhost'},localStorage:{getItem:()=> 'junior',setItem(){}},document:{getElementById:id=>elements[id],querySelector:()=>({}),addEventListener:(name,fn)=>handlers[name]=fn},Auth:{absorbRedirect:()=>({}),loggedIn:()=>false},DB:{ready:()=>true,rpc:async()=>{calls++;return home;}}};
  context.window={TeamModel:require('../js/team-model'),addEventListener(){}};
  vm.runInNewContext(source,context);await new Promise(setImmediate);
  return {elements,handlers,calls};
 }
 const gate=await page('');assert.ok(!gate.elements.app.innerHTML.includes('ジュニアはこちら'));assert.ok(gate.elements.app.innerHTML.includes('Googleでログイン'));
 const old=await page('#team='+'b'.repeat(32));assert.equal(old.calls,0);assert.ok(old.elements.app.innerHTML.includes('今回の対象外'));
 const admin=await page('#admin='+'a'.repeat(32));assert.equal(admin.calls,1);assert.ok(!admin.elements.app.innerHTML.includes('data-squad'));assert.ok(!admin.elements.app.innerHTML.includes('ビブス'));
 await admin.handlers.click({target:{closest:()=>({dataset:{action:'tab',tab:'settings'}})}});
 assert.ok(admin.elements.app.innerHTML.includes('メンバー用URLをコピー'));assert.ok(!admin.elements.app.innerHTML.includes('ジュニア'));
 await admin.handlers.click({target:{closest:()=>({dataset:{action:'settings-edit'}})}});
 assert.ok(!admin.elements.fields.innerHTML.includes('junior_fee'));
});
test('publish whitelist includes team assets but never SQL, tests or secrets',()=>{
 // 空の一時コピーだけでビルドする。本番のconfig.local.jsやdistに触れない。
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agape-build-test-'));
 const files=['index.html','admin.html','teian.html','team.html','team.css','js/db.js','js/auth.js','js/team.js','js/team-model.js','scripts/setup-config.js','scripts/build.js'];
 for(const f of files){const to=path.join(temp,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(root,f),to);}
 const env={...process.env,SUPABASE_URL:'https://build-test.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_build_test_not_real'};
 execFileSync(process.execPath,[path.join(temp,'scripts/build.js')],{env,stdio:'pipe'});
 const dist=path.join(temp,'dist');
 for(const f of files.filter(f=>!f.startsWith('scripts/')))assert.ok(fs.existsSync(path.join(dist,f)),f);
 for(const f of ['.env','db','test','node_modules'])assert.equal(fs.existsSync(path.join(dist,f)),false);
 assert.equal(fs.existsSync(path.join(dist,'preview-auth.js')),false);
 for(const f of files.filter(f=>!f.startsWith('scripts/')))assert.ok(!fs.readFileSync(path.join(dist,f),'utf8').includes('local-preview-user'),f);
 assert.throws(()=>execFileSync(process.execPath,[path.join(temp,'scripts/build.js')],{env:{...env,SUPABASE_ANON_KEY:'sb_secret_test_only'},stdio:'pipe'}));
 // テスト生成物のみを検証して削除。シンボリックリンクをたどらない。
 const target=path.resolve(temp),base=path.resolve(os.tmpdir())+path.sep;
 assert.ok(target.startsWith(base)&&path.basename(target).startsWith('agape-build-test-'));
 fs.rmSync(target,{recursive:true,force:true});
});
