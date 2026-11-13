/* 학생 앱 */
(function () {
  'use strict';
  const $view = document.getElementById('view');
  const $title = document.getElementById('appTitle');
  const $back = document.getElementById('backBtn');
  const { esc, nl2br } = UI;
  let me = null;

  const TITLES = { home: '홈', homework: '숙제', materials: '자료실', notices: '공지사항', scores: '성적', ask: '질문하기' };

  /* ---------- 데이터 헬퍼 ---------- */
  const myAssignments = () => Store.where('assignments', (a) => Store.targets(a, me.className))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const myNotices = () => Store.where('notices', (n) => Store.targets(n, me.className))
    .sort((a, b) => (b.pinned - a.pinned) || b.createdAt.localeCompare(a.createdAt));
  const myMaterials = () => Store.where('materials', (m) => Store.targets(m, me.className))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const myTests = () => Store.where('tests', (t) => Store.targets(t, me.className))
    .sort((a, b) => a.date.localeCompare(b.date));
  const mySub = (aid) => Store.submissionOf(aid, me.id);
  const hasScore = (s) => s && s.score !== null && s.score !== undefined;

  function hwStatus(a) {
    const s = mySub(a.id);
    if (!s) return UI.isOverdue(a.dueDate)
      ? '<span class="badge badge-danger">미제출</span>'
      : `<span class="badge badge-warn">${UI.dday(a.dueDate)}</span>`;
    if (s.status === 'checked') return '<span class="badge badge-success">확인완료</span>';
    return '<span class="badge badge-primary">제출완료</span>';
  }

  /* ---------- 라우팅 ---------- */
  function render() {
    me = Store.meStudent();
    document.body.classList.toggle('logged-out', !me);
    if (!me) return renderLogin();

    const [route = 'home', param] = location.hash.slice(1).split('/');
    const view = routes[route] ? route : 'home';
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view));
    $title.textContent = TITLES[view];
    $back.classList.toggle('hidden', !param);
    document.getElementById('hwDot').classList.toggle('hidden',
      !myAssignments().some((a) => !mySub(a.id) && !UI.isOverdue(a.dueDate)));
    routes[view](param);
    UI.hydrateImages($view);
  }

  /* ---------- 로그인 ---------- */
  function renderLogin() {
    $view.innerHTML = `
      <div class="login">
        <div class="logo">📘</div>
        <h2>${esc(Store.settings().academyName)}</h2>
        <p class="muted">학생 학습 관리 앱</p>
        <form id="loginForm" class="card stack">
          <label class="field"><span>아이디</span>
            <input type="text" name="loginId" autocomplete="username" autocapitalize="off" required placeholder="선생님께 받은 아이디">
          </label>
          <label class="field"><span>비밀번호</span>
            <input type="password" name="pw" autocomplete="current-password" required>
          </label>
          <button class="btn btn-primary btn-block">로그인</button>
        </form>
        <p class="hint muted small">아이디·비밀번호를 모르면 선생님께 문의하세요.</p>
      </div>`;
    document.getElementById('loginForm').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      UI.busy(e.submitter, async () => {
        await Store.signIn(Store.studentEmail(f.loginId.value), f.pw.value);
        if (!Store.meStudent()) {
          await Store.signOut();
          throw new Error('학생 계정이 아니에요. 선생님은 관리자 웹을 이용해주세요.');
        }
        location.hash = '#home';
        render();
      }, '로그인 중...');
    };
  }

  /* ---------- 화면들 ---------- */
  const routes = {
    home() {
      const hw = myAssignments();
      const todo = hw.filter((a) => !mySub(a.id) && !UI.isOverdue(a.dueDate));
      const newFeedback = hw.filter((a) => mySub(a.id)?.status === 'checked').length;
      const notices = myNotices().slice(0, 3);
      const scored = myTests().map((t) => ({ t, s: Store.scoreOf(t.id, me.id) })).filter((x) => hasScore(x.s));
      const latest = scored[scored.length - 1];

      $view.innerHTML = `
        <section class="card hello">
          <h2>${esc(me.name)}님, 안녕하세요 👋</h2>
          <p>${esc(me.school)}${me.school ? ' · ' : ''}${esc(me.className)}</p>
          <div class="stats">
            <a href="#homework"><b>${todo.length}</b><span>남은 숙제</span></a>
            <a href="#homework"><b>${newFeedback}</b><span>받은 피드백</span></a>
            <a href="#scores"><b>${latest ? latest.s.score : '-'}</b><span>최근 점수</span></a>
          </div>
        </section>

        <section>
          <div class="section-label row between"><span>📝 해야 할 숙제</span><a href="#homework" class="small">전체보기</a></div>
          <div class="list">
            ${todo.length ? todo.slice(0, 3).map((a) => `
              <a class="list-item" href="#homework/${a.id}">
                <div class="grow"><div class="title ellipsis">${esc(a.title)}</div><div class="sub">마감 ${UI.fmtDate(a.dueDate)}</div></div>
                ${hwStatus(a)}
              </a>`).join('') : '<div class="empty">남은 숙제가 없어요 🎉</div>'}
          </div>
        </section>

        <section>
          <div class="section-label row between"><span>📢 공지사항</span><a href="#notices" class="small">전체보기</a></div>
          <div class="list">
            ${notices.length ? notices.map(noticeItem).join('') : '<div class="empty">공지가 없어요</div>'}
          </div>
        </section>

        ${latest ? `
        <section>
          <div class="section-label row between"><span>📊 최근 테스트</span><a href="#scores" class="small">전체보기</a></div>
          <a class="card row" href="#scores/${latest.t.id}">
            <div class="grow"><div style="font-weight:700">${esc(latest.t.title)}</div><div class="muted small">${UI.fmtDate(latest.t.date)}</div></div>
            <div class="score-pill">${latest.s.score}<span class="muted small"> / ${latest.t.maxScore}</span></div>
          </a>
        </section>` : ''}`;
    },

    homework(id) {
      if (id) return homeworkDetail(id);
      const all = myAssignments();
      const todo = all.filter((a) => !mySub(a.id));
      const done = all.filter((a) => mySub(a.id)).reverse();
      const item = (a) => `
        <a class="list-item" href="#homework/${a.id}">
          <div class="icon-box">${mySub(a.id) ? '✅' : '📝'}</div>
          <div class="grow"><div class="title ellipsis">${esc(a.title)}</div><div class="sub">마감 ${UI.fmtDate(a.dueDate)}${a.className === '전체' ? ' · 전체' : ''}</div></div>
          ${hwStatus(a)}
        </a>`;
      $view.innerHTML = `
        <div class="section-label">해야 할 숙제 ${todo.length}</div>
        <div class="list">${todo.length ? todo.map(item).join('') : '<div class="empty">모든 숙제를 제출했어요 🎉</div>'}</div>
        <div class="section-label">제출한 숙제 ${done.length}</div>
        <div class="list">${done.length ? done.map(item).join('') : '<div class="empty">아직 제출한 숙제가 없어요</div>'}</div>`;
    },

    materials(param) {
      const cat = param ? decodeURIComponent(param) : '전체';
      $back.classList.add('hidden');
      const all = myMaterials();
      const cats = ['전체', ...new Set(all.map((m) => m.category))];
      const list = cat === '전체' ? all : all.filter((m) => m.category === cat);
      $view.innerHTML = `
        <div class="chips">${cats.map((c) => `<a class="chip ${c === cat ? 'active' : ''}" href="#materials/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div>
        <div class="list">
          ${list.length ? list.map((m) => `
            <button class="list-item" data-download="${esc(m.fileId)}" data-name="${esc(m.fileName)}">
              <div class="icon-box">${UI.fileIcon(m.fileType, m.fileName)}</div>
              <div class="grow">
                <div class="title ellipsis">${esc(m.title)} ${UI.isNew(m.createdAt) ? '<span class="badge badge-new">N</span>' : ''}</div>
                <div class="sub ellipsis">${esc(m.category)} · ${UI.fmtDate(m.createdAt)} · ${UI.fmtSize(m.fileSize)}</div>
                ${m.description ? `<div class="sub ellipsis">${esc(m.description)}</div>` : ''}
              </div>
              <span class="chev">⬇</span>
            </button>`).join('') : '<div class="empty">자료가 없어요</div>'}
        </div>`;
    },

    notices(id) {
      if (id) {
        const n = Store.get('notices', id);
        if (!n) { location.hash = '#notices'; return; }
        $view.innerHTML = `
          <article class="card stack">
            <div class="detail-head">
              <div class="row wrap">${n.pinned ? '<span class="badge badge-danger">📌 중요</span>' : ''}<span class="badge">${esc(n.className)}</span></div>
              <h2 style="margin-top:8px">${esc(n.title)}</h2>
              <p class="muted small">${UI.fmtDateTime(n.createdAt)}</p>
            </div>
            <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
            <div class="detail-body">${nl2br(n.body)}</div>
          </article>`;
        return;
      }
      const list = myNotices();
      $view.innerHTML = `<div class="list">${list.length ? list.map(noticeItem).join('') : '<div class="empty">공지가 없어요</div>'}</div>`;
    },

    scores(id) {
      if (id) return scoreDetail(id);
      const rows = myTests().map((t) => ({ t, s: Store.scoreOf(t.id, me.id), st: Store.testStats(t.id) }));
      const graded = rows.filter((r) => hasScore(r.s));
      $view.innerHTML = `
        ${graded.length >= 2 ? `
        <section class="card chart">
          <div class="card-title">점수 추이</div>
          ${chartSVG(graded)}
          <div class="legend"><span><i style="background:var(--primary)"></i>내 점수</span><span><i style="background:#b8bdc9"></i>반 평균</span></div>
        </section>` : ''}
        <div class="list">
          ${rows.length ? rows.slice().reverse().map(({ t, s, st }) => `
            <a class="list-item" href="#scores/${t.id}">
              <div class="grow">
                <div class="title ellipsis">${esc(t.title)}</div>
                <div class="sub">${UI.fmtDate(t.date)}${st.avg !== null ? ` · 반 평균 ${st.avg}` : ''}</div>
              </div>
              ${hasScore(s)
                ? `<div class="score-pill">${s.score}<span class="muted small"> / ${t.maxScore}</span></div>`
                : '<span class="badge">채점중</span>'}
              <span class="chev">›</span>
            </a>`).join('') : '<div class="empty">아직 테스트 기록이 없어요</div>'}
        </div>`;
    },

    /* ---------- 질문하기 (질문노트와 같은 서버, 풀이는 단계별로 열기) ---------- */
    ask(id) {
      if (id) return askDetail(id);
      if (ask.pending) return askWaiting();
      if (!ask.listLoaded && !ask.listLoading) loadAskList();
      const f = ask.form;
      const check = f.mode === 'check';
      const thumb = (x, i, kind) => `
        <div class="ask-thumb"><img src="${x.preview}" alt="">${kind === 'work' ? `<span class="n">${i + 1}</span>` : ''}
          <button type="button" class="x" data-ask-remove="${kind}" data-i="${i}" aria-label="지우기">×</button></div>`;
      $view.innerHTML = `
        <section class="card stack ask-form">
          <div class="ask-modes" role="radiogroup">
            <button type="button" class="${check ? '' : 'on'}" data-ask-mode="solve"><b>📷 풀이가 필요해요</b><small>단계별로 하나씩 열어 봐요</small></button>
            <button type="button" class="${check ? 'on' : ''}" data-ask-mode="check"><b>✏️ 내 풀이 봐 주세요</b><small>틀린 곳을 찾아 줘요</small></button>
          </div>
          <div>
            <div class="ask-label">문제 사진 <span class="muted small">한 문제만 크게</span></div>
            ${f.problem ? `<div class="ask-thumbs">${thumb(f.problem, 0, 'problem')}</div>` : `
            <label class="dropzone"><input type="file" accept="image/*" data-ask-pick="problem"><div class="big">📷</div><div style="font-weight:700">사진 찍기 / 선택</div></label>`}
          </div>
          ${check ? `
          <div>
            <div class="ask-label">내 풀이 사진 <span class="muted small">최대 3장</span></div>
            ${f.work.length ? `<div class="ask-thumbs">${f.work.map((w, i) => thumb(w, i, 'work')).join('')}
              ${f.work.length < 3 ? '<label class="ask-add"><input type="file" accept="image/*" multiple data-ask-pick="work">+<small>추가</small></label>' : ''}</div>` : `
            <label class="dropzone"><input type="file" accept="image/*" multiple data-ask-pick="work"><div class="big">✏️</div><div style="font-weight:700">풀이 사진 추가</div></label>`}
          </div>` : ''}
          <label class="field"><span>한마디 (선택)</span>
            <textarea id="askNote" rows="2" maxlength="500" placeholder="${check ? '예) 답이 3이 나왔는데 정답은 5래요' : '예) 21번이요. (나)조건을 모르겠어요'}">${esc(f.note)}</textarea>
          </label>
          <button class="btn btn-primary btn-block" id="askSubmit">${check ? '첨삭 받기' : '풀이 받기'}</button>
          <p class="muted small" style="text-align:center">AI 풀이도 틀릴 수 있어요. 이상하면 수업 시간에 꼭 물어보세요.</p>
        </section>

        <div class="section-label">내 질문 기록</div>
        <div class="list">
          ${ask.list.length ? ask.list.map(askItem).join('')
            : `<div class="empty">${ask.listLoading ? '불러오는 중...' : '아직 질문한 기록이 없어요'}</div>`}
        </div>`;

      $view.querySelectorAll('[data-ask-mode]').forEach((b) => b.onclick = () => { f.mode = b.dataset.askMode; render(); });
      $view.querySelectorAll('[data-ask-pick]').forEach((inp) => inp.onchange = () => askAddFiles(inp.dataset.askPick, [...inp.files]));
      $view.querySelectorAll('[data-ask-remove]').forEach((b) => b.onclick = () => {
        if (b.dataset.askRemove === 'problem') f.problem = null; else f.work.splice(+b.dataset.i, 1);
        render();
      });
      document.getElementById('askNote').oninput = (e) => { f.note = e.target.value; };
      document.getElementById('askSubmit').onclick = askSubmit;
    },
  };

  function noticeItem(n) {
    return `
      <a class="list-item" href="#notices/${n.id}">
        <div class="grow">
          <div class="title ellipsis">${n.pinned ? '📌 ' : ''}${esc(n.title)} ${UI.isNew(n.createdAt) ? '<span class="badge badge-new">N</span>' : ''}</div>
          <div class="sub">${UI.fmtDate(n.createdAt)}</div>
        </div>
        <span class="chev">›</span>
      </a>`;
  }

  /* ---------- 숙제 상세 + 제출 ---------- */
  function homeworkDetail(id) {
    const a = Store.get('assignments', id);
    if (!a) { location.hash = '#homework'; return; }
    const s = mySub(a.id);
    const canEdit = !s || s.status !== 'checked';

    $view.innerHTML = `
      <section class="card stack">
        <div class="detail-head">
          <div class="row wrap">${hwStatus(a)}<span class="muted small">마감 ${UI.fmtDate(a.dueDate)}</span></div>
          <h2 style="margin-top:8px">${esc(a.title)}</h2>
        </div>
        ${a.description ? `<div class="detail-body">${nl2br(a.description)}</div>` : ''}
      </section>

      ${s ? `
      <section class="card stack">
        <div class="card-title">내 제출물 <span class="muted small" style="font-weight:500">${UI.fmtDateTime(s.submittedAt)}${UI.isLate(a.dueDate, s.submittedAt) ? ' · <span class="badge badge-warn">지각 제출</span>' : ''}</span></div>
        <div>${UI.fileList(s.files)}</div>
        ${s.note ? `<p class="small"><span class="muted">메모 ·</span> ${esc(s.note)}</p>` : ''}
        ${s.feedback ? `<div class="feedback-box"><strong>선생님 피드백</strong>${nl2br(s.feedback)}</div>` : ''}
        ${s.status === 'checked' && !s.feedback ? '<div class="feedback-box"><strong>선생님 확인 완료</strong>확인했어요 👍</div>' : ''}
      </section>` : ''}

      ${canEdit ? `
      <form class="card stack" id="submitForm">
        <div class="card-title">${s ? '다시 제출하기' : '숙제 제출하기'}</div>
        <label class="dropzone">
          <input type="file" name="files" multiple accept="image/*,.pdf,.hwp,.hwpx,.doc,.docx">
          <div class="big">📷</div>
          <div style="font-weight:700">사진 찍기 / 파일 선택</div>
          <div class="muted small">여러 장 선택 가능 · 이미지, PDF, 한글 파일</div>
        </label>
        <div class="picked" id="picked"></div>
        <label class="field"><span>선생님께 메모 (선택)</span>
          <textarea name="note" placeholder="예) 5번 문제가 어려웠어요" rows="2">${s ? esc(s.note) : ''}</textarea>
        </label>
        <button class="btn btn-primary btn-block">제출하기</button>
        ${s ? '<p class="muted small" style="text-align:center">다시 제출하면 이전 파일은 새 파일로 바뀌어요.</p>' : ''}
      </form>` : '<p class="muted small" style="text-align:center">선생님이 확인을 완료한 숙제예요.</p>'}`;

    const form = document.getElementById('submitForm');
    if (!form) return;
    const input = form.querySelector('input[type=file]');
    input.onchange = () => {
      document.getElementById('picked').innerHTML = [...input.files].map((f) =>
        `<div class="file-chip"><span>${UI.fileIcon(f.type, f.name)}</span><span class="ellipsis">${esc(f.name)}</span><span class="muted small">${UI.fmtSize(f.size)}</span></div>`).join('');
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const files = [...input.files];
      if (!files.length) return UI.toast('파일을 선택해주세요.', 'error');
      if (files.some((f) => f.size > 50 * 1024 * 1024)) return UI.toast('파일은 50MB 이하만 올릴 수 있어요.', 'error');
      UI.busy(e.submitter, async () => {
        const saved = await UI.saveFiles(files, `homework/${me.id}`);
        const patch = { files: saved, note: form.note.value.trim(), submittedAt: Store.nowISO(), status: 'submitted', feedback: '' };
        if (s) {
          const old = (s.files || []).map((f) => f.fileId);
          await Store.update('submissions', s.id, patch);
          await FileDB.remove(old);
        } else {
          await Store.insert('submissions', { assignmentId: a.id, studentId: me.id, ...patch });
        }
        UI.toast('제출했어요!');
        render();
      }, '업로드 중...');
    };
  }

  /* ---------- 성적 상세 ---------- */
  function scoreDetail(id) {
    const t = Store.get('tests', id);
    if (!t) { location.hash = '#scores'; return; }
    const s = Store.scoreOf(t.id, me.id);
    const st = Store.testStats(t.id);
    const has = hasScore(s);
    const diff = has && st.avg !== null ? Math.round((s.score - st.avg) * 10) / 10 : null;
    $view.innerHTML = `
      <section class="card stack">
        <div>
          <p class="muted small">${UI.fmtDate(t.date)} · ${esc(t.className)}</p>
          <h2 style="font-size:19px;font-weight:800;margin-top:4px">${esc(t.title)}</h2>
        </div>
        <div class="score-big">${has ? s.score : '-'}<small> / ${t.maxScore}점</small></div>
        <div class="stat-grid">
          <div><b>${st.avg ?? '-'}</b><span>반 평균</span></div>
          <div><b>${st.max ?? '-'}</b><span>최고점</span></div>
          <div><b>${diff === null ? '-' : (diff > 0 ? '+' : '') + diff}</b><span>평균 대비</span></div>
        </div>
      </section>
      <section class="card">
        <div class="card-title">선생님 피드백</div>
        ${s && s.feedback ? `<div class="feedback-box">${nl2br(s.feedback)}</div>` : '<p class="muted small">아직 피드백이 없어요.</p>'}
      </section>`;
  }

  /* ---------- 점수 추이 차트 (SVG) ---------- */
  function chartSVG(rows) {
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
  }

  /* ============================================================
   * 질문하기
   *  - 질문노트(akymath.kr/ask)와 같은 서버 함수(ask)를 학생 로그인으로 호출 (횟수 제한 없음)
   *  - '풀이가 필요해요'는 단계별 풀이(style: steps)를 받아, 학생이 한 단계씩 눌러서 열어 봄
   * ============================================================ */
  const ask = { form: { mode: 'solve', problem: null, work: [], note: '' }, pending: null, list: [], listLoaded: false, listLoading: false };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const ASK_VERDICT = { correct: ['정답', 'badge-success'], wrong: ['오답', 'badge-danger'], unclear: ['확인 어려움', 'badge-warn'] };

  // 사진 줄이기 (긴 변 1600px JPEG + 기록용 작은 썸네일)
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없어요. 다른 사진으로 해 주세요.')); };
      img.src = url;
    });
  }
  function toJpeg(img, max, q) {
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }
  async function askAddFiles(kind, files) {
    const f = ask.form;
    try {
      if (kind === 'problem') {
        if (!files[0]) return;
        const img = await loadImage(files[0]);
        const full = toJpeg(img, 1600, 0.86);
        f.problem = { data: full.split(',')[1], preview: full, thumb: toJpeg(img, 240, 0.6) };
      } else {
        const room = 3 - f.work.length;
        if (files.length > room) UI.toast('풀이 사진은 3장까지 올릴 수 있어요.', 'error');
        for (const file of files.slice(0, room)) {
          const img = await loadImage(file);
          const full = toJpeg(img, 1600, 0.86);
          f.work.push({ data: full.split(',')[1], preview: full, thumb: toJpeg(img, 240, 0.6) });
        }
      }
    } catch (e) { UI.toast(e.message, 'error'); }
    render();
  }

  async function askSubmit() {
    const f = ask.form;
    if (!f.problem) return UI.toast('문제 사진을 올려 주세요.', 'error');
    if (f.mode === 'check' && !f.work.length) return UI.toast('내 풀이 사진을 올려 주세요.', 'error');
    const mode = f.mode;
    const req = { mode, note: f.note.trim(), thumbs: [f.problem.thumb, ...(mode === 'check' ? f.work.map((w) => w.thumb) : [])], startedAt: Date.now(), chars: 0 };
    const body = {
      action: 'ask', mode, style: 'steps', note: req.note, deviceId: 'app-' + me.id,
      problem: { type: 'image/jpeg', data: f.problem.data },
      work: mode === 'check' ? f.work.map((w) => ({ type: 'image/jpeg', data: w.data })) : [],
    };
    ask.pending = req;
    render();

    let text = '', done = null, failed = '';
    try {
      const { data } = await Store.client.auth.getSession();
      const token = data.session && data.session.access_token;
      if (!token) throw new Error('로그인이 풀렸어요. 다시 로그인해 주세요.');
      const cfg = window.APP_CONFIG;
      const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: cfg.SUPABASE_ANON_KEY },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        let b = {};
        try { b = await res.json(); } catch (e) { /* JSON 아님 */ }
        throw new Error(b.error || '서버에 연결하지 못했어요. 잠시 뒤에 다시 해 주세요.');
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'delta') { text += ev.text; req.chars = text.length; }
          else if (ev.type === 'done') done = ev;
          else if (ev.type === 'error') failed = ev.message;
        }
      }
      if (!done && !failed) failed = '연결이 끊겼어요. 다시 해 주세요.';
    } catch (e) {
      failed = e.message || '풀이 중 문제가 생겼어요.';
    }

    ask.pending = null;
    if (failed && !text) { UI.toast(failed, 'error'); if (location.hash.startsWith('#ask')) render(); return; }
    const id = (done && done.id) || 'local-' + Date.now();
    const verdictLine = UI.stripVerdict(text) !== text ? (text.match(/판정:\s*(정답|오답|확인 어려움)/) || [])[1] : null;
    const item = {
      id, mode, note: req.note, answer: text, created_at: new Date().toISOString(),
      verdict: mode === 'check' ? ((done && done.verdict) || { '정답': 'correct', '오답': 'wrong', '확인 어려움': 'unclear' }[verdictLine] || 'unclear') : null,
    };
    lsSet('ask-thumb-' + id, req.thumbs);
    ask.list.unshift(item);
    ask.form = { mode, problem: null, work: [], note: '' };
    if (failed) UI.toast(failed, 'error');
    if (location.hash.startsWith('#ask')) location.hash = '#ask/' + id;
    else UI.toast('질문 탭에 풀이가 도착했어요.');
  }

  function askWaiting() {
    const p = ask.pending;
    $view.innerHTML = `
      <section class="card stack ask-wait">
        <div class="ask-thumbs">${p.thumbs.map((t) => `<div class="ask-thumb"><img src="${t}" alt=""></div>`).join('')}</div>
        <div class="ask-wait-bar"><i></i></div>
        <p style="font-weight:700" id="askWaitMsg">${p.mode === 'check' ? '내 풀이를 한 줄씩 따라가며 보고 있어요' : '문제를 읽고 풀이를 만들고 있어요'}</p>
        <p class="muted small"><b id="askSec">0</b>초 · 보통 1분 안팎 걸려요. 이 화면을 닫지 말아 주세요.</p>
      </section>`;
    clearInterval(ask.tick);
    ask.tick = setInterval(() => {
      const sec = document.getElementById('askSec');
      if (!ask.pending || !sec) { clearInterval(ask.tick); return; }
      sec.textContent = Math.floor((Date.now() - ask.pending.startedAt) / 1000);
      if (ask.pending.chars) document.getElementById('askWaitMsg').textContent = '거의 다 됐어요. 풀이를 정리하고 있어요';
    }, 1000);
  }

  async function loadAskList() {
    ask.listLoading = true;
    const res = await Store.client.from('ask_questions').select('id, mode, verdict, note, answer, created_at')
      .eq('student_id', me.id).order('created_at', { ascending: false }).limit(50);
    ask.listLoading = false; ask.listLoaded = true;
    if (res.error) { console.warn(res.error); }
    else {
      const local = ask.list.filter((x) => String(x.id).startsWith('local-'));
      ask.list = [...local, ...res.data];
    }
    if (location.hash === '#ask' || location.hash === '') render();
  }

  function askBadges(r) {
    const v = r.mode === 'check' && ASK_VERDICT[r.verdict];
    return `<span class="badge ${r.mode === 'check' ? 'badge-warn' : 'badge-primary'}">${r.mode === 'check' ? '첨삭' : '풀이'}</span>`
      + (v ? ` <span class="badge ${v[1]}">${v[0]}</span>` : '');
  }
  function askItem(r) {
    const t = lsGet('ask-thumb-' + r.id, null);
    const cards = r.mode === 'check' ? 0 : buildSteps(r.answer).length;
    const opened = Math.min(lsGet('ask-open-' + r.id, 1), cards);
    return `
      <a class="list-item" href="#ask/${r.id}">
        ${t && t[0] ? `<div class="ask-li-thumb"><img src="${t[0]}" alt=""></div>` : `<div class="icon-box">${r.mode === 'check' ? '✏️' : '📷'}</div>`}
        <div class="grow">
          <div class="title ellipsis">${esc(r.note || UI.answerPreview(r.answer) || '질문')}</div>
          <div class="sub">${askBadges(r)} ${UI.fmtDateTime(r.created_at)}${cards ? ` · ${opened}/${cards} 열람` : ''}</div>
        </div>
        <span class="chev">›</span>
      </a>`;
  }

  // 풀이 글을 카드로 나누기: ## 제목별, '풀이'는 ### 단계별 (없으면 번호 목록으로)
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
    UI.stripVerdict(md).split('\n').forEach((line) => {
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

  async function askDetail(id) {
    let r = ask.list.find((x) => String(x.id) === id);
    if (!r) {
      $view.innerHTML = '<div class="empty">불러오는 중...</div>';
      const res = await Store.client.from('ask_questions').select('id, mode, verdict, note, answer, created_at').eq('id', id).maybeSingle();
      if (res.error || !res.data) { $view.innerHTML = '<div class="empty">질문을 찾을 수 없어요</div>'; return; }
      r = res.data;
      ask.list.push(r);
      if (location.hash !== '#ask/' + id) return;
    }
    $title.textContent = r.mode === 'check' ? '내 풀이 첨삭' : '단계별 풀이';
    const thumbs = lsGet('ask-thumb-' + r.id, []);
    const head = `
      <section class="card ask-head">
        ${thumbs.length ? `<div class="ask-thumbs">${thumbs.map((t) => `<div class="ask-thumb"><img src="${t}" alt=""></div>`).join('')}</div>` : ''}
        <div class="row wrap" style="gap:6px">${askBadges(r)}<span class="muted small">${UI.fmtDateTime(r.created_at)}</span></div>
        ${r.note ? `<p class="small">💬 ${esc(r.note)}</p>` : ''}
      </section>`;

    if (r.mode === 'check') {
      $view.innerHTML = `${head}<section class="card ask-md ${esc(r.verdict || '')}">${UI.renderMd(UI.stripVerdict(r.answer))}</section>`;
      return;
    }

    const cards = buildSteps(r.answer);
    const key = 'ask-open-' + r.id;
    const opened = Math.max(1, Math.min(lsGet(key, 1), cards.length));
    const html = cards.map((c, i) => {
      const icon = { read: '📖', hint: '💡', step: '✍️', answer: '✅', extra: '🔁' }[c.kind];
      if (i < opened) return `
        <section class="step-card open ${c.kind}" id="step-${i}">
          <div class="step-head"><span class="step-tag">${icon} ${esc(c.label)}</span>${c.title ? `<b>${esc(c.title)}</b>` : ''}</div>
          <div class="ask-md">${UI.renderMd(c.body)}</div>
        </section>`;
      if (i === opened) return `
        <button type="button" class="step-card next ${c.kind}" id="openNext">
          <span class="step-tag">${icon} ${esc(c.label)}</span>
          <span class="step-next-text">${c.kind === 'answer' ? '끝까지 고민해 봤나요? 눌러서 답 확인하기'
            : c.kind === 'step' && c.title ? `${esc(c.title)} · 눌러서 보기` : '눌러서 보기'}</span>
        </button>`;
      return `<div class="step-card locked"><span class="step-tag">🔒 ${esc(c.label)}</span></div>`;
    }).join('');

    $view.innerHTML = `${head}
      <div class="step-progress"><span>${opened} / ${cards.length} 열람</span><i style="width:${Math.round(opened / cards.length * 100)}%"></i></div>
      <p class="muted small" style="margin:0 4px">한 단계씩 열어 보고, 다음 단계는 먼저 스스로 해 보세요.</p>
      <div class="steps">${html}</div>
      <div class="row between" style="padding:0 4px">
        ${opened > 1 ? '<button type="button" class="link-btn" id="hideAll">처음부터 다시 가리기</button>' : '<span></span>'}
        ${opened < cards.length ? '<button type="button" class="link-btn" id="showAll">남은 풀이 모두 보기</button>' : ''}
      </div>`;

    const go = (n, scrollTo) => {
      lsSet(key, n);
      render();
      if (scrollTo !== undefined) document.getElementById('step-' + scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const next = document.getElementById('openNext');
    if (next) next.onclick = () => go(opened + 1, opened);
    const all = document.getElementById('showAll');
    if (all) all.onclick = () => go(cards.length);
    const hide = document.getElementById('hideAll');
    if (hide) hide.onclick = () => go(1);
  }

  /* ---------- 시작 ---------- */
  $back.onclick = () => history.back();
  document.getElementById('logoutBtn').onclick = async () => { await Store.signOut(); location.hash = ''; render(); };
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  UI.bindDownloads(document);
  // 선생님이 공지·성적·피드백을 올리면 자동 반영 (입력 중일 때는 건너뜀)
  Store.onChange(() => {
    const ae = document.activeElement;
    if (ae && ae !== document.body && $view.contains(ae)) return;
    if (document.querySelector('#picked .file-chip')) return; // 파일 고르는 중
    render();
  });

  (async function boot() {
    if (!Store.client) { document.body.classList.add('logged-out'); $view.innerHTML = UI.setupNotice(); return; }
    document.body.classList.add('logged-out');
    $view.innerHTML = '<div class="empty" style="padding-top:40vh">불러오는 중...</div>';
    try { await Store.init(); }
    catch (e) { console.error(e); UI.toast(UI.errMsg(e), 'error'); }
    render();
  })();
})();
