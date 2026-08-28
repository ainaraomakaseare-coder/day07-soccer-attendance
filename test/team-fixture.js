// 独立したメモリ内PostgreSQL。ネットワーク・本番DB・実ユーザー情報を使用しない。
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
async function createDB(beforeMigration){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now());
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated;`);
 if(beforeMigration)await beforeMigration(db);
 await db.exec(fs.readFileSync(path.join(root,'db/schema.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(root,'db/team.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(root,'db/access.sql'),'utf8'));
 return db;
}
async function rpc(db,fn,args,userId=''){
 const allowed={team_home:['p_key','p_admin'],team_write:['p_key','p_admin','p_version','p_actor','p_action','p_data'],admin_shared_link:['p_admin'],join_main:['p_code','p_name'],admin_registration_code:['p_admin','p_code']};
 if(!allowed[fn])throw new Error('Unsupported test RPC');
 const names=allowed[fn].filter(n=>Object.hasOwn(args,n));
 const sql=`select ${fn}(${names.map((n,i)=>`${n} => $${i+1}`).join(',')}) as result`;
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[userId]);
 await db.exec(userId?'set role authenticated':'set role anon');
 try{return (await db.query(sql,names.map(n=>n==='p_data'?JSON.stringify(args[n]):args[n]))).rows[0].result;}
 finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}
}
module.exports={createDB,rpc,root};
