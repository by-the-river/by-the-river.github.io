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
  async function prepare(file) {
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) throw new Error('사진 파일만 올릴 수 있어요.');
    const img = await loadImage(file);
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
        for (const f of [...files].slice(0, room)) state.work.push(await prepare(f));
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
    const text = src
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keep(a ?? b, true))
      .replace(/\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g, (_, a, b) => keep(a ?? b, false));
    const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
    return html.replace(/@@M(\d+)@@/g, (_, i) => {
      const m = maths[+i];
      try { return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
      catch (e) { return esc(m.tex); }
    });
  }
  const stripVerdict = (s) => s.replace(/^\s*판정:[^\n]*\n?/, '');
  function parseVerdict(s) {
    const m = s.match(/^\s*판정:\s*(정답|오답|확인 어려움)/);
    return m ? { '정답': 'correct', '오답': 'wrong', '확인 어려움': 'unclear' }[m[1]] : null;
  }

  function paintAnswer(text, live) {
    const el = $('answer');
    el.innerHTML = renderMd(stripVerdict(text)) + (live ? '<span class="caret"></span>' : '');
    el.querySelectorAll('h2, h3').forEach((h) => { if (h.textContent.trim() === '답') h.classList.add('final'); });
  }

  function showStamp(verdict) {
    const st = $('stamp');
    const map = { correct: ['정답', 'CORRECT'], wrong: ['오답', 'CHECK'], unclear: ['확인<br>필요', 'RETAKE'] };
    if (!verdict || !map[verdict]) { st.hidden = true; return; }
    st.className = 'stamp ' + verdict;
    st.innerHTML = `<div>${map[verdict][0]}<small>${map[verdict][1]}</small></div>`;
    st.hidden = false;
    $('answer').classList.toggle('correct', verdict === 'correct');
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
        action: 'ask', mode, note,
        problem: { type: state.problem.type, data: state.problem.data },
        work: mode === 'check' ? state.work.map((w) => ({ type: w.type, data: w.data })) : [],
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
            if (!text) { setStep(3); prog.hidden = true; }
            text += ev.text;
            if (mode === 'check' && parseVerdict(text)) showStamp(parseVerdict(text));
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
      paintAnswer(text, false);
      if (failed) answerEl.insertAdjacentHTML('beforeend', `<p class="err">${esc(failed)}</p>`);
      else if (finished && finished.truncated) answerEl.insertAdjacentHTML('beforeend', '<p class="err">풀이가 길어서 중간에 끊겼어요.</p>');
      const verdict = mode === 'check' ? (finished?.verdict || parseVerdict(text) || 'unclear') : null;
      if (mode === 'check') showStamp(verdict);
      if (!failed) saveHistory({ id: finished?.id || at, mode, at, note, verdict, answer: text, images });
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
        : '<span class="h-tag">풀이</span>';
      const firstLine = stripVerdict(h.answer || '').replace(/[#>*$\\]/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(문제 읽기|한 줄 진단)$/.test(l))[0] || '';
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
    paintAnswer(h.answer, false);
    if (h.mode === 'check') showStamp(h.verdict);
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
