#!/usr/bin/env node
// 公開用のファイルだけを dist/ に取り出す。
//
// なぜ必要か：
//   フォルダをまるごとアップロードすると、.env（接続情報の実物）や
//   test/ や db/ まで一緒に公開されてしまいます。
//   ここでは「ブラウザに配ってよいもの」だけを明示的に選んで移します。
//
//   使い方: npm run build

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

// 公開してよいものだけを、ここに列挙する。増やすときは中身を確かめてから。
const PUBLISH = ['index.html', 'admin.html', 'js/db.js', 'config.local.js'];

// 万一にも混ざってはいけないもの
const NEVER = ['.env', '.env.local', '.env.production'];

// まず .env か環境変数から config.local.js を作る
execFileSync(process.execPath, [path.join(__dirname, 'setup-config.js')], { stdio: 'inherit' });

fs.rmSync(dist, { recursive: true, force: true });

for (const rel of PUBLISH) {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) {
    console.error('見つかりません: ' + rel);
    process.exit(1);
  }
  const to = path.join(dist, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 念のため、出来上がった dist を検査する
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const shipped = walk(dist).map((f) => path.relative(dist, f));

for (const bad of NEVER) {
  if (shipped.includes(bad)) {
    console.error('危険：' + bad + ' が公開対象に入っています。中止しました。');
    process.exit(1);
  }
}

// 秘密の方のキーが紛れていないか、中身も見る（新旧どちらの呼び方も）
for (const rel of shipped) {
  const text = fs.readFileSync(path.join(dist, rel), 'utf8');
  for (const bad of ['service_role', 'sb_secret_']) {
    if (text.includes(bad)) {
      console.error('危険：' + rel + ' に ' + bad + ' が含まれています。中止しました。');
      process.exit(1);
    }
  }
}

console.log('');
console.log('dist/ に公開用のファイルを用意しました:');
for (const rel of shipped) console.log('  ' + rel);
console.log('');
console.log('この中に .env は入っていません。');
console.log('config.local.js には anon キーが入りますが、これはブラウザに配る前提のキーです。');
console.log('（守っているのは RLS です。README の「anon キーはブラウザに出ます」を参照）');
console.log('');
