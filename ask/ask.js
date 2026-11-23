/* 질문노트: 문제 사진 → Supabase 서버 함수(ask) → Claude 풀이를 실시간으로 표시 */
(function () {
  'use strict';

  // 학습앱과 같은 Supabase 프로젝트 (anon 키는 공개되어도 되는 키)
  const SUPABASE_URL = 'https://ludhxbtyslscfgkcnmwa.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1ZGh4YnR5c2xzY2Zna2NubXdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyOTY3MDQsImV4cCI6MjEwOTg3MjcwNH0.jX7aE5dFmqOBKwpbmgZyhxMJESYvQPN3tKRm1rgn4l8';
  const STUDENT_EMAIL_DOMAIN = 'student.ankangyeop.com';
  const FN_URL = SUPABASE_URL + '/functions/v1/ask';
  const MAX_WORK = 3;
  const HISTORY_MAX = 20;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const sb = window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'ask-auth' } })
    : null;

  /* ---------- 브라우저 저장소 (막혀 있어도 동작하도록) ---------- */
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  let deviceId = store.get('ask-device', null);
  if (!deviceId) {
    deviceId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    store.set('ask-device', deviceId);
  }

  /* ---------- 상태 ---------- */
  const state = { mode: 'solve', problem: null, work: [], status: null, busy: false };

  /* ---------- 사진 줄이기 (긴 변 1600px JPEG) ---------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없어요. 다른 사진으로 다시 시도해 주세요.')); };
      img.src = url;
    });
  }
  function toJpeg(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  async function prepare(file, kind) {
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) throw new Error('사진 파일만 올릴 수 있어요.');
    const img = await loadImage(file);
    if (kind === 'work') {
      // 풀이 사진은 AI가 줄이지 않는 크기(긴 변 1568px, 약 115만 화소 이하)로 보내고 크기를 함께 알려 줌 → 빨간 펜 위치가 정확해짐
      const W = img.naturalWidth, H = img.naturalHeight;
      const s = Math.min(1, 1568 / Math.max(W, H), Math.sqrt(1150000 / (W * H)));
      const full = toJpeg(img, Math.round(Math.max(W, H) * s), 0.88);
      return { type: 'image/jpeg', data: full.split(',')[1], preview: full, thumb: toJpeg(img, 320, 0.6), w: Math.round(W * s), h: Math.round(H * s) };
    }
    const full = toJpeg(img, 1600, 0.86);
    return { type: 'image/jpeg', data: full.split(',')[1], preview: full, thumb: toJpeg(img, 320, 0.6) };
  }

  /* ---------- 모드 / 업로드 화면 ---------- */
  function setMode(mode) {
    state.mode = mode;
    const check = mode === 'check';
    document.querySelectorAll('.work-only').forEach((el) => { el.hidden = !check; });
    $('noteNum').textContent = check ? '4' : '3';
    updateSubmit();
    $('note').placeholder = check
      ? '예) 답이 3이 나왔는데 정답은 5래요. 어디서 틀렸는지 모르겠어요.'
      : '예) 21번이요. (나)조건을 어떻게 써야 할지 모르겠어요.';
  }

  const UNAVAILABLE = '현재 사용이 불가합니다.';
  const unavailable = () => !!state.status && state.status.available === false;
  function updateSubmit() {
    const btn = $('submitBtn');
    if (state.busy) return;
    btn.disabled = unavailable();
    btn.textContent = unavailable() ? UNAVAILABLE : state.mode === 'check' ? '첨삭 받기' : '풀이 받기';
  }

  function renderPreviews() {
    const p = $('problemPreview');
    p.innerHTML = state.problem
      ? `<div class="thumb"><img src="${state.problem.preview}" alt="문제 사진"><button type="button" class="x" data-remove="problem" aria-label="문제 사진 지우기">×</button></div>`
      : '';
    $('problemDrop').classList.toggle('has', !!state.problem);

    const w = $('workPreview');
    w.innerHTML = state.work.map((x, i) => `
      <div class="thumb"><img src="${x.preview}" alt="내 풀이 ${i + 1}"><span class="n">${i + 1}</span>
        <button type="button" class="x" data-remove="work" data-i="${i}" aria-label="풀이 사진 ${i + 1} 지우기">×</button></div>`).join('')
      + (state.work.length && state.work.length < MAX_WORK ? '<button type="button" class="add-more" id="addWork"><div><span>+</span>추가</div></button>' : '');
    $('workDrop').classList.toggle('has', state.work.length > 0);
  }

  async function addFiles(kind, files) {
    msg('');
    try {
      if (kind === 'problem') {
        if (!files[0]) return;
        state.problem = await prepare(files[0]);
      } else {
        const room = MAX_WORK - state.work.length;
        if (files.length > room) msg(`풀이 사진은 ${MAX_WORK}장까지 올릴 수 있어요.`);
        for (const f of [...files].slice(0, room)) state.work.push(await prepare(f, 'work'));
      }
    } catch (e) { msg(e.message); }
    renderPreviews();
  }

  function bindDrop(dropId, inputId, kind) {
    const drop = $(dropId), input = $(inputId);
    input.addEventListener('change', () => { addFiles(kind, [...input.files]); input.value = ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(kind, [...e.dataTransfer.files]); });
  }

  function msg(text) { $('formMsg').textContent = text || ''; }

  /* ---------- 로그인 / 남은 횟수 ---------- */
  async function authHeader() {
    if (sb) {
      const { data } = await sb.auth.getSession();
      if (data.session) return 'Bearer ' + data.session.access_token;
    }
    return 'Bearer ' + SUPABASE_ANON_KEY;
  }
  async function callFn(body) {
    return fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: await authHeader(), apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ deviceId, ...body }),
    });
  }
  async function refreshStatus() {
    try {
      const res = await callFn({ action: 'status' });
      if (!res.ok) throw new Error('status ' + res.status);
      state.status = await res.json();
    } catch (e) {
      console.warn(e);
      state.status = null;
    }
    renderAccount();
  }

  function renderAccount() {
    const s = state.status;
    $('account').innerHTML = s && s.member
      ? `<span class="member"><i class="dot"></i>${esc(s.name)}</span><button type="button" class="text-btn" id="logoutBtn">로그아웃</button>`
      : '<button type="button" class="chip-btn" id="loginOpen">학생 로그인</button>';

    const q = $('quota');
    q.classList.toggle('off', unavailable());
    updateSubmit();
    if (!s) { q.innerHTML = ''; return; }
    if (unavailable()) {
      q.innerHTML = `<span class="off-dot" aria-hidden="true"></span><span>${UNAVAILABLE}</span>`;
    } else if (s.member) {
      q.innerHTML = '<span class="inf">∞</span><span>학습앱 학생 · 횟수 제한 없이 질문할 수 있어요</span>';
    } else {
      const pips = Array.from({ length: s.limit }, (_, i) => `<i class="pip ${i < s.remaining ? 'full' : ''}"></i>`).join('');
      q.innerHTML = `<span class="pips" aria-hidden="true">${pips}</span><span>오늘 남은 무료 질문 <b>${s.remaining}</b>회</span>`
        + '<button type="button" data-login>학생이면 로그인</button>';
    }
  }

  function openLogin() {
    $('loginMsg').textContent = '';
    const d = $('loginDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    setTimeout(() => $('loginForm').loginId.focus(), 50);
  }
  function closeLogin() { const d = $('loginDialog'); if (d.close) d.close(); else d.removeAttribute('open'); }

  async function login(e) {
    e.preventDefault();
    const f = $('loginForm');
    const id = f.loginId.value.trim().toLowerCase();
    const email = id.includes('@') ? id : `${id}@${STUDENT_EMAIL_DOMAIN}`;
    const btn = $('loginBtn');
    btn.disabled = true; btn.textContent = '확인 중...';
    try {
      if (!sb) throw new Error('인터넷 연결을 확인해 주세요.');
      const { error } = await sb.auth.signInWithPassword({ email, password: f.pw.value });
      if (error) throw new Error(/Invalid login/i.test(error.message) ? '아이디 또는 비밀번호가 맞지 않아요.' : '로그인하지 못했어요. 잠시 뒤에 다시 시도해 주세요.');
      await refreshStatus();
      if (!state.status || !state.status.member) {
        await sb.auth.signOut();
        await refreshStatus();
        throw new Error('학습앱 학생 계정이 아니에요.');
      }
      f.reset();
      closeLogin();
      msg('');
    } catch (err) {
      $('loginMsg').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = '로그인';
    }
  }

  /* ---------- 풀이 글 그리기 (마크다운 + 수식) ---------- */
  function renderMd(src) {
    const maths = [];
    const keep = (tex, display) => { maths.push({ tex, display }); return `@@M${maths.length - 1}@@`; };
    const graphs = window.AskGraph ? AskGraph.extract(src) : { text: src, list: [] };
    const text = graphs.text
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keep(a ?? b, true))
      .replace(/\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g, (_, a, b) => keep(a ?? b, false));
    let html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
    if (window.AskGraph) html = AskGraph.inject(html, graphs.list);
    return html.replace(/@@M(\d+)@@/g, (_, i) => {
      const m = maths[+i];
      try { return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
      catch (e) { return esc(m.tex); }
    });
  }
  // 첫 줄 '판정: ...' 과 끝의 ```marks 블록(사진 위 첨삭 표시 정보)을 뺀 본문 (받는 중에 덜 온 블록도 숨김)
  const stripVerdict = (s) => String(s || '').replace(/^\s*판정:[^\n]*\n?/, '').replace(/\n*```marks\s*\n[\s\S]*?(?:```|$)\s*/g, '\n').trimEnd();
  // 기록 목록용 한 줄 미리보기: 수식 코드를 읽기 쉬운 글자로
  const TEX = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', infty: '∞', cdot: '·', times: '×', pm: '±', to: '→', sqrt: '√', lim: ' lim', sin: ' sin', cos: ' cos', tan: ' tan', ln: ' ln', log: ' log' };
  const plainTex = (s) => (window.AskGraph ? AskGraph.strip(s) : String(s || ''))
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\([a-zA-Z]+)/g, (_, w) => TEX[w] ?? '')
    .replace(/\^\{?2\}?/g, '²').replace(/\^\{?3\}?/g, '³')
    .replace(/[{}$#>*`\\]/g, '').replace(/\s+/g, ' ').trim();
  function parseVerdict(s) {
    const m = s.match(/^\s*판정:\s*(정답|오답|확인 어려움)/);
    return m ? { '정답': 'correct', '오답': 'wrong', '확인 어려움': 'unclear' }[m[1]] : null;
  }

  /* ---------- 첨삭 사진 위 빨간 펜 표시 (학습앱 js/store.js 의 UI.askMarks / UI.markFigure 와 같은 코드) ---------- */
  // 답변 끝의 ```marks {"marks":[{img, box:[x1,y1,x2,y2](0~1000), type, note}]} ``` 읽기
  function askMarks(answer) {
      const m = String(answer || '').match(/```marks\s*\n([\s\S]*?)```/);
      if (!m) return [];
      let obj;
      try { obj = JSON.parse(m[1]); } catch (e) { return []; }
      const list = obj && obj.marks;
      if (!Array.isArray(list)) return [];
      // sizes: 사진별 [가로, 세로] 픽셀 → 좌표를 0~1000 으로 바꿈 (sizes 가 없으면 예전 방식: 이미 0~1000)
      const sizes = Array.isArray(obj.sizes) ? obj.sizes : [];
      const c = (v) => Math.max(0, Math.min(1000, Number(v) || 0));
      return list.filter((x) => x && Array.isArray(x.box) && x.box.length === 4 && x.box.every((v) => Number.isFinite(Number(v))))
        .map((x) => {
          const img = Math.max(1, Math.round(Number(x.img) || 1));
          const sz = sizes[img - 1];
          const sw = Array.isArray(sz) && Number(sz[0]) > 0 ? Number(sz[0]) : 1000;
          const sh = Array.isArray(sz) && Number(sz[1]) > 0 ? Number(sz[1]) : 1000;
          let [x1, y1, x2, y2] = x.box.map((v, i) => c(Number(v) * 1000 / (i % 2 ? sh : sw)));
          if (x2 < x1) [x1, x2] = [x2, x1];
          if (y2 < y1) [y1, y2] = [y2, y1];
          return {
            img, box: [x1, y1, x2, y2],
            type: ['strike', 'circle', 'underline'].includes(x.type) ? x.type : 'circle',
            note: String(x.note || '').replace(/[$\\`]/g, '').slice(0, 40),
          };
        }).slice(0, 6);
  }
  // 사진 한 장 + 표시. imgAttrs: '<img ...>' 에 넣을 속성 (src=... 또는 data-file-id=...)
  function markFigure(imgAttrs, marks) {
      // 손으로 그린 느낌: 선을 조금씩 흔들고, 같은 질문은 늘 같은 모양이 나오도록 표시 위치로 난수 씨앗을 만듦
      const rng = (seed) => () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const f = (v) => v.toFixed(1);
      // 점들을 부드럽게 이은 곡선 (점 사이 중간점을 2차 곡선으로)
      const curve = (p) => {
        let d = `M${f(p[0][0])} ${f(p[0][1])}`;
        for (let i = 1; i < p.length - 1; i++) d += ` Q${f(p[i][0])} ${f(p[i][1])} ${f((p[i][0] + p[i + 1][0]) / 2)} ${f((p[i][1] + p[i + 1][1]) / 2)}`;
        const l = p[p.length - 1];
        return `${d} L${f(l[0])} ${f(l[1])}`;
      };
      // 펜 한 획 = 진한 선 + 살짝 어긋난 옅은 선 (잉크 번짐·펜 압력 느낌)
      const stroke = (pts, rand) => `<path class="ink" d="${curve(pts)}"/>`
        + `<path class="ghost" d="${curve(pts.map(([x, y]) => [x + 0.6 + (rand() - 0.5) * 1.6, y + 0.8 + (rand() - 0.5) * 1.6]))}"/>`;
      const svg = marks.map(({ box: [x1, y1, x2, y2], type }) => {
        const rand = rng(Math.round(x1 * 7 + y1 * 13 + x2 * 17 + y2 * 19));
        const j = (a) => (rand() - 0.5) * 2 * a;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, w = x2 - x1, h = y2 - y1;
        if (type === 'strike') {
          // 오른쪽 위로 살짝 올라가며 끝을 조금 넘겨 긋는 한 획
          const n = Math.max(6, Math.round(w / 30)), sx = x1 - 10 + j(4), ex = x2 + 12 + j(5);
          const sy = cy + h * 0.18 + j(3), ey = cy - h * 0.12 + j(3);
          return stroke(Array.from({ length: n + 1 }, (_, i) => {
            const t = i / n;
            return [sx + (ex - sx) * t + j(2), sy + (ey - sy) * t - Math.sin(t * Math.PI) * (3 + rand() * 3) + j(1.8)];
          }), rand);
        }
        if (type === 'underline') {
          // 물결 밑줄: 물결 높이와 간격이 조금씩 다르게
          const y = Math.min(994, y2 + 7), n = Math.max(10, Math.round(w / 10)), waves = Math.max(2, Math.round(w / 45));
          return stroke(Array.from({ length: n + 1 }, (_, i) => {
            const t = i / n;
            return [x1 - 6 + (w + 14) * t + j(1.5), y + t * j(6) + Math.sin(t * waves * Math.PI * 2) * (4 + rand() * 2.5)];
          }), rand);
        }
        // 동그라미: 한 바퀴 조금 넘게 돌며 반지름이 조금씩 커져 끝이 시작점과 겹침
        const rx = w / 2 + 16, ry = h / 2 + 16, start = -115 + j(15), tilt = j(0.08);
        const pts = [];
        for (let a = 0; a <= 385; a += 12) {
          const t = a / 385, r = 1 + 0.07 * t + j(0.025), rad = (start + a) * Math.PI / 180;
          const ex = Math.cos(rad) * rx * r, ey = Math.sin(rad) * ry * r;
          pts.push([cx + j(1) + ex - ey * tilt, cy + j(1) + ey + ex * tilt]);
        }
        return stroke(pts, rand);
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
        return `<span class="mark-note" style="${pos.join(';')}">${esc(note)}</span>`;
      }).join('');
      return `<figure class="mark-wrap"><img ${imgAttrs} alt="풀이 사진"><svg class="mark-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${svg}</svg>${notes}</figure>`;
  }

  // 방금 올린 풀이 사진 위에 표시 (기록에는 작은 사진만 남아서, 첨삭을 받은 그 화면에서만 보여 줌)
  function paintMarks(text, photos) {
    const box = $('marksBox');
    const marks = askMarks(text);
    const figs = [...new Set(marks.map((m) => m.img))].sort((a, b) => a - b)
      .map((n) => photos[n - 1] ? markFigure(`src="${photos[n - 1]}"`, marks.filter((m) => m.img === n)) : '').join('');
    if (!figs) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="marks-head"><b>내 풀이에 빨간 펜으로 표시했어요</b><button type="button" class="text-btn" data-marks-toggle>표시 끄기</button></div>
      ${figs}
      <p class="marks-tip">AI가 표시한 위치라 조금 어긋날 수 있어요. 자세한 설명은 아래를 보세요.</p>`;
    box.classList.remove('marks-off');
    box.querySelector('[data-marks-toggle]').onclick = (e) => {
      const off = box.classList.toggle('marks-off');
      e.currentTarget.textContent = off ? '표시 켜기' : '표시 끄기';
    };
    box.hidden = false;
  }

  function paintAnswer(text, live) {
    const el = $('answer');
    el.innerHTML = renderMd(stripVerdict(text)) + (live ? '<span class="caret"></span>' : '');
    el.querySelectorAll('h2, h3').forEach((h) => { if (h.textContent.trim() === '답') h.classList.add('final'); });
  }

  /* ---------- 단계별 풀이: 학생이 한 단계씩 눌러서 열기 ---------- */
  // ## 제목별로 나누고, '풀이'는 ### 단계별로 (없으면 번호 목록으로) 나눔
  function splitSteps(body) {
    const out = []; let cur = null;
    body.split('\n').forEach((line) => {
      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) { cur = { title: h3[1].replace(/^\d+\s*단계\s*[:：.)]?\s*/, '').trim(), lines: [] }; out.push(cur); }
      else { if (!cur) { cur = { title: '', lines: [] }; out.push(cur); } cur.lines.push(line); }
    });
    let steps = out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() })).filter((s) => s.title || s.body);
    if (steps.length <= 1) {
      const parts = body.split(/\n(?=\d+[.)]\s)/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) steps = parts.map((p) => ({ title: '', body: p.replace(/^\d+[.)]\s+/, '') }));
    }
    return steps.length ? steps : [{ title: '', body }];
  }
  function buildSteps(md) {
    const sections = []; let cur = null;
    stripVerdict(md).split('\n').forEach((line) => {
      const h2 = line.match(/^##\s+([^#].*)$/);
      if (h2) { cur = { title: h2[1].trim(), lines: [] }; sections.push(cur); }
      else { if (!cur) { cur = { title: '', lines: [] }; sections.push(cur); } cur.lines.push(line); }
    });
    const cards = [];
    for (const s of sections) {
      const body = s.lines.join('\n').trim();
      if (!body) continue;
      if (/^풀이/.test(s.title)) splitSteps(body).forEach((st, i) => cards.push({ kind: 'step', label: `${i + 1}단계`, title: st.title, body: st.body }));
      else if (/^답/.test(s.title)) cards.push({ kind: 'answer', label: '답', title: '', body });
      else if (/핵심/.test(s.title)) cards.push({ kind: 'hint', label: '핵심 원리', title: '', body });
      else cards.push({ kind: /문제 읽기/.test(s.title) ? 'read' : 'extra', label: s.title || '풀이', title: '', body });
    }
    return cards;
  }
  const openKey = (id) => 'ask-open-' + id;
  function paintSteps(text, id, scrollTo) {
    const el = $('answer');
    const cards = buildSteps(text);
    const opened = Math.max(1, Math.min(store.get(openKey(id), 1), cards.length));
    el.classList.add('stepped');
    el.innerHTML = `
      <div class="step-progress" aria-label="${opened}/${cards.length} 단계 열람"><i style="width:${Math.round(opened / cards.length * 100)}%"></i><span>${opened} / ${cards.length}</span></div>
      <p class="step-guide">한 단계씩 열어 보고, 다음 단계는 먼저 스스로 해 보세요.</p>
      <div class="steps">${cards.map((c, i) => {
        if (i < opened) return `
          <section class="step-card open k-${c.kind}" id="step-${i}">
            <div class="step-head"><span class="step-tag">${esc(c.label)}</span>${c.title ? `<b>${esc(c.title)}</b>` : ''}</div>
            <div class="step-body">${renderMd(c.body)}</div>
          </section>`;
        if (i === opened) return `
          <button type="button" class="step-card next k-${c.kind}" data-step-next>
            <span class="step-tag">${esc(c.label)}</span>
            <span class="step-next-text">${c.kind === 'answer' ? '끝까지 고민해 봤나요? 눌러서 답 확인하기'
              : c.kind === 'step' && c.title ? `${esc(c.title)}<em>눌러서 보기</em>` : '<em>눌러서 보기</em>'}</span>
          </button>`;
        return `<div class="step-card locked"><span class="step-tag">${esc(c.label)}</span></div>`;
      }).join('')}</div>
      <div class="step-actions">
        ${opened > 1 ? '<button type="button" class="text-btn" data-step-set="1">처음부터 다시 가리기</button>' : '<span></span>'}
        ${opened < cards.length ? `<button type="button" class="text-btn" data-step-set="${cards.length}">남은 풀이 모두 보기</button>` : ''}
      </div>`;
    const go = (n, target) => { store.set(openKey(id), n); paintSteps(text, id, target); renderHistory(); };
    const next = el.querySelector('[data-step-next]');
    if (next) next.onclick = () => go(opened + 1, opened);
    el.querySelectorAll('[data-step-set]').forEach((b) => b.onclick = () => go(+b.dataset.stepSet));
    if (scrollTo !== undefined) $('step-' + scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showStamp(verdict) {
    const st = $('stamp');
    const map = { correct: ['정답', 'CORRECT'], wrong: ['오답', 'CHECK'], unclear: ['확인<br>필요', 'RETAKE'] };
    if (!verdict || !map[verdict]) { st.hidden = true; return; }
    st.className = 'stamp ' + verdict;
    st.innerHTML = `<div>${map[verdict][0]}<small>${map[verdict][1]}</small></div>`;
    st.hidden = false;
    ['correct', 'wrong', 'unclear'].forEach((v) => $('answer').classList.toggle(v, v === verdict));
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function openResult({ mode, at, images }) {
    $('result').hidden = false;
    $('resultKind').textContent = mode === 'check' ? '내 풀이 첨삭' : '문제 풀이';
    $('resultTime').textContent = fmtTime(at);
    $('resultProblem').innerHTML = images.map((src, i) => `<img src="${src}" alt="${i ? '내 풀이 ' + i : '문제 사진'}">`).join('');
    $('stamp').hidden = true;
    $('marksBox').hidden = true;
    $('marksBox').innerHTML = '';
    $('answer').className = 'answer';
    $('answer').innerHTML = '';
    $('resultFoot').hidden = true;
  }

  /* ---------- 질문 보내기 ---------- */
  async function submit(e) {
    e.preventDefault();
    if (state.busy) return;
    msg('');
    if (!state.problem) return msg('문제 사진을 올려 주세요.');
    if (state.mode === 'check' && !state.work.length) return msg('내 풀이 사진을 올려 주세요.');
    const s = state.status;
    if (unavailable()) return msg(UNAVAILABLE);
    if (s && !s.member && s.remaining <= 0) { msg('오늘의 무료 질문을 모두 썼어요. 학습앱 학생이면 로그인해 주세요.'); return; }

    const mode = state.mode;
    const note = $('note').value.trim();
    const at = new Date().toISOString();
    const images = [state.problem.thumb, ...(mode === 'check' ? state.work.map((w) => w.thumb) : [])];
    const workFull = mode === 'check' ? state.work.map((w) => w.preview) : []; // 빨간 펜 표시를 그릴 원본 크기 풀이 사진
    state.busy = true;
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = '풀이를 만드는 중...';

    openResult({ mode, at, images });
    const prog = $('progress');
    prog.hidden = false;
    const steps = [...prog.children];
    const setStep = (n) => steps.forEach((li, i) => { li.className = i < n ? 'done' : i === n ? 'on' : ''; });
    setStep(0);
    const answerEl = $('answer');
    answerEl.innerHTML = '<p class="waiting">문제를 읽고 있어요 · <b id="sec">0</b>초 <br>보통 1분 안팎 걸려요. 이 화면을 닫지 말아 주세요.</p>';
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    let text = '';
    const t0 = Date.now();
    const tick = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      const el = $('sec'); if (el) el.textContent = sec;
      if (!text) setStep(sec < 12 ? 0 : sec < 35 ? 1 : 2);
    }, 1000);

    let finished = null;
    let failed = '';
    let paintTimer = null;
    const schedulePaint = () => {
      if (paintTimer) return;
      paintTimer = setTimeout(() => { paintTimer = null; paintAnswer(text, true); }, 120);
    };

    try {
      const res = await callFn({
        action: 'ask', mode, note, style: mode === 'solve' ? 'steps' : undefined, marks: mode === 'check',
        problem: { type: state.problem.type, data: state.problem.data },
        work: mode === 'check' ? state.work.map((w) => ({ type: w.type, data: w.data, w: w.w, h: w.h })) : [],
      });
      if (!res.ok || !res.body) {
        let body = {};
        try { body = await res.json(); } catch (_) { /* 응답이 JSON이 아님 */ }
        if (body.code === 'limit' && state.status) state.status.remaining = 0;
        if (body.code === 'unavailable' && state.status) state.status.available = false;
        throw new Error(body.error || (res.status === 413 ? '사진이 너무 커요.' : '서버에 연결하지 못했어요. 잠시 뒤에 다시 시도해 주세요.'));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'delta') {
            if (mode === 'solve') {
              // 단계별 풀이는 다 받은 뒤 카드로 보여 줌 (그 전까지는 기다림 화면 유지)
              if (!text) { setStep(2); const w = answerEl.querySelector('.waiting'); if (w) w.firstChild.textContent = '거의 다 됐어요. 풀이를 단계별로 정리하고 있어요 · '; }
              text += ev.text;
              continue;
            }
            if (!text) { setStep(3); prog.hidden = true; }
            text += ev.text;
            if (parseVerdict(text)) showStamp(parseVerdict(text));
            schedulePaint();
          } else if (ev.type === 'done') finished = ev;
          else if (ev.type === 'error') {
            failed = ev.message;
            if (ev.code === 'unavailable' && state.status) state.status.available = false;
          }
        }
      }
      if (!finished && !failed) failed = '연결이 끊겼어요. 다시 시도해 주세요.';
    } catch (err) {
      failed = err.message || '풀이 중 문제가 생겼어요.';
    } finally {
      clearInterval(tick);
      clearTimeout(paintTimer);
      prog.hidden = true;
    }

    if (failed && !text) {
      answerEl.innerHTML = `<p class="err">${esc(failed)}</p>`;
    } else {
      const id = finished?.id || at;
      if (mode === 'solve') paintSteps(text, id);
      else paintAnswer(text, false);
      if (failed) answerEl.insertAdjacentHTML('beforeend', `<p class="err">${esc(failed)}</p>`);
      else if (finished && finished.truncated) answerEl.insertAdjacentHTML('beforeend', '<p class="err">풀이가 길어서 중간에 끊겼어요.</p>');
      const verdict = mode === 'check' ? (finished?.verdict || parseVerdict(text) || 'unclear') : null;
      if (mode === 'check') { showStamp(verdict); paintMarks(text, workFull); }
      if (!failed) saveHistory({ id, mode, at, note, verdict, answer: text, images });
    }
    $('resultFoot').hidden = false;
    state.busy = false;
    setMode(state.mode);
    refreshStatus();
  }

  function resetForm() {
    state.problem = null;
    state.work = [];
    $('note').value = '';
    renderPreviews();
    $('result').hidden = true;
    $('askForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 이 기기의 기록 ---------- */
  function saveHistory(item) {
    const list = store.get('ask-history', []);
    list.unshift(item);
    let trimmed = list.slice(0, HISTORY_MAX);
    // 저장 공간이 부족하면 오래된 것부터 지움
    while (trimmed.length && !store.set('ask-history', trimmed)) trimmed = trimmed.slice(0, -1);
    renderHistory();
  }
  function renderHistory() {
    const list = store.get('ask-history', []);
    $('historySec').hidden = !list.length;
    $('historyList').innerHTML = list.map((h, i) => {
      const tag = h.mode === 'check'
        ? `<span class="h-tag ${h.verdict || ''}">${h.verdict === 'correct' ? '정답' : h.verdict === 'wrong' ? '오답 첨삭' : '첨삭'}</span>`
        : (() => {
          const total = buildSteps(h.answer || '').length;
          const seen = Math.max(1, Math.min(store.get(openKey(h.id || h.at), 1), total));
          return `<span class="h-tag">풀이 ${seen}/${total}</span>`;
        })();
      const firstLine = stripVerdict(h.answer || '').split('\n').map(plainTex).filter((l) => l && !/^(문제 읽기|한 줄 진단)$/.test(l))[0] || '';
      return `<li><button type="button" data-history="${i}">
        <div class="h-img">${h.images && h.images[0] ? `<img src="${h.images[0]}" alt="">` : ''}${tag}</div>
        <div class="h-body"><b>${esc(h.note || firstLine || '질문')}</b><small>${fmtTime(h.at)}</small></div>
      </button></li>`;
    }).join('');
  }
  function showHistory(i) {
    const h = store.get('ask-history', [])[i];
    if (!h) return;
    openResult({ mode: h.mode, at: h.at, images: h.images || [] });
    $('progress').hidden = true;
    if (h.mode === 'check') { paintAnswer(h.answer, false); showStamp(h.verdict); }
    else paintSteps(h.answer, h.id || h.at);
    $('resultFoot').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 이벤트 연결 ---------- */
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
  bindDrop('problemDrop', 'problemInput', 'problem');
  bindDrop('workDrop', 'workInput', 'work');
  $('askForm').addEventListener('submit', submit);
  $('againBtn').addEventListener('click', resetForm);
  $('loginForm').addEventListener('submit', login);
  $('loginClose').addEventListener('click', closeLogin);
  $('clearHistory').addEventListener('click', () => {
    if (!window.confirm('이 기기의 질문 기록을 모두 지울까요?')) return;
    store.set('ask-history', []);
    renderHistory();
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const rm = t.closest('[data-remove]');
    if (rm) {
      if (rm.dataset.remove === 'problem') state.problem = null;
      else state.work.splice(+rm.dataset.i, 1);
      renderPreviews();
      return;
    }
    if (t.closest('#addWork')) { $('workInput').click(); return; }
    if (t.closest('#loginOpen, [data-login]')) { openLogin(); return; }
    if (t.closest('#logoutBtn')) { if (sb) await sb.auth.signOut(); refreshStatus(); return; }
    const hb = t.closest('[data-history]');
    if (hb) showHistory(+hb.dataset.history);
  });

  setMode('solve');
  renderPreviews();
  renderHistory();
  refreshStatus();
})();
