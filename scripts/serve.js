#!/usr/bin/env node
// 手元で動かすための、ごく小さな置き場サーバー。
//
// なぜ必要か：HTML ファイルをダブルクリックで開くと file:// になり、
// ブラウザの安全装置でデータベースへの通信が弾かれることがあります。
// http:// で開けばその問題が起きません。

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 8000;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let rel = url === '/' ? '/index.html' : url;
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('見つかりません: ' + rel);
    return;
  }

  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log('');
  console.log('  出欠アプリを開きました');
  console.log('  管理画面 : http://localhost:' + port + '/admin.html#<管理用トークン>');
  console.log('  メンバー : http://localhost:' + port + '/#<個人トークン>');
  console.log('');
  console.log('  止めるときは Ctrl+C');
  console.log('');
});
