/* ============================================================
 * 공용 데이터 계층 (Supabase)
 *  - 로그인 후 내가 볼 수 있는 데이터를 모두 불러와 메모리에 보관(cache)
 *  - 화면 코드는 Store.all / get / where 로 동기식으로 읽고,
 *    저장·삭제는 await Store.insert / update / remove 로 처리
 *  - 다른 기기에서 데이터가 바뀌면 실시간(Realtime)으로 다시 불러옴
 * ============================================================ */
(function (global) {
  'use strict';

  const cfg = global.APP_CONFIG || {};
  const configured = !!cfg.SUPABASE_URL && !cfg.SUPABASE_URL.startsWith('YOUR_')
    && !!cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith('YOUR_');
  // 관리자 웹과 학생 앱의 로그인 정보를 따로 저장 (같은 PC에서 동시에 써도 섞이지 않게)
  const appName = /admin/i.test(global.location.pathname) ? 'admin' : 'student';
  const sb = configured && global.supabase
    ? global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { storageKey: `lms-auth-${appName}` } })
    : null;

  const TABLES = ['students', 'assignments', 'submissions', 'materials', 'notices', 'tests', 'scores', 'report_logs'];
  const listeners = [];
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // DB(snake_case) <-> 화면(camelCase) 변환
  const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const mapKeys = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k), v]));
  const fromDB = (row) => mapKeys(row, toCamel);
  const toDB = (obj) => mapKeys(obj, toSnake);

  const empty = () => ({ students: [], assignments: [], submissions: [], materials: [], notices: [], tests: [], scores: [], report_logs: [], stats: {} });
  let data = empty();
  let settings = { academyName: '안강엽 수학' };
  let user = null;
  let isAdmin = false;
  let channel = null;

  function check(res) { if (res.error) throw res.error; return res.data; }

  const Store = {
    configured,
    client: sb,
    uid,
    nowISO: () => new Date().toISOString(),
    toLocalDate: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    studentEmail: (loginId) => `${String(loginId).trim().toLowerCase()}@${cfg.STUDENT_EMAIL_DOMAIN}`,

    /* ---------- 로그인 ---------- */
    async init() {
      const { data: s } = await sb.auth.getSession();
      user = s.session?.user || null;
      await this.load();
      sb.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') { user = null; isAdmin = false; data = empty(); }
        else if (session) user = session.user;
      });
    },
    async signIn(email, password) {
      const res = await sb.auth.signInWithPassword({ email: email.trim(), password });
      check(res);
      user = res.data.user;
      await this.load();
    },
    async signOut() {
      if (channel) { sb.removeChannel(channel); channel = null; }
      await sb.auth.signOut();
      user = null; isAdmin = false; data = empty();
    },
    user: () => user,
    isAdmin: () => isAdmin,
    meStudent() { return user ? data.students.find((s) => s.id === user.id) || null : null; },

    /* ---------- 불러오기 ---------- */
    async load() {
      const st = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
      if (st.data) settings = fromDB(st.data);
      if (!user) { data = empty(); return; }

      const adm = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
      isAdmin = !!adm.data;

      const results = await Promise.all([
        ...TABLES.map((t) => sb.from(t).select('*')),
        sb.rpc('test_stats'),
      ]);
      const next = empty();
      TABLES.forEach((t, i) => { next[t] = check(results[i]).map(fromDB); });
      for (const r of check(results[TABLES.length]) || []) {
        next.stats[r.test_id] = { count: r.count, avg: r.avg === null ? null : Number(r.avg), max: r.max === null ? null : Number(r.max), min: r.min === null ? null : Number(r.min) };
      }
      data = next;
      this.subscribe();
    },

    // 다른 기기의 변경사항 실시간 반영
    subscribe() {
      if (channel || !user) return;
      let timer = null;
      channel = sb.channel('lms-changes')
        .on('postgres_changes', { event: '*', schema: 'public' }, () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            try { await Store.load(); listeners.forEach((fn) => fn()); } catch (e) { console.error(e); }
          }, 400);
        })
        .subscribe();
    },
    onChange(fn) { listeners.push(fn); },

    /* ---------- 읽기 (동기) ---------- */
    all(col) { return data[col] || []; },
    get(col, id) { return this.all(col).find((x) => x.id === id) || null; },
    where(col, fn) { return this.all(col).filter(fn); },
    settings: () => settings,
    classes() { return [...new Set(data.students.map((s) => s.className))].sort(); },
    targets(item, className) { return item.className === '전체' || item.className === className; },
    studentsFor(className) {
      return (className === '전체' ? data.students.slice() : data.students.filter((s) => s.className === className))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    submissionOf(assignmentId, studentId) {
      return data.submissions.find((s) => s.assignmentId === assignmentId && s.studentId === studentId) || null;
    },
    scoreOf(testId, studentId) {
      return data.scores.find((s) => s.testId === testId && s.studentId === studentId) || null;
    },
    testStats(testId) { return data.stats[testId] || { count: 0, avg: null, max: null, min: null }; },

    /* ---------- 쓰기 (비동기) ---------- */
    async insert(col, obj) {
      const row = check(await sb.from(col).insert(toDB(obj)).select().single());
      await this.load();
      return fromDB(row);
    },
    async update(col, id, patch) {
      check(await sb.from(col).update(toDB({ ...patch, updatedAt: this.nowISO() })).eq('id', id));
      await this.load();
    },
    async remove(col, id) {
      check(await sb.from(col).delete().eq('id', id));
      await this.load();
    },
    async saveScores(testId, rows) {
      const upserts = rows.filter((r) => r.score !== null || r.feedback)
        .map((r) => ({ test_id: testId, student_id: r.studentId, score: r.score, feedback: r.feedback, updated_at: this.nowISO() }));
      const clears = rows.filter((r) => r.score === null && !r.feedback).map((r) => r.studentId);
      if (upserts.length) check(await sb.from('scores').upsert(upserts, { onConflict: 'test_id,student_id' }));
      if (clears.length) check(await sb.from('scores').delete().eq('test_id', testId).in('student_id', clears));
      await this.load();
    },

    /* ---------- 학생 계정 (관리자) ---------- */
    async createStudent({ loginId, password, name, school, className, parentPhone = '' }) {
      // 관리자 로그인 상태를 유지하기 위해 임시 클라이언트로 가입 처리
      const temp = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lms-signup-temp' },
      });
      const res = await temp.auth.signUp({ email: this.studentEmail(loginId), password });
      check(res);
      const newId = res.data.user?.id;
      if (!newId || (res.data.user.identities && res.data.user.identities.length === 0)) throw new Error('User already registered');
      check(await sb.from('students').insert({ id: newId, login_id: loginId.trim().toLowerCase(), name, school, class_name: className, parent_phone: parentPhone }));
      await this.load();
    },
    async setStudentPassword(id, password) {
      check(await sb.rpc('admin_set_student_password', { p_student: id, p_password: password }));
    },
    async deleteStudent(id) {
      const paths = data.submissions.filter((s) => s.studentId === id).flatMap((s) => (s.files || []).map((f) => f.fileId));
      await FileDB.remove(paths);
      check(await sb.rpc('admin_delete_student', { p_student: id }));
      await this.load();
    },
  };

  /* ---------- 파일 저장소 (Supabase Storage) ---------- */
  const BUCKET = 'files';
  const urlCache = new Map();
  const FileDB = {
    // folder 예: 'materials', 'homework/<학생id>'
    async put(file, folder) {
      const ext = (file.name.match(/\.([a-zA-Z0-9]{1,8})$/) || [])[1];
      const path = `${folder}/${uid()}${ext ? '.' + ext.toLowerCase() : ''}`;
      check(await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' }));
      return path;
    },
    async remove(paths) {
      const list = [].concat(paths || []).filter(Boolean);
      if (!list.length) return;
      list.forEach((p) => [...urlCache.keys()].forEach((k) => k.startsWith(p + '|') && urlCache.delete(k)));
      const res = await sb.storage.from(BUCKET).remove(list);
      if (res.error) console.warn('파일 삭제 실패', res.error);
    },
    async blob(path) {
      const res = await sb.storage.from(BUCKET).download(path);
      if (res.error) throw res.error;
      return res.data;
    },
    async url(path, downloadName) {
      if (!path) return null;
      const key = path + '|' + (downloadName || '');
      const hit = urlCache.get(key);
      if (hit && hit.exp > Date.now()) return hit.url;
      const res = await sb.storage.from(BUCKET).createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
      if (res.error) { console.warn(res.error); return null; }
      urlCache.set(key, { url: res.data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
      return res.data.signedUrl;
    },
  };

  global.Store = Store;
  global.FileDB = FileDB;
})(window);

/* ============================================================
 * 공용 UI 도우미
 * ============================================================ */
(function (global) {
  'use strict';
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const parseDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v));
  const todayStr = () => Store.toLocalDate(new Date());

  const ERRORS = [
    [/Invalid login credentials/i, '아이디(이메일) 또는 비밀번호가 맞지 않아요.'],
    [/User already registered|already been registered|duplicate key.*login_id/i, '이미 사용 중인 아이디예요.'],
    [/Password should be at least/i, '비밀번호는 6자 이상이어야 해요.'],
    [/Email address .* is invalid|invalid.*email/i, '사용할 수 없는 아이디예요. 영문/숫자로 입력해주세요.'],
    [/Signups not allowed/i, 'Supabase에서 회원가입(Allow new users to sign up)이 꺼져 있어요.'],
    [/Email not confirmed/i, 'Supabase에서 이메일 확인(Confirm email)을 꺼주세요.'],
    [/Failed to fetch|NetworkError/i, '인터넷 연결을 확인해주세요.'],
    [/row-level security|permission denied/i, '권한이 없어요.'],
    [/Payload too large|exceeded the maximum/i, '파일이 너무 커요. (최대 50MB)'],
  ];

  const UI = {
    esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    nl2br(s) { return UI.esc(s).replace(/\n/g, '<br>'); },
    fmtDate(v) {
      if (!v) return '';
      const d = parseDate(v);
      return `${d.getMonth() + 1}.${d.getDate()} (${WEEK[d.getDay()]})`;
    },
    fmtDateTime(v) {
      if (!v) return '';
      const d = new Date(v);
      return `${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    fmtSize(b) {
      if (!b && b !== 0) return '';
      if (b < 1024) return b + 'B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB';
      return (b / 1024 / 1024).toFixed(1) + 'MB';
    },
    todayStr,
    isOverdue(dueDate) { return dueDate < todayStr(); },
    isLate(dueDate, submittedAt) { return Store.toLocalDate(new Date(submittedAt)) > dueDate; },
    dday(dueDate) {
      const diff = Math.round((parseDate(dueDate) - parseDate(todayStr())) / 86400000);
      if (diff === 0) return 'D-day';
      return diff > 0 ? `D-${diff}` : '마감';
    },
    isNew(iso, days = 3) { return Date.now() - new Date(iso).getTime() < days * 86400000; },
    fileIcon(type = '', name = '') {
      if ((type || '').startsWith('image/')) return '🖼️';
      if ((type || '').includes('pdf') || /\.pdf$/i.test(name)) return '📕';
      if (/\.(hwp|hwpx)$/i.test(name)) return '📘';
      if (/\.(docx?|txt)$/i.test(name)) return '📄';
      if (/\.(pptx?)$/i.test(name)) return '📙';
      if (/\.(xlsx?|csv)$/i.test(name)) return '📗';
      return '📎';
    },
    // 전화번호: 저장은 숫자만, 표시는 010-1234-5678
    phoneDigits(v) { return String(v || '').replace(/\D/g, ''); },
    fmtPhone(v) {
      const d = UI.phoneDigits(v);
      if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
      if (d.length === 10) return d.startsWith('02') ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
      return d;
    },
    // 휴대폰 문자 앱 열기 링크 (아이폰은 &body=, 그 외 ?body=)
    smsHref(phone, body) {
      const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      return `sms:${UI.phoneDigits(phone)}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
    },
    async copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        return ok;
      }
    },
    errMsg(e) {
      const msg = (e && (e.message || e.error_description || String(e))) || '알 수 없는 오류';
      const hit = ERRORS.find(([re]) => re.test(msg));
      return hit ? hit[1] : msg;
    },
    toast(msg, kind = 'ok') {
      let box = document.getElementById('toast-box');
      if (!box) { box = document.createElement('div'); box.id = 'toast-box'; document.body.appendChild(box); }
      const el = document.createElement('div');
      el.className = 'toast toast-' + kind;
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(() => el.classList.add('hide'), kind === 'error' ? 3500 : 2200);
      setTimeout(() => el.remove(), kind === 'error' ? 3900 : 2600);
    },
    // 버튼을 잠그고 비동기 작업 실행, 실패 시 에러 토스트
    async busy(btn, fn, label = '처리 중...') {
      const text = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = label; }
      try { return await fn(); }
      catch (e) { console.error(e); UI.toast(UI.errMsg(e), 'error'); return undefined; }
      finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = text; } }
    },
    async download(path, name) {
      if (!path || path === 'null') return UI.toast('첨부 파일이 없어요.', 'error');
      const url = await FileDB.url(path, name);
      if (!url) return UI.toast('파일을 열 수 없어요.', 'error');
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    },
    async hydrateImages(root = document) {
      await Promise.all([...root.querySelectorAll('img[data-file-id]')].map(async (img) => {
        const u = await FileDB.url(img.dataset.fileId);
        if (u) img.src = u; else img.closest('.thumb')?.classList.add('missing');
      }));
    },
    fileList(files) {
      if (!files || !files.length) return '<p class="muted small">첨부 파일 없음</p>';
      const isImg = (f) => (f.type || '').startsWith('image/');
      const imgs = files.filter(isImg);
      const others = files.filter((f) => !isImg(f));
      return `
        ${imgs.length ? `<div class="thumbs">${imgs.map((f) => `
          <button type="button" class="thumb" data-view="${UI.esc(f.fileId)}" data-name="${UI.esc(f.name)}" title="크게 보기">
            <img data-file-id="${UI.esc(f.fileId)}" alt="${UI.esc(f.name)}">
          </button>`).join('')}</div>` : ''}
        ${others.map((f) => `
          <button type="button" class="file-chip" data-download="${UI.esc(f.fileId)}" data-name="${UI.esc(f.name)}">
            <span>${UI.fileIcon(f.type, f.name)}</span><span class="ellipsis">${UI.esc(f.name)}</span><span class="muted small">${UI.fmtSize(f.size)}</span>
          </button>`).join('')}`;
    },
    bindDownloads(root = document) {
      root.addEventListener('click', (e) => {
        const view = e.target.closest('[data-view]');
        if (view) {
          // 같은 묶음(.thumbs)의 사진들을 뷰어로 넘겨보기
          const group = [...(view.closest('.thumbs') || view.parentNode).querySelectorAll('[data-view]')];
          UI.openViewer(group.map((b) => ({ fileId: b.dataset.view, name: b.dataset.name })), group.indexOf(view));
          return;
        }
        const btn = e.target.closest('[data-download]');
        if (btn) UI.download(btn.dataset.download, btn.dataset.name);
      });
    },

    /* ---------- 사진 크게 보기 (뷰어) ---------- */
    openViewer(items, start = 0) {
      if (!items.length) return;
      let idx = Math.max(0, start);
      const el = document.createElement('div');
      el.className = 'viewer';
      el.innerHTML = `
        <div class="viewer-top">
          <span class="viewer-name ellipsis"></span>
          <span class="viewer-count"></span>
          <button type="button" class="viewer-btn" data-act="zoom" title="원본 크기 / 화면 맞춤">🔍 확대</button>
          <button type="button" class="viewer-btn" data-act="download">⬇ 다운로드</button>
          <button type="button" class="viewer-btn" data-act="close" title="닫기 (Esc)">✕</button>
        </div>
        <div class="viewer-stage"><img alt=""></div>
        ${items.length > 1 ? '<button type="button" class="viewer-nav prev" data-act="prev">‹</button><button type="button" class="viewer-nav next" data-act="next">›</button>' : ''}`;
      document.body.appendChild(el);
      document.body.style.overflow = 'hidden';
      const img = el.querySelector('img');
      const stage = el.querySelector('.viewer-stage');

      async function show(i) {
        idx = (i + items.length) % items.length;
        const it = items[idx];
        stage.classList.remove('zoomed');
        el.querySelector('.viewer-name').textContent = it.name;
        el.querySelector('.viewer-count').textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
        img.removeAttribute('src');
        const u = await FileDB.url(it.fileId);
        if (items[idx] === it && u) img.src = u;
      }
      function close() {
        el.remove();
        document.body.style.overflow = '';
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') show(idx - 1);
        else if (e.key === 'ArrowRight') show(idx + 1);
      }
      el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') close();
        else if (act === 'prev') show(idx - 1);
        else if (act === 'next') show(idx + 1);
        else if (act === 'download') UI.download(items[idx].fileId, items[idx].name);
        else if (act === 'zoom' || e.target === img) stage.classList.toggle('zoomed');
        else if (e.target === stage || e.target === el) close(); // 바깥 클릭 시 닫기
      });
      // 휴대폰: 좌우로 밀어서 넘기기
      let x0 = null;
      stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (x0 === null || stage.classList.contains('zoomed')) return;
        const dx = e.changedTouches[0].clientX - x0; x0 = null;
        if (Math.abs(dx) > 50) show(idx + (dx < 0 ? 1 : -1));
      });
      document.addEventListener('keydown', onKey);
      show(idx);
    },

    /* ---------- 여러 파일을 ZIP 하나로 다운로드 ---------- */
    loadScript(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('압축 프로그램을 불러오지 못했어요. 인터넷 연결을 확인해주세요.'));
        document.head.appendChild(s);
      });
    },
    safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '파일'; },
    // entries: [{ fileId, path: 'ZIP 안 경로/파일명.jpg' }]
    async downloadZip(zipName, entries, onProgress) {
      if (!entries.length) throw new Error('다운로드할 파일이 없어요.');
      await UI.loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      const zip = new global.JSZip();
      let done = 0;
      const failed = [];
      for (const en of entries) {
        try { zip.file(en.path, await FileDB.blob(en.fileId)); }
        catch (e) { console.warn(e); failed.push(en.path); }
        done += 1;
        if (onProgress) onProgress(done, entries.length);
      }
      if (failed.length === entries.length) throw new Error('파일을 내려받지 못했어요.');
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = UI.safeName(zipName) + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (failed.length) UI.toast(`${failed.length}개 파일은 받지 못했어요.`, 'error');
    },
    // 제출물 파일 → ZIP 항목 (학생이름_01.jpg 형식)
    zipEntries(studentName, files, folder = '') {
      return (files || []).map((f, i) => {
        const ext = (f.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
        const base = `${UI.safeName(studentName)}_${String(i + 1).padStart(2, '0')}${ext}`;
        return { fileId: f.fileId, path: folder ? `${UI.safeName(folder)}/${base}` : base };
      });
    },
    async saveFiles(fileList, folder) {
      const out = [];
      for (const f of fileList) out.push({ fileId: await FileDB.put(f, folder), name: f.name, size: f.size, type: f.type });
      return out;
    },
    /* ---------- 질문노트 답변 표시 (마크다운 + 수식) ---------- */
    // 마크다운을 HTML로, $...$ / $$...$$ 수식은 KaTeX로 (marked, DOMPurify, katex 스크립트 필요)
    renderMd(src) {
      const text0 = String(src || '');
      if (!global.marked || !global.DOMPurify || !global.katex) return `<p>${UI.nl2br(text0)}</p>`;
      const maths = [];
      const keep = (tex, display) => { maths.push({ tex, display }); return `@@M${maths.length - 1}@@`; };
      const text = text0
        .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keep(a ?? b, true))
        .replace(/\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g, (_, a, b) => keep(a ?? b, false));
      const html = global.DOMPurify.sanitize(global.marked.parse(text, { breaks: true, gfm: true }));
      return html.replace(/@@M(\d+)@@/g, (_, i) => {
        const m = maths[+i];
        try { return global.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
        catch (e) { return UI.esc(m.tex); }
      });
    },
    stripVerdict: (s) => String(s || '').replace(/^\s*판정:[^\n]*\n?/, ''),
    // 한 줄 미리보기용: 수식 코드를 읽기 쉬운 글자로 (\dfrac{n}{\pi^2} → n/π²)
    plainTex(s) {
      const TEX = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', infty: '∞', cdot: '·', times: '×', pm: '±', to: '→', sqrt: '√', lim: ' lim', sin: ' sin', cos: ' cos', tan: ' tan', ln: ' ln', log: ' log' };
      return String(s || '')
        .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
        .replace(/\\([a-zA-Z]+)/g, (_, w) => TEX[w] ?? '')
        .replace(/\^\{?2\}?/g, '²').replace(/\^\{?3\}?/g, '³')
        .replace(/[{}$#>*`\\]/g, '').replace(/\s+/g, ' ').trim();
    },
    answerPreview(answer) {
      return UI.stripVerdict(answer).split('\n').map(UI.plainTex)
        .filter((l) => l && !/^(문제 읽기|한 줄 진단|핵심 원리)$/.test(l))[0] || '';
    },

    // Supabase 설정이 안 됐을 때 안내 화면
    setupNotice() {
      return `
        <div class="card stack" style="max-width:520px;margin:40px auto">
          <div style="font-size:32px">🔌</div>
          <h2 style="font-size:20px;font-weight:800">Supabase 연결이 필요해요</h2>
          <p class="muted">${Store.configured ? 'Supabase 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해주세요.'
            : '<code>js/config.js</code> 파일에 Supabase 주소(URL)와 anon 키를 입력해주세요. 자세한 방법은 README.md를 참고하세요.'}</p>
        </div>`;
    },
  };

  global.UI = UI;
})(window);
