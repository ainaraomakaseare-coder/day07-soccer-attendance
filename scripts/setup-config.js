#!/usr/bin/env node
// .env を読んで config.local.js を作る。
//
// なぜこんな回り道をするのか：
//   ブラウザで開くだけの HTML は「環境変数」を直接読めません。
//   なので .env（GitHubに上げない場所）に本物の値を置いておき、
//   このスクリプトが手元で config.local.js に書き出します。
//   config.local.js も .gitignore 済みなので、GitHub には出ません。
//
// あとでインターネットに公開するときは、公開先の管理画面に同じ名前の
// 環境変数を登録して、このスクリプトを実行する形に繋がります。

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const outPath = path.join(root, 'config.local.js');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fromFile = readEnvFile(envPath);
const rawUrl = process.env.SUPABASE_URL || fromFile.SUPABASE_URL || '';
const key = process.env.SUPABASE_ANON_KEY || fromFile.SUPABASE_ANON_KEY || '';

// Supabase の管理画面（Data API のページ）は URL を
//   https://xxxx.supabase.co/rest/v1/
// の形で見せる。そのまま貼られることが多いので、末尾を落として揃える。
// このアプリは /rest/v1/rpc/... を自分で付けるため、残っていると二重になる。
function tidyUrl(u) {
  let out = String(u).trim().replace(/\/+$/, '');
  const cut = out.replace(/\/rest\/v1$/, '');
  if (cut !== out) {
    console.log('SUPABASE_URL の末尾にあった /rest/v1 を外しました。');
    out = cut;
  }
  return out;
}

const url = tidyUrl(rawUrl);

const missing = [];
if (!url) missing.push('SUPABASE_URL');
if (!key) missing.push('SUPABASE_ANON_KEY');

if (missing.length) {
  console.error('');
  console.error('設定が足りません: ' + missing.join(', '));
  console.error('');
  console.error('  1. cp .env.example .env');
  console.error('  2. .env を開いて、Supabase の Project URL と anon キーを書く');
  console.error('  3. npm run setup をもう一度実行する');
  console.error('');
  process.exit(1);
}

// 秘密の方のキーが指定されていたら止める。
// Supabase には新旧2つの呼び方があるので、どちらも見る。
//   旧: anon public（安全） / service_role（秘密）
//   新: sb_publishable_…（安全） / sb_secret_…（秘密）
if (key.includes('service_role') || key.startsWith('sb_secret_')) {
  console.error('');
  console.error('秘密の方のキーが指定されています。これは使えません。');
  console.error('ブラウザに配るので、必ず公開してよい方のキーにしてください。');
  console.error('');
  console.error('  使う   : anon public  または  sb_publishable_… で始まるもの');
  console.error('  使わない: service_role  または  sb_secret_… で始まるもの');
  console.error('');
  process.exit(1);
}

if (url && !/^https?:\/\//.test(url)) {
  console.error('');
  console.error('SUPABASE_URL が https:// で始まっていません: ' + url);
  console.error('Supabase の Settings → Data API にある Project URL を貼ってください。');
  console.error('');
  process.exit(1);
}

fs.writeFileSync(outPath, [
  '// このファイルは npm run setup が .env から自動生成しました。',
  '// 直接編集しないでください。GitHub には上がりません（.gitignore 済み）。',
  'window.APP_CONFIG = {',
  '  SUPABASE_URL: ' + JSON.stringify(url) + ',',
  '  SUPABASE_ANON_KEY: ' + JSON.stringify(key) + ',',
  '};',
  '',
].join('\n'));

console.log('config.local.js を作りました。');
console.log('  接続先: ' + url);
console.log('  キー  : ' + key.slice(0, 8) + '…（以降は伏せます）');
