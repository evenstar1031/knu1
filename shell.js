/* 본과 1학년 앱 — 껍데기
   1) GitHub 로 로그인 (Supabase Auth)  2) 회원인지 확인 (members 표)
   3) 비공개 저장소에서 앱 본체(app/app.html)와 기출 현황을 받아 화면에 올림
   4) 본체가 쓰는 window.claude.use("db"|"user") 를 Supabase 로 이어 줌 (Claude 아티팩트와 같은 코드가 그대로 돈다) */
(function(){
  const CFG = window.APP_CONFIG;
  const msgEl = document.getElementById('bootmsg');
  const h = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const show = html => { if (msgEl) msgEl.innerHTML = html; };
  const busy = t => show(`<div class="spin" aria-hidden="true"></div><p>${h(t)}</p>`);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!window.supabase || !CFG || /YOUR-/.test(CFG.supabaseUrl)) {
    show(`<p class="err">앱 설정이 아직 안 됐습니다.</p><p><code>config.js</code> 에 Supabase 주소와 키를 넣어 주세요.</p>`);
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
  });
  const TOKEN_KEY = 'knu1.gh_token';
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    del: k => { try { localStorage.removeItem(k); } catch (e) {} },
  };
  sb.auth.onAuthStateChange((ev, session) => {
    if (session && session.provider_token) store.set(TOKEN_KEY, session.provider_token);
  });

  /* ── GitHub API ── */
  let GH_TOKEN = null;
  async function gh(path, opts = {}) {
    const res = await fetch('https://api.github.com/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': opts.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) {
      const e = new Error('GitHub ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200));
      e.status = res.status; throw e;
    }
    if (opts.as === 'blob') return res.blob();
    if (opts.as === 'text') return res.text();
    return res.status === 204 ? null : res.json();
  }
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const rawApi = (path, as = 'text', signal) =>
    gh(`repos/${CFG.repo}/contents/${enc(path)}?ref=main`, { accept: 'application/vnd.github.raw+json', as, signal });
  async function rawPublic(path, as = 'text', signal) {       // 손님: 공개 저장소에서 바로
    const res = await fetch(`https://raw.githubusercontent.com/${CFG.repo}/main/${enc(path)}`, { signal });
    if (!res.ok) { const e = new Error('GitHub ' + res.status); e.status = res.status; throw e; }
    return as === 'blob' ? res.blob() : res.text();
  }
  let raw = rawApi;

  /* ── 저장 공간: 아티팩트의 db 를 흉내 낸 Supabase 연결 ── */
  let LOGIN = '', ROLE = '';
  const PRIVATE = new Set(['memos']);           // 사람마다 따로 (시간표 날짜별 메모)
  function makeDB(guest) {
    const scope = c => PRIVATE.has(c) ? LOGIN : '';
    const subs = {};
    const mapErr = e => {
      const x = new Error(e.message || String(e));
      x.code = (e.code === '42501' || /row-level security|permission/i.test(e.message || '')) ? 'invalid_argument' : (e.code || 'unknown');
      return x;
    };
    async function load(c) {
      const { data, error } = await sb.from('docs').select('id,data').eq('collection', c).eq('scope', scope(c));
      if (error) throw mapErr(error);
      return data || [];
    }
    async function emit(c) {
      const list = subs[c]; if (!list || !list.length) return;
      try {
        const rows = await load(c);
        const snap = { size: rows.length, docs: rows.map(r => ({ id: r.id, data: () => JSON.parse(JSON.stringify(r.data)) })) };
        list.forEach(s => { try { s.cb(snap); } catch (e) { console.error(e); } });
      } catch (e) { list.forEach(s => s.err && s.err(e)); }
    }
    async function upsert(c, id, data) {
      const { error } = await sb.from('docs').upsert({ collection: c, scope: scope(c), id, data, updated_by: LOGIN, updated_at: new Date().toISOString() });
      if (error) throw mapErr(error);
      emit(c);
    }
    async function del(c, id) {
      const { error } = await sb.from('docs').delete().eq('collection', c).eq('scope', scope(c)).eq('id', id);
      if (error) throw mapErr(error);
      emit(c);
    }
    function collection(c) {
      if (guest && PRIVATE.has(c)) {             // 손님: 메모는 이 기기에만
        const no = () => Promise.reject(Object.assign(new Error('guest'), { code: 'not_granted' }));
        return { onSnapshot(cb, err) { setTimeout(() => err && err(new Error('guest')), 0); return () => {}; },
                 doc() { return { set: no, update: no, delete: no, get: no }; }, add: no };
      }
      return {
        onSnapshot(cb, err) {
          const s = { cb, err }; (subs[c] = subs[c] || []).push(s);
          load(c).then(rows => cb({ size: rows.length, docs: rows.map(r => ({ id: r.id, data: () => JSON.parse(JSON.stringify(r.data)) })) }))
                 .catch(e => err && err(e));
          return () => { subs[c] = (subs[c] || []).filter(x => x !== s); };
        },
        doc(id) {
          return {
            set: v => upsert(c, id, v),
            update: async v => {
              const { data } = await sb.from('docs').select('data').eq('collection', c).eq('scope', scope(c)).eq('id', id).maybeSingle();
              return upsert(c, id, Object.assign({}, data && data.data, v));
            },
            delete: () => del(c, id),
            get: async () => {
              const { data, error } = await sb.from('docs').select('data').eq('collection', c).eq('scope', scope(c)).eq('id', id).maybeSingle();
              if (error) throw mapErr(error);
              return { id, exists: !!data, data: () => data && data.data };
            },
          };
        },
        add: async v => {
          const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 20);
          await upsert(c, id, v); return { id };
        },
      };
    }
    const refreshAll = () => { if (!document.hidden) Object.keys(subs).forEach(emit); };
    setInterval(refreshAll, 60000);
    document.addEventListener('visibilitychange', refreshAll);
    return { collection, doc: p => { const i = p.indexOf('/'); return collection(p.slice(0, i)).doc(p.slice(i + 1)); } };
  }

  /* ── 화면 ── */
  async function login() {
    busy('GitHub 로 이동하는 중…');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'github',
      options: { scopes: 'repo read:user', redirectTo: location.origin + location.pathname },
    });
    if (error) show(`<p class="err">로그인을 시작하지 못했습니다: ${h(error.message)}</p>`);
  }
  async function signOut() {
    await sb.auth.signOut().catch(() => {});
    store.del(TOKEN_KEY);
    location.replace(location.pathname);
  }
  function loginScreen(note) {
    show(`${note ? `<p>${note}</p>` : `<p>시간표 · 강의계획서 · 수업 후기 · 기출 · 학습자료</p>`}
      <button class="btn" id="b-login" type="button"><svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub로 로그인</button>
      <button class="btn ghost" id="b-guest" type="button">로그인 없이 둘러보기</button>
      <p style="margin-top:16px;font-size:13px">둘러보기는 보기와 PDF 내려받기만 됩니다. 후기 쓰기·필기본 올리기·학습자료 만들기는 초대받은 회원이 GitHub로 로그인해야 합니다(저장소 권한을 요청합니다).</p>`);
    document.getElementById('b-login').onclick = () => { store.del('knu1.guest'); login(); };
    document.getElementById('b-guest').onclick = () => { store.set('knu1.guest', '1'); enter({ guest: true }); };
  }

  function inject(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.getElementById('boot').remove();
    document.title = '본과 1학년';
    for (const n of [...doc.head.childNodes]) {
      if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') document.head.appendChild(document.importNode(n, true));
    }
    for (const n of [...doc.body.childNodes]) {
      if (n.nodeName === 'SCRIPT') {
        const s = document.createElement('script'); s.textContent = n.textContent;
        document.body.appendChild(s);                      // 차례대로 바로 실행됨
      } else if (n.nodeName === 'TITLE' || (n.nodeName === 'META' && /^claude:/.test(n.getAttribute('name') || ''))) {
        /* 건너뜀 */
      } else {
        document.body.appendChild(document.importNode(n, true));
      }
    }
  }

  async function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { status: 0 })), ms))]);
  }

  async function main() {
    const q = new URLSearchParams(location.search);
    if (q.get('error_description')) { loginScreen(`<span class="err">${h(q.get('error_description'))}</span>`); history.replaceState(null, '', location.pathname + location.hash); return; }
    const { data: { session } } = await sb.auth.getSession();
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    if (!session) { if (store.get('knu1.guest')) return enter({ guest: true }); loginScreen(); return; }
    if (session.provider_token) store.set(TOKEN_KEY, session.provider_token);
    GH_TOKEN = store.get(TOKEN_KEY);
    if (!GH_TOKEN) { loginScreen('GitHub 연결을 다시 해 주세요.'); return; }

    busy('계정 확인 중…');
    const who = await sb.rpc('my_login');
    LOGIN = (who.data || '').toLowerCase();
    const { data: me, error: meErr } = await sb.from('members').select('login,role').eq('login', LOGIN).maybeSingle();
    if (meErr || !me) {
      show(`<p><b>${h(LOGIN || '이 계정')}</b> 은(는) 아직 회원이 아닙니다.</p><p>관리자에게 GitHub 아이디를 알려 주세요. 그동안은 둘러보기로 볼 수 있습니다.</p>
        <button class="btn" id="b-guest" type="button">둘러보기로 계속</button>
        <button class="btn ghost" id="b-out" type="button">다른 계정으로 로그인</button>`);
      document.getElementById('b-guest').onclick = async () => { await sb.auth.signOut().catch(() => {}); store.del(TOKEN_KEY); store.set('knu1.guest', '1'); enter({ guest: true }); };
      document.getElementById('b-out').onclick = signOut; return;
    }
    ROLE = me.role;
    store.del('knu1.guest');
    return enter({ guest: false });
  }

  async function enter({ guest }) {
    if (guest) { raw = rawPublic; LOGIN = ''; ROLE = 'guest'; }
    busy('불러오는 중…');
    let html = null, idx = null;
    try {
      [html, idx] = await withTimeout(Promise.all([raw('app/app.html'), raw('app/gichul_index.json').then(JSON.parse).catch(() => null)]), 12000);
      store.set('knu1.app', html); if (idx) store.set('knu1.idx', JSON.stringify(idx));
    } catch (e) {
      html = store.get('knu1.app'); try { idx = JSON.parse(store.get('knu1.idx') || 'null'); } catch (x) {}
      if (!html) {
        const why = guest ? (e.status === 404 ? '앱 파일을 찾지 못했습니다. 잠시 뒤 다시 열어 주세요.' : '인터넷 연결을 확인해 주세요.')
                  : e.status === 404 ? '저장소 초대를 아직 수락하지 않았거나, 앱 파일이 저장소에 없습니다. GitHub 메일함에서 초대를 수락해 주세요.'
                  : (e.status === 401 || e.status === 403) ? 'GitHub 권한이 만료됐습니다. 다시 로그인해 주세요.'
                  : '인터넷 연결을 확인해 주세요.';
        show(`<p class="err">${h(why)}</p><button class="btn" id="b-re" type="button">다시 시도</button><button class="btn ghost" id="b-out" type="button">${guest ? '로그인 화면으로' : '로그아웃'}</button>`);
        document.getElementById('b-re').onclick = () => location.reload();
        document.getElementById('b-out').onclick = () => { store.del('knu1.guest'); signOut(); }; return;
      }
    }

    const DB = makeDB(guest);
    const USER = { canEdit: async () => ROLE === 'owner' || ROLE === 'editor', id: async () => LOGIN || 'guest' };
    window.GICHUL_LIVE = idx || undefined;
    window.APP = {
      sb, gh, raw, repo: CFG.repo, login: LOGIN, role: ROLE,
      isOwner: !guest && LOGIN === String(CFG.owner).toLowerCase(), signOut, guest,
      signIn: () => { store.del('knu1.guest'); login(); },
    };
    window.claude = { use: async name => name === 'db' ? DB : name === 'user' ? USER : null };
    inject(html);
  }
  main().catch(e => { console.error(e); show(`<p class="err">문제가 생겼습니다: ${h(e.message)}</p><button class="btn" type="button" onclick="location.reload()">다시 시도</button>`); });
})();
