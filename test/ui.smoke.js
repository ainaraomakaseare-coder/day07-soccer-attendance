#!/usr/bin/env node
// 実ブラウザで画面を通しで動かすテスト。
//
// 準備:
//   1. PostgreSQL に db/schema.sql を流しておく
//   2. node test/fake-supabase.js を起動しておく（Supabase の代役）
//   3. node scripts/serve.js を起動しておく
//   4. node test/ui.smoke.js
//
// 確かめること：
//   マネージャーが予定を作る → メンバーがリンクから出席を押す
//   → ページを閉じて開き直しても出席のまま（＝データベースに残っている）

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const APP = process.env.APP_URL || 'http://localhost:8000';
const DB = process.env.PGDATABASE || 'soccer';

const psql = (q) =>
  execFileSync(process.env.PSQL || 'psql',
    ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q],
    { encoding: 'utf8' }).trim();

let passed = 0;
function check(label, cond) {
  if (!cond) throw new Error('失敗: ' + label);
  passed++;
  console.log('  ✓ ' + label);
}

(async () => {
  // まっさらから始める
  psql('delete from attendance; delete from events; delete from members;');
  const admin = psql('select admin_token from team_config where id = 1');

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw new Error('画面でエラー: ' + e.message); });

  try {
    console.log('\n[管理画面]');
    await page.goto(APP + '/admin.html#' + admin);
    await page.waitForSelector('.tabs');
    check('管理画面が開く', await page.locator('.title').isVisible());

    // --- メンバー登録 ---
    await page.getByRole('tab', { name: 'メンバー' }).click();
    await page.locator('#f-bulk').fill('山田 太郎\n佐藤 次郎\n鈴木 三郎');
    await page.getByRole('button', { name: 'まとめて登録' }).click();
    await page.waitForSelector('.mrow');
    check('3人が登録された', (await page.locator('.mrow').count()) === 3);

    // --- 予定登録 ---
    await page.getByRole('tab', { name: '予定' }).click();
    const d = new Date(Date.now() + 3 * 864e5);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
    await page.locator('#f-date').fill(iso);
    await page.locator('#f-time').fill('10:00');
    await page.locator('#f-kind').selectOption('match');
    await page.locator('#f-place').fill('河川敷グラウンド');
    await page.getByRole('button', { name: 'この予定を追加' }).click();
    await page.waitForSelector('.badge.match');
    check('予定が1件できた', (await page.locator('.badge.match').count()) === 1);
    check('未回答が3人と出る', (await page.locator('.nore').innerText()).includes('3人'));

    // --- 個人リンクを取る ---
    await page.getByRole('tab', { name: 'リンク配布' }).click();
    await page.waitForSelector('.link');
    const link = (await page.locator('.link').first().innerText()).trim();
    check('個人リンクが作られている', /#[0-9a-f]{32}$/.test(link));

    console.log('\n[メンバー画面]');
    const member = await ctx.newPage();
    member.on('pageerror', (e) => { throw new Error('画面でエラー: ' + e.message); });
    await member.goto(link.replace(/^https?:\/\/[^/]+/, APP));
    await member.waitForSelector('.pick');
    check('自分の名前が出る', (await member.locator('.me').innerText()).includes('山田'));
    check('最初はどちらも選ばれていない',
      (await member.locator('.pick .yes').getAttribute('aria-pressed')) === 'false');

    // --- 出席を押す ---
    await member.getByRole('button', { name: '出席' }).click();
    await member.waitForSelector('.pick .yes[aria-pressed="true"]');
    check('出席が選ばれた状態になる', true);
    check('出席1人と表示される', (await member.locator('.tally').innerText()).includes('出席 1'));

    // --- ここが今日の肝：閉じて開き直す ---
    await member.close();
    const again = await ctx.newPage();
    await again.goto(link.replace(/^https?:\/\/[^/]+/, APP));
    await again.waitForSelector('.pick');
    check('★ 開き直しても出席のまま（データベースに残っている）',
      (await again.locator('.pick .yes').getAttribute('aria-pressed')) === 'true');

    // --- ブラウザごと変えても残る（端末を変えた想定）---
    const other = await browser.newContext({ viewport: { width: 390, height: 850 } });
    const otherPage = await other.newPage();
    await otherPage.goto(link.replace(/^https?:\/\/[^/]+/, APP));
    await otherPage.waitForSelector('.pick');
    check('★ 別の端末から開いても出席のまま',
      (await otherPage.locator('.pick .yes').getAttribute('aria-pressed')) === 'true');
    await other.close();

    // --- もう一度押すと未回答に戻る ---
    await again.getByRole('button', { name: '出席' }).click();
    await again.waitForSelector('.pick .yes[aria-pressed="false"]');
    check('同じボタンをもう一度押すと未回答に戻る', true);

    await again.getByRole('button', { name: '欠席' }).click();
    await again.waitForSelector('.pick .no[aria-pressed="true"]');
    check('欠席に変えられる', true);

    // --- 誰が来るか見える ---
    await again.getByRole('button', { name: '誰が来る？' }).click();
    await again.waitForSelector('.roster .chip');
    check('メンバー3人分の状況が見える', (await again.locator('.roster .chip').count()) === 3);

    console.log('\n[管理画面に戻って確認]');
    await page.reload();
    await page.waitForSelector('.tabs');
    await page.getByRole('tab', { name: '予定' }).click();
    await page.waitForSelector('.tally');
    check('マネージャー側にも欠席1が見えている',
      (await page.locator('.tally').first().innerText()).includes('欠席 1'));

    // --- 代理入力 ---
    await page.getByRole('button', { name: '代理入力・修正' }).click();
    await page.waitForSelector('.prow');
    await page.locator('.prow').nth(1).getByRole('button', { name: '出席' }).click();
    await page.waitForSelector('.prow:nth-child(2) .yes[aria-pressed="true"]');
    check('マネージャーが代理で出席にできる', true);

    console.log('\n[リンクを作り直すと古いリンクが死ぬ]');
    psql("update members set token = replace(gen_random_uuid()::text,'-','') where name = '山田 太郎';");
    const dead = await ctx.newPage();
    await dead.goto(link.replace(/^https?:\/\/[^/]+/, APP));
    await dead.waitForSelector('.msg');
    check('作り直した後の古いリンクは開けない',
      (await dead.locator('.msg').innerText()).includes('正しくありません'));

    console.log('\n' + passed + ' 件すべて合格\n');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('\n' + e.message + '\n');
  process.exit(1);
});
