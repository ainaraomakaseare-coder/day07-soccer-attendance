// Supabase のログイン。ライブラリは使わず、素の fetch と画面遷移だけで書いています。
//
// 流れ：
//   1. 招待リンク  https://例/#<招待トークン>  を開く
//   2. 「Googleでログイン」→ Supabase の /auth/v1/authorize へ飛ぶ
//   3. Google の画面 → Supabase → こちらへ戻ってくる。
//      戻り先の URL の # に access_token などがぶら下がってくる
//   4. それを端末に保存する。以後は Authorization ヘッダに載せて使う
//
// 一度入れば入れ直しは要りません。access_token は1時間ほどで切れますが、
// refresh_token で自動的に取り直します。Supabase のセッションは既定で無期限です。
//
// 招待トークンは「?」の側に載せます。「#」は access_token に使われてしまうためです。

(function () {
  const cfg = window.APP_CONFIG || {};
  const KEY = 'day07.session';
  const INVITE_KEY = 'day07.invite';

  let session = null;
  try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { session = null; }

  function save(s) {
    session = s;
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch (e) { /* プライベートブラウズなどで保存できない端末がある */ }
  }

  const base = () => String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');

  function landingUrl(invite) {
    const u = location.origin + location.pathname;
    const event = new URLSearchParams(location.search).get('event');
    return invite ? u + '?invite=' + encodeURIComponent(invite) : u + (event && /^[a-f0-9-]{36}$/i.test(event) ? '?event='+encodeURIComponent(event) : '');
  }

  window.Auth = {
    ready() { return Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY); },
    loggedIn() { return Boolean(session && session.refresh_token); },

    signIn(invite) {
      location.href = base() + '/auth/v1/authorize?provider=google&redirect_to=' +
                      encodeURIComponent(landingUrl(invite));
    },

    async signOut() {
      const t = session && session.access_token;
      save(null);
      if (!t) return;
      try {
        await fetch(base() + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + t },
        });
      } catch (e) { /* 失敗しても端末側からは消えている */ }
    },

    // 戻ってきた直後の URL を読み取って、後片付けまでする。
    // 返り値 { invite, error }
    absorbRedirect() {
      const invite = new URLSearchParams(location.search).get('invite') || null;
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const err = h.get('error_description') || h.get('error') || null;
      const access = h.get('access_token');

      if (access) {
        save({
          access_token: access,
          refresh_token: h.get('refresh_token'),
          expires_at: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000,
        });
      }
      if (access || err || invite) {
        history.replaceState(null, '', landingUrl(null));
      }
      return { invite: invite, error: err };
    },

    // 使える access_token を返す。切れていれば取り直す。取り直せなければ null。
    async token() {
      if (!session || !session.refresh_token) return null;
      if (session.access_token && Date.now() < session.expires_at - 60000) {
        return session.access_token;
      }
      let res;
      try {
        res = await fetch(base() + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
      } catch (e) {
        throw new Error('通信できませんでした。電波の届く場所で開き直してください。');
      }
      if (!res.ok) { save(null); return null; }
      const b = await res.json();
      save({
        access_token: b.access_token,
        refresh_token: b.refresh_token || session.refresh_token,
        expires_at: Date.now() + (Number(b.expires_in) || 3600) * 1000,
      });
      return session.access_token;
    },

    // ログインの往復をまたいで招待トークンを覚えておく（保険）
    stashInvite(t) { try { sessionStorage.setItem(INVITE_KEY, t); } catch (e) { /* 無くても動く */ } },
    takeInvite() {
      try {
        const v = sessionStorage.getItem(INVITE_KEY);
        sessionStorage.removeItem(INVITE_KEY);
        return v;
      } catch (e) { return null; }
    },
  };
})();
