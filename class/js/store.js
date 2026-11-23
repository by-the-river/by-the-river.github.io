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

  const TABLES = ['students', 'assignments', 'submissions', 'materials', 'notices', 'tests', 'scores', 'report_logs', 'parents', 'parent_students'];
  const PARENT_DOMAIN = cfg.PARENT_EMAIL_DOMAIN || 'parent.ankangyeop.com';
  const listeners = [];
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // DB(snake_case) <-> 화면(camelCase) 변환
  const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const mapKeys = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k), v]));
  const fromDB = (row) => mapKeys(row, toCamel);
  const toDB = (obj) => mapKeys(obj, toSnake);

  const empty = () => ({ students: [], assignments: [], submissions: [], materials: [], notices: [], tests: [], scores: [], report_logs: [], parents: [], parent_students: [], stats: {} });
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
    parentEmail: (loginId) => `${String(loginId).trim().toLowerCase()}@${PARENT_DOMAIN}`,

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
    meParent() { return user ? data.parents.find((p) => p.id === user.id) || null : null; },
    // 학부모 ↔ 자녀
    childrenOf(parentId) {
      const ids = data.parent_students.filter((l) => l.parentId === parentId).map((l) => l.studentId);
      return data.students.filter((s) => ids.includes(s.id)).sort((a, b) => a.name.localeCompare(b.name));
    },
    parentsOf(studentId) {
      const ids = data.parent_students.filter((l) => l.studentId === studentId).map((l) => l.parentId);
      return data.parents.filter((p) => ids.includes(p.id));
    },

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
      // 학부모 테이블은 parent-schema.sql 실행 전에는 없으므로 오류가 나도 빈 목록으로
      const OPTIONAL = ['parents', 'parent_students'];
      TABLES.forEach((t, i) => {
        if (results[i].error && OPTIONAL.includes(t)) { console.warn(t, results[i].error.message); next[t] = []; return; }
        next[t] = check(results[i]).map(fromDB);
      });
      // 학생의 반 목록 (multi-class-schema.sql 실행 전이면 class_name 하나로)
      next.students.forEach((s) => {
        s.classNames = Array.isArray(s.classNames) && s.classNames.length ? s.classNames : (s.className ? [s.className] : []);
      });
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
    // 반 목록은 학생들의 반에서 만들어짐 → 학생이 한 명도 없는 반은 자동으로 사라짐
    classes() { return [...new Set(data.students.flatMap((s) => s.classNames))].sort((a, b) => a.localeCompare(b)); },
    // classNames: 반 이름 하나 또는 여러 개(배열)
    targets(item, classNames) { return item.className === '전체' || [].concat(classNames || []).includes(item.className); },
    classLabel(s) { return (s?.classNames || []).join(', '); },
    studentsFor(className) {
      return (className === '전체' ? data.students.slice() : data.students.filter((s) => s.classNames.includes(className)))
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
    async createStudent({ loginId, password, name, school, classNames, parentPhone = '' }) {
      // 관리자 로그인 상태를 유지하기 위해 임시 클라이언트로 가입 처리
      const temp = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lms-signup-temp' },
      });
      const res = await temp.auth.signUp({ email: this.studentEmail(loginId), password });
      check(res);
      const newId = res.data.user?.id;
      if (!newId || (res.data.user.identities && res.data.user.identities.length === 0)) throw new Error('User already registered');
      check(await sb.from('students').insert({ id: newId, login_id: loginId.trim().toLowerCase(), name, school, class_name: classNames[0], class_names: classNames, parent_phone: parentPhone }));
      await this.load();
    },
    /* ---------- 학부모 계정 (관리자) ---------- */
    async createParent({ loginId, password, name = '', studentId }) {
      const temp = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lms-signup-temp' },
      });
      const res = await temp.auth.signUp({ email: this.parentEmail(loginId), password });
      check(res);
      const newId = res.data.user?.id;
      if (!newId || (res.data.user.identities && res.data.user.identities.length === 0)) throw new Error('User already registered');
      check(await sb.from('parents').insert({ id: newId, login_id: loginId.trim().toLowerCase(), name }));
      if (studentId) check(await sb.from('parent_students').insert({ parent_id: newId, student_id: studentId }));
      await this.load();
    },
    // 이미 있는 학부모 계정에 자녀 추가 (형제·자매)
    async linkParent(loginId, studentId) {
      const p = data.parents.find((x) => x.loginId === String(loginId).trim().toLowerCase());
      if (!p) throw new Error('그 아이디의 학부모 계정이 없어요.');
      if (data.parent_students.some((l) => l.parentId === p.id && l.studentId === studentId)) throw new Error('이미 연결된 학부모 계정이에요.');
      check(await sb.from('parent_students').insert({ parent_id: p.id, student_id: studentId }));
      await this.load();
    },
    async unlinkParent(parentId, studentId) {
      check(await sb.from('parent_students').delete().eq('parent_id', parentId).eq('student_id', studentId));
      await this.load();
    },
    async setParentPassword(id, password) {
      check(await sb.rpc('admin_set_parent_password', { p_parent: id, p_password: password }));
    },
    async deleteParent(id) {
      check(await sb.rpc('admin_delete_parent', { p_parent: id }));
      await this.load();
    },
    // 학부모가 리포트를 열면 '읽음' 표시 (선생님 화면에 보임)
    async markReportRead(id) {
      const r = data.report_logs.find((x) => x.id === id);
      if (!r || r.readAt) return;
      r.readAt = this.nowISO();
      const res = await sb.rpc('parent_mark_report_read', { p_id: id });
      if (res.error) console.warn(res.error);
    },

    // 반 이름 바꾸기: 학생들의 반 + 그 반 대상 숙제·자료·공지·테스트까지 함께 변경
    // (새 이름이 이미 있는 반이면 두 반이 하나로 합쳐짐)
    async renameClass(oldName, newName) {
      const now = this.nowISO();
      for (const s of data.students.filter((x) => x.classNames.includes(oldName))) {
        const names = [...new Set(s.classNames.map((c) => (c === oldName ? newName : c)))];
        check(await sb.from('students').update({ class_names: names, class_name: names[0], updated_at: now }).eq('id', s.id));
      }
      for (const t of ['assignments', 'materials', 'notices', 'tests']) {
        check(await sb.from(t).update({ class_name: newName, updated_at: now }).eq('class_name', oldName));
      }
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
    [/class_names|my_classes/i, '여러 반 기능용 DB 설정(supabase/multi-class-schema.sql)을 먼저 실행해주세요.'],
    [/relation .*parent|parent_students|admin_set_parent_password|admin_delete_parent|report_logs_channel_check|Could not find the table/i, '학부모 기능용 DB 설정(supabase/parent-schema.sql)을 먼저 실행해주세요.'],
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
      const graphs = global.AskGraph ? global.AskGraph.extract(text0) : { text: text0, list: [] };
      const text = graphs.text
        .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keep(a ?? b, true))
        .replace(/\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g, (_, a, b) => keep(a ?? b, false));
      let html = global.DOMPurify.sanitize(global.marked.parse(text, { breaks: true, gfm: true }));
      if (global.AskGraph) html = global.AskGraph.inject(html, graphs.list);
      return html.replace(/@@M(\d+)@@/g, (_, i) => {
        const m = maths[+i];
        try { return global.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
        catch (e) { return UI.esc(m.tex); }
      });
    },
    // 첫 줄 '판정: ...' 과 끝의 ```marks 블록(사진 위 첨삭 표시 정보)을 뺀 본문
    stripVerdict: (s) => String(s || '').replace(/^\s*판정:[^\n]*\n?/, '').replace(/\n*```marks\s*\n[\s\S]*?(?:```|$)\s*/g, '\n').trimEnd(),

    /* ---------- 첨삭 사진 위 빨간 펜 표시 ---------- */
    // 답변 끝의 ```marks {"marks":[{img, box:[x1,y1,x2,y2](0~1000), type, note}]} ``` 읽기
    askMarks(answer) {
      const m = String(answer || '').match(/```marks\s*\n([\s\S]*?)```/);
      if (!m) return [];
      let list;
      try { list = JSON.parse(m[1]).marks; } catch (e) { return []; }
      if (!Array.isArray(list)) return [];
      const c = (v) => Math.max(0, Math.min(1000, Number(v) || 0));
      return list.filter((x) => x && Array.isArray(x.box) && x.box.length === 4 && x.box.every((v) => Number.isFinite(Number(v))))
        .map((x) => {
          let [x1, y1, x2, y2] = x.box.map(c);
          if (x2 < x1) [x1, x2] = [x2, x1];
          if (y2 < y1) [y1, y2] = [y2, y1];
          return {
            img: Math.max(1, Math.round(Number(x.img) || 1)), box: [x1, y1, x2, y2],
            type: ['strike', 'circle', 'underline'].includes(x.type) ? x.type : 'circle',
            note: String(x.note || '').replace(/[$\\`]/g, '').slice(0, 40),
          };
        }).slice(0, 6);
    },
    // 사진 한 장 + 표시. imgAttrs: '<img ...>' 에 넣을 속성 (src=... 또는 data-file-id=...)
    markFigure(imgAttrs, marks) {
      const svg = marks.map(({ box: [x1, y1, x2, y2], type }) => {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        if (type === 'strike') return `<path d="M${x1 - 6} ${cy + 5} Q${cx} ${cy - 7} ${x2 + 6} ${cy - 3}"/>`;
        if (type === 'underline') {
          const y = Math.min(995, y2 + 6), n = Math.max(2, Math.round((x2 - x1) / 40)), w = (x2 - x1) / n;
          let d = `M${x1} ${y}`;
          for (let i = 0; i < n; i++) d += ` q${w / 2} ${i % 2 ? 5 : -5} ${w} 0`;
          return `<path d="${d}"/>`;
        }
        // 손으로 그린 듯 살짝 덜 닫힌 타원
        const rx = (x2 - x1) / 2 + 14, ry = (y2 - y1) / 2 + 14;
        const pt = (deg) => `${(cx + rx * Math.cos(deg * Math.PI / 180)).toFixed(1)} ${(cy + ry * Math.sin(deg * Math.PI / 180)).toFixed(1)}`;
        // 위쪽에서 시작해 시계 방향으로 한 바퀴 돌고, 끝은 조금 바깥으로 벌어지며 시작점을 지나침
        return `<path d="M${pt(-110)} A${rx} ${ry} 0 0 1 ${pt(50)} A${rx * 1.07} ${ry * 1.12} 0 1 1 ${pt(-75)}"/>`;
      }).join('');
      const notes = marks.filter((m) => m.note).map(({ box: [x1, y1, x2, y2], type, note }) => {
        const gap = type === 'circle' ? 36 : 18; // 동그라미는 바깥으로 더 커서 메모를 조금 더 띄움
        const pos = [];
        if (x2 <= 620) pos.push(`left:${(x2 + gap) / 10}%`, `top:${y1 / 10}%`, `max-width:${(1000 - x2 - 30) / 10}%`);
        else {
          if (x1 <= 500) pos.push(`left:${x1 / 10}%`, `max-width:${(1000 - x1 - 10) / 10}%`);
          else pos.push(`right:${(1000 - x2) / 10}%`, `max-width:${(x2 - 10) / 10}%`);
          pos.push(y2 <= 880 ? `top:${(y2 + 14) / 10}%` : `bottom:${(1000 - y1 + 14) / 10}%`);
        }
        return `<span class="mark-note" style="${pos.join(';')}">${UI.esc(note)}</span>`;
      }).join('');
      return `<figure class="mark-wrap"><img ${imgAttrs} alt="풀이 사진"><svg class="mark-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${svg}</svg>${notes}</figure>`;
    },
    // 한 줄 미리보기용: 수식 코드를 읽기 쉬운 글자로 (\dfrac{n}{\pi^2} → n/π²)
    plainTex(s) {
      const TEX = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', infty: '∞', cdot: '·', times: '×', pm: '±', to: '→', sqrt: '√', lim: ' lim', sin: ' sin', cos: ' cos', tan: ' tan', ln: ' ln', log: ' log' };
      return (global.AskGraph ? global.AskGraph.strip(s) : String(s || ''))
        .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
        .replace(/\\([a-zA-Z]+)/g, (_, w) => TEX[w] ?? '')
        .replace(/\^\{?2\}?/g, '²').replace(/\^\{?3\}?/g, '³')
        .replace(/[{}$#>*`\\]/g, '').replace(/\s+/g, ' ').trim();
    },
    answerPreview(answer) {
      return UI.stripVerdict(answer).split('\n').map(UI.plainTex)
        .filter((l) => l && !/^(문제 읽기|한 줄 진단|핵심 원리)$/.test(l))[0] || '';
    },

    /* ---------- 점수 추이 차트 (SVG) — 학생 앱·관리자 웹 공용 ---------- */
    // rows: [{ t: 테스트, s: 점수, st: 반 통계 }]
    scoreChart(rows) {
      const W = 440, H = 190, L = 30, R = 14, T = 16, B = 30;
      const pct = (v, max) => (v / max) * 100;
      const x = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1));
      const y = (p) => T + (1 - p / 100) * (H - T - B);
      const mine = rows.map((r, i) => [x(i), y(pct(r.s.score, r.t.maxScore))]);
      const avg = rows.map((r, i) => (r.st.avg === null ? null : [x(i), y(pct(r.st.avg, r.t.maxScore))])).filter(Boolean);
      const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const grid = [0, 50, 100].map((g) => `
        <line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="#e4e7ee"/>
        <text x="${L - 6}" y="${y(g) + 4}" font-size="11" fill="#6b7385" text-anchor="end">${g}</text>`).join('');
      return `
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 추이 그래프">
          ${grid}
          <path d="${path(avg)}" fill="none" stroke="#b8bdc9" stroke-width="2" stroke-dasharray="4 4"/>
          <path d="${path(mine)}" fill="none" stroke="#4353e8" stroke-width="2.5" stroke-linejoin="round"/>
          ${mine.map((p, i) => `
            <circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#fff" stroke="#4353e8" stroke-width="2.5"/>
            <text x="${p[0]}" y="${p[1] - 10}" font-size="12" font-weight="700" fill="#4353e8" text-anchor="middle">${rows[i].s.score}</text>
            <text x="${p[0]}" y="${H - 8}" font-size="11" fill="#6b7385" text-anchor="middle">${UI.fmtDate(rows[i].t.date).split(' ')[0]}</text>`).join('')}
        </svg>`;
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
