// SQL生成のみ。本番接続・実行・データ削除はしない。
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');const out=path.join(root,'work');fs.mkdirSync(out,{recursive:true});
let schema=fs.readFileSync(path.join(root,'db/schema.sql'),'utf8');
// 管理鍵を結果欄へ出さずに適用する。
schema=schema.replace(/^select admin_token as .*$/m,'');
const team=fs.readFileSync(path.join(root,'db/team.sql'),'utf8');
const access=fs.readFileSync(path.join(root,'db/access.sql'),'utf8');
fs.writeFileSync(path.join(out,'migration.sql'),`-- 承認後にSupabase SQL Editorで実行。既存の名簿や出欠は削除しない。\nBEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n${schema}\n${team}\n${access}\nNOTIFY pgrst, 'reload schema';\nCOMMIT;\nSELECT 'migration_complete' AS result;\n`);
console.log('work/migration.sql を生成しました（未実行・既存データ削除なし）。');
