// Supabase との通信。ライブラリは使わず、素の fetch だけで書いています。
//
// このアプリはテーブルを直接触りません。schema.sql で作った「関数」だけを呼びます。
// 呼び先は  <プロジェクトURL>/rest/v1/rpc/<関数名>  です。
//
// anon キーはブラウザに渡る前提のキーです（Supabase がそう設計しています）。
// 守っているのはキーの秘密ではなく、データベース側の RLS と、
// 関数の中でトークンを確かめている処理の方です。

(function () {
  const cfg = window.APP_CONFIG || {};

  window.DB = {
    ready() {
      return Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
    },

    // useAuth を true にすると、anon キーではなく「ログインしている本人」として呼びます。
    // 関数の中の auth.uid() が誰かを判別できるのは、このヘッダがあるからです。
    async rpc(fn, args, useAuth) {
      if (!this.ready()) {
        throw new Error(
          '接続情報が設定されていません。.env を用意して npm run setup を実行してください。'
        );
      }

      let bearer = cfg.SUPABASE_ANON_KEY;
      if (useAuth && window.Auth) {
        const t = await window.Auth.token();
        if (!t) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
        bearer = t;
      }

      let res;
      try {
        res = await fetch(cfg.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
          method: 'POST',
          headers: {
            apikey: cfg.SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + bearer,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(args || {}),
        });
      } catch (e) {
        throw new Error('データベースに繋がりませんでした。通信環境を確認してください。');
      }

      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { /* JSONでない */ }

      if (!res.ok) {
        const msg = (body && (body.message || body.hint || body.details)) || text || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return body;
    },
  };
})();
