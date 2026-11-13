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
  // 기록 목록용 한 줄 미리보기: 수식 코드를 읽기 쉬운 글자로
  const TEX = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', infty: '∞', cdot: '·', times: '×', pm: '±', to: '→', sqrt: '√', lim: ' lim', sin: ' sin', cos: ' cos', tan: ' tan', ln: ' ln', log: ' log' };
  const plainTex = (s) => String(s || '')
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\([a-zA-Z]+)/g, (_, w) => TEX[w] ?? '')
    .replace(/\^\{?2\}?/g, '²').replace(/\^\{?3\}?/g, '³')
    .replace(/[{}$#>*`\\]/g, '').replace(/\s+/g, ' ').trim();
  function parseVerdict(s) {
    const m = s.match(/^\s*판정:\s*(정답|오답|확인 어려움)/);
    return m ? { '정답': 'correct', '오답': 'wrong', '확인 어려움': 'unclear' }[m[1]] : null;
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
        action: 'ask', mode, note, style: mode === 'solve' ? 'steps' : undefined,
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
      if (mode === 'check') showStamp(verdict);
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
