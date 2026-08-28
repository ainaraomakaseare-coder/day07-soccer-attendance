#!/usr/bin/env node
// テストをまとめて走らせる。足りないものがあれば、何を用意すればいいか案内する。
//
//   npm test
//
// 必要なもの：
//   - psql（PostgreSQL のクライアント）と、schema.sql を流したデータベース
//   - 画面のテストまで走らせるなら playwright

const { execFileSync, spawn } = require('child_process');
const path = require('path');
const http = require('http');

const fs = require('fs');

const root = path.join(__dirname, '..');
const DB = process.env.PGDATABASE || 'soccer';
const PSQL = process.env.PSQL || 'psql';
const FAKE = 'http://localhost:54321';
const CONFIG = path.join(root, 'config.local.js');

// この旧スイートは名簿・予定・auth.usersを削除する。明示した検証DB以外では実行しない。
if (process.env.ALLOW_DESTRUCTIVE_TESTS !== 'local-test-only') {
  console.error('旧テストは検証DBの全データを削除します。通常は npm test を使用してください。');
  console.error('使い捨て検証DBを用意した場合だけ ALLOW_DESTRUCTIVE_TESTS=local-test-only を設定してください。');
  process.exit(1);
}

function have(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function heading(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

// ---------- 1. データベースのテスト ----------
heading('データベースの動きと鍵のかかり具合');

if (!have(PSQL, ['--version'])) {
  console.error('psql が見つかりません。PostgreSQL のクライアントを入れるか、');
  console.error('PSQL 環境変数で場所を指定してください。');
  process.exit(1);
}

try {
  execFileSync(PSQL, ['-X', '-q', '-t', '-A', '-d', DB, '-c', 'select 1'], { stdio: 'ignore' });
} catch (e) {
  console.error('データベース "' + DB + '" に繋がりません。');
  console.error('');
  console.error('  ・接続先は PGHOST / PGPORT / PGUSER / PGDATABASE で指定します');
  console.error('  ・そのデータベースに db/schema.sql を流しておいてください');
  console.error('');
  process.exit(1);
}

try {
  const out = execFileSync(PSQL,
    ['-X', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', path.join(root, 'test', 'db.test.sql')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = (out + '').split('\n').filter((l) => l.includes('NOTICE'));
  for (const l of lines) console.log('  ' + l.replace(/^.*NOTICE:\s*/, ''));
  console.log('\n  データベース：合格');
} catch (e) {
  console.error((e.stdout || '') + (e.stderr || ''));
  console.error('\n  データベース：不合格');
  process.exit(1);
}

// ---------- 2. 画面のテスト ----------
heading('実ブラウザでの通し確認');

let playwrightOk = true;
try { require.resolve('playwright'); } catch (e) { playwrightOk = false; }

if (!playwrightOk) {
  console.log('  playwright が入っていないので飛ばします。');
  console.log('  走らせるなら: npm install --no-save playwright');
  console.log('\n  データベースのテストは合格しています。');
  process.exit(0);
}

// 起動したサーバーを止める。Windows とそれ以外でやり方が違う。
function stop(child) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid);
    }
  } catch (e) { /* すでに終了している */ }
}

const alive = (port) => new Promise((res) => {
  const r = http.get({ host: 'localhost', port, path: '/', timeout: 1200 }, () => res(true));
  r.on('error', () => res(false));
  r.on('timeout', () => { r.destroy(); res(false); });
});

// 画面のテストは Supabase の代役に向いていないと意味がない。
// 本番の接続先が入ったままだと、原因の分かりにくいタイムアウトになる。
// テストのあいだだけ差し替えて、終わったら必ず元に戻す。
function useTestConfig() {
  const before = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
  if (before && before.includes(FAKE)) return () => {};

  if (before) console.log('  接続先を一時的に代役へ切り替えます（終了時に戻します）');
  fs.writeFileSync(CONFIG, [
    '// テスト実行中の一時ファイルです。終わったら元に戻ります。',
    'window.APP_CONFIG = {',
    '  SUPABASE_URL: ' + JSON.stringify(FAKE) + ',',
    '  SUPABASE_ANON_KEY: "test-anon-key",',
    '};',
    '',
  ].join('\n'));

  return () => {
    if (before === null) fs.rmSync(CONFIG, { force: true });
    else fs.writeFileSync(CONFIG, before);
  };
}

(async () => {
  const started = [];
  const restoreConfig = useTestConfig();
  const need = [
    { port: 54321, script: 'test/fake-supabase.js', name: 'Supabase の代役' },
    { port: 8000, script: 'scripts/serve.js', name: '置き場サーバー' },
  ];

  for (const n of need) {
    if (await alive(n.port)) { console.log('  ' + n.name + ' は起動済み'); continue; }
    console.log('  ' + n.name + ' を起動します');
    const p = spawn(process.execPath, [path.join(root, n.script)],
      { cwd: root, stdio: 'ignore', detached: process.platform !== 'win32' });
    started.push(p);
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await alive(n.port)) break;
    }
  }

  try {
    execFileSync(process.execPath, [path.join(root, 'test', 'ui.smoke.js')],
      { cwd: root, stdio: 'inherit' });
    console.log('  画面：合格');
  } catch (e) {
    console.error('  画面：不合格');
    process.exitCode = 1;
  } finally {
    for (const p of started) stop(p);
    restoreConfig();
  }
})();
