/* 관리자 웹 */
(function () {
  'use strict';
  const $view = document.getElementById('view');
  const $title = document.getElementById('pageTitle');
  const { esc, nl2br } = UI;

  const TITLES = { dashboard: '대시보드', homework: '숙제 관리', materials: '자료실', notices: '공지사항', scores: '성적 관리', students: '학생 관리', reports: '학부모 리포트', ask: '질문노트' };
  const byNewest = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
  const studentName = (id) => Store.get('students', id)?.name || '(삭제된 학생)';
  const hasScore = (s) => s && s.score !== null && s.score !== undefined;
  const classOptions = (selected = '', withAll = true) =>
    (withAll ? ['전체', ...Store.classes()] : Store.classes())
      .map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const classBadges = (s) => s.classNames.map((c) => `<span class="badge">${esc(c)}</span>`).join(' ');
  // 학생 반 고르기: 기존 반은 체크, 새 반은 입력 (쉼표로 여러 개)
  const classPicker = (selected = []) => {
    const all = Store.classes();
    return `
      <div class="field span-4"><span>반 (여러 개 고를 수 있어요)</span>
        ${all.length ? `<div class="row wrap" style="gap:6px 16px;margin-bottom:6px">${all.map((c) => `
          <label class="check"><input type="checkbox" name="cls" value="${esc(c)}" ${selected.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>` : ''}
        <input type="text" name="newClasses" placeholder="${all.length ? '새 반 추가 (선택) · 예) 고2 B반, 고2 심화반' : '예) 고1 A반 (여러 반이면 쉼표로 구분)'}">
      </div>`;
  };
  const readClasses = (f) => {
    const list = [...f.querySelectorAll('[name=cls]:checked')].map((x) => x.value)
      .concat(f.newClasses.value.split(',').map((x) => x.trim()).filter(Boolean));
    const out = [...new Set(list)];
    if (!out.length) throw new Error('반을 하나 이상 골라 주세요.');
    if (out.includes('전체')) throw new Error("'전체'는 반 이름으로 쓸 수 없어요.");
    return out;
  };
  const noClassHint = () => (Store.classes().length ? '' : '<p class="muted small">먼저 <a href="#students" style="color:var(--primary)">학생 관리</a>에서 학생을 등록하면 반 목록이 생겨요.</p>');

  // 폼 제출 공통: 버튼 잠금 + 오류 토스트 + 완료 후 다시 그리기
  const onSubmit = (form, fn, label) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      UI.busy(e.submitter, async () => { await fn(form); render(); }, label);
    };
  };
  const onClick = (selector, fn) => $view.querySelectorAll(selector).forEach((b) => {
    b.onclick = () => UI.busy(b, async () => { if ((await fn(b)) !== false) render(); });
  });

  /* ---------- 라우팅 ---------- */
  function render() {
    if (!Store.user() || !Store.isAdmin()) return renderLogin();
    document.getElementById('loginRoot')?.remove();
    document.querySelector('.layout').classList.remove('hidden');
    document.getElementById('academyName').textContent = Store.settings().academyName;

    const [route = 'dashboard', param] = location.hash.slice(1).split('/');
    const view = routes[route] ? route : 'dashboard';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
    $title.textContent = TITLES[view];

    const pending = Store.where('submissions', (s) => s.status === 'submitted').length;
    const pc = document.getElementById('pendingCount');
    pc.textContent = pending; pc.classList.toggle('hidden', !pending);

    routes[view](param && decodeURIComponent(param));
    UI.hydrateImages($view);
  }

  function renderLogin() {
    document.querySelector('.layout').classList.add('hidden');
    if (document.getElementById('loginRoot')) return;
    const root = document.createElement('div');
    root.id = 'loginRoot';
    root.className = 'admin-login';
    root.innerHTML = `
      <form class="card stack">
        <div><div style="font-size:36px">📘</div><h2>${esc(Store.settings().academyName)}</h2><p class="muted small">관리자 로그인</p></div>
        <label class="field"><span>이메일</span><input type="text" name="email" autocomplete="username" required></label>
        <label class="field"><span>비밀번호</span><input type="password" name="pw" autocomplete="current-password" required></label>
        <button class="btn btn-primary btn-block">로그인</button>
      </form>`;
    document.body.appendChild(root);
    root.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      UI.busy(e.submitter, async () => {
        await Store.signIn(f.email.value, f.pw.value);
        if (!Store.isAdmin()) {
          await Store.signOut();
          throw new Error('관리자 권한이 없는 계정이에요. (supabase/make-admin.sql 참고)');
        }
        render();
      }, '로그인 중...');
    };
  }

  /* ============================================================
   * 화면들
   * ============================================================ */
  const routes = {
    /* ---------- 대시보드 ---------- */
    dashboard() {
      const subs = Store.all('submissions').slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      const pending = subs.filter((s) => s.status === 'submitted');
      const active = Store.where('assignments', (a) => !UI.isOverdue(a.dueDate));
      $view.innerHTML = `
        ${Store.all('students').length ? '' : `
        <section class="card" style="border-color:var(--primary)">
          <div class="card-title">👋 시작하기</div>
          <p>1) <a href="#students" style="color:var(--primary);font-weight:700">학생 관리</a>에서 학생 계정을 만들고 →
             2) 학생에게 아이디·비밀번호를 알려주면 → 3) 학생 앱에서 로그인할 수 있어요.</p>
        </section>`}
        <div class="stats">
          <a class="card stat" href="#students"><div class="label">전체 학생</div><div class="value">${Store.all('students').length}</div></a>
          <a class="card stat" href="#homework"><div class="label">확인 대기 숙제</div><div class="value ${pending.length ? 'alert' : ''}">${pending.length}</div></a>
          <a class="card stat" href="#homework"><div class="label">진행 중 숙제</div><div class="value">${active.length}</div></a>
          <a class="card stat" href="#materials"><div class="label">자료실 자료</div><div class="value">${Store.all('materials').length}</div></a>
        </div>
        <div class="two-col">
          <section>
            <div class="card-title">최근 숙제 제출</div>
            <div class="table-wrap"><table>
              <thead><tr><th>학생</th><th>숙제</th><th>제출 시각</th><th>상태</th></tr></thead>
              <tbody>${subs.slice(0, 8).map((s) => {
                const a = Store.get('assignments', s.assignmentId);
                return `<tr>
                  <td><b>${esc(studentName(s.studentId))}</b></td>
                  <td><a class="title-link" href="#homework/${s.assignmentId}">${esc(a?.title || '-')}</a></td>
                  <td class="muted">${UI.fmtDateTime(s.submittedAt)}</td>
                  <td>${statusBadge(s, a)}</td></tr>`;
              }).join('') || '<tr><td colspan="4" class="empty">제출된 숙제가 없습니다</td></tr>'}</tbody>
            </table></div>
          </section>
          <section>
            <div class="card-title">최근 공지 <a href="#notices" class="btn btn-sm">공지 작성</a></div>
            <div class="table-wrap"><table><tbody>
              ${Store.all('notices').slice().sort(byNewest).slice(0, 5).map((n) => `
                <tr><td>${n.pinned ? '📌 ' : ''}<b>${esc(n.title)}</b><div class="muted small">${esc(n.className)} · ${UI.fmtDate(n.createdAt)}</div></td></tr>`).join('')
                || '<tr><td class="empty">공지가 없습니다</td></tr>'}
            </tbody></table></div>
          </section>
        </div>`;
    },

    /* ---------- 숙제 관리 ---------- */
    homework(id) {
      if (id) return homeworkDetail(id);
      const list = Store.all('assignments').slice().sort((a, b) => b.dueDate.localeCompare(a.dueDate));
      $view.innerHTML = `
        <details class="card form-card" ${list.length ? '' : 'open'}>
          <summary>＋ 새 숙제 등록</summary>
          <form id="hwForm" class="stack">
            ${noClassHint()}
            <div class="form-grid">
              <label class="field span-2"><span>숙제 제목</span><input type="text" name="title" required placeholder="예) 워크북 p.20~25"></label>
              <label class="field"><span>대상 반</span><select name="className">${classOptions()}</select></label>
              <label class="field"><span>마감일</span><input type="date" name="dueDate" required value="${UI.todayStr()}"></label>
              <label class="field span-4"><span>설명</span><textarea name="description" rows="3" placeholder="학생에게 보여줄 안내 사항"></textarea></label>
            </div>
            <div class="form-actions"><button class="btn btn-primary">등록하기</button></div>
          </form>
        </details>
        <div class="table-wrap"><table>
          <thead><tr><th>숙제</th><th>대상</th><th>마감</th><th>제출</th><th>확인 대기</th><th></th></tr></thead>
          <tbody>${list.map((a) => {
            const targets = Store.studentsFor(a.className);
            const subs = Store.where('submissions', (s) => s.assignmentId === a.id);
            const pending = subs.filter((s) => s.status === 'submitted').length;
            const pct = targets.length ? Math.round((subs.length / targets.length) * 100) : 0;
            return `<tr>
              <td><a class="title-link" href="#homework/${a.id}">${esc(a.title)}</a></td>
              <td><span class="badge">${esc(a.className)}</span></td>
              <td>${UI.fmtDate(a.dueDate)} ${UI.isOverdue(a.dueDate) ? '<span class="badge">마감</span>' : `<span class="badge badge-warn">${UI.dday(a.dueDate)}</span>`}</td>
              <td>${subs.length} / ${targets.length}<div class="progress"><i style="width:${pct}%"></i></div></td>
              <td>${pending ? `<span class="badge badge-danger">${pending}건</span>` : '<span class="muted">-</span>'}</td>
              <td class="actions"><a class="btn btn-sm" href="#homework/${a.id}">제출물 보기</a><button class="btn btn-sm btn-danger" data-del-hw="${a.id}">삭제</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="6" class="empty">등록된 숙제가 없습니다</td></tr>'}</tbody>
        </table></div>`;

      onSubmit(document.getElementById('hwForm'), async (f) => {
        await Store.insert('assignments', { title: f.title.value.trim(), className: f.className.value, dueDate: f.dueDate.value, description: f.description.value.trim() });
        UI.toast('숙제를 등록했습니다.');
      }, '등록 중...');
      onClick('[data-del-hw]', async (b) => {
        if (!confirm('이 숙제와 학생 제출물(파일 포함)을 모두 삭제할까요?')) return false;
        const aid = b.dataset.delHw;
        const paths = Store.where('submissions', (x) => x.assignmentId === aid).flatMap((s) => (s.files || []).map((f) => f.fileId));
        await Store.remove('assignments', aid); // 제출물은 DB에서 자동 삭제
        await FileDB.remove(paths);
        UI.toast('삭제했습니다.');
      });
    },

    /* ---------- 자료실 ---------- */
    materials() {
      const list = Store.all('materials').slice().sort(byNewest);
      const cats = [...new Set(['수업자료', '기출문제', '해설', ...list.map((m) => m.category)])];
      $view.innerHTML = `
        <details class="card form-card" open>
          <summary>＋ 자료 업로드</summary>
          <form id="matForm" class="stack">
            <div class="form-grid">
              <label class="field span-2"><span>자료 제목</span><input type="text" name="title" required placeholder="예) 2단원 개념 정리"></label>
              <label class="field"><span>분류</span><input type="text" name="category" list="catList" value="수업자료" required><datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
              <label class="field"><span>공개 대상</span><select name="className">${classOptions()}</select></label>
              <label class="field span-2"><span>파일 (최대 50MB)</span><input type="file" name="file" required></label>
              <label class="field span-2"><span>설명 (선택)</span><input type="text" name="description" placeholder="학생에게 보여줄 한 줄 설명"></label>
            </div>
            <div class="form-actions"><button class="btn btn-primary">업로드</button></div>
          </form>
        </details>
        <div class="table-wrap"><table>
          <thead><tr><th>자료</th><th>분류</th><th>대상</th><th>파일</th><th>등록일</th><th></th></tr></thead>
          <tbody>${list.map((m) => `<tr>
            <td><b>${esc(m.title)}</b>${m.description ? `<div class="muted small">${esc(m.description)}</div>` : ''}</td>
            <td><span class="badge badge-primary">${esc(m.category)}</span></td>
            <td><span class="badge">${esc(m.className)}</span></td>
            <td class="small">${UI.fileIcon(m.fileType, m.fileName)} ${esc(m.fileName)} <span class="muted">${UI.fmtSize(m.fileSize)}</span></td>
            <td class="muted">${UI.fmtDate(m.createdAt)}</td>
            <td class="actions"><button class="btn btn-sm" data-download="${esc(m.fileId)}" data-name="${esc(m.fileName)}">다운로드</button><button class="btn btn-sm btn-danger" data-del-mat="${m.id}">삭제</button></td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">자료가 없습니다</td></tr>'}</tbody>
        </table></div>`;

      onSubmit(document.getElementById('matForm'), async (f) => {
        const file = f.file.files[0];
        if (file.size > 50 * 1024 * 1024) throw new Error('파일이 너무 커요. (최대 50MB)');
        const fileId = await FileDB.put(file, 'materials');
        await Store.insert('materials', {
          title: f.title.value.trim(), category: f.category.value.trim(), className: f.className.value,
          description: f.description.value.trim(), fileId, fileName: file.name, fileSize: file.size, fileType: file.type,
        });
        UI.toast('자료를 업로드했습니다.');
      }, '업로드 중...');
      onClick('[data-del-mat]', async (b) => {
        if (!confirm('이 자료를 삭제할까요?')) return false;
        const m = Store.get('materials', b.dataset.delMat);
        await Store.remove('materials', m.id);
        await FileDB.remove(m.fileId);
        UI.toast('삭제했습니다.');
      });
    },

    /* ---------- 공지사항 ---------- */
    notices(editId) {
      const editing = editId ? Store.get('notices', editId) : null;
      const list = Store.all('notices').slice().sort((a, b) => (b.pinned - a.pinned) || byNewest(a, b));
      $view.innerHTML = `
        <details class="card form-card" ${editing || !list.length ? 'open' : ''}>
          <summary>${editing ? '✏️ 공지 수정' : '＋ 새 공지 작성'}</summary>
          <form id="noticeForm" class="stack">
            <div class="form-grid">
              <label class="field span-2"><span>제목</span><input type="text" name="title" required value="${esc(editing?.title || '')}"></label>
              <label class="field"><span>대상</span><select name="className">${classOptions(editing?.className)}</select></label>
              <label class="field" style="align-self:end;padding-bottom:10px"><span class="check"><input type="checkbox" name="pinned" ${editing?.pinned ? 'checked' : ''}> 📌 상단 고정</span></label>
              <label class="field span-4"><span>내용</span><textarea name="body" rows="6" required>${esc(editing?.body || '')}</textarea></label>
            </div>
            <div class="form-actions">
              ${editing ? '<a class="btn" href="#notices">취소</a>' : ''}
              <button class="btn btn-primary">${editing ? '수정 저장' : '게시하기'}</button>
            </div>
          </form>
        </details>
        <div class="table-wrap"><table>
          <thead><tr><th>제목</th><th>대상</th><th>게시일</th><th></th></tr></thead>
          <tbody>${list.map((n) => `<tr>
            <td>${n.pinned ? '<span class="badge badge-danger">📌 고정</span> ' : ''}<b>${esc(n.title)}</b><div class="muted small ellipsis" style="max-width:520px">${esc(n.body)}</div></td>
            <td><span class="badge">${esc(n.className)}</span></td>
            <td class="muted">${UI.fmtDate(n.createdAt)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-pin="${n.id}">${n.pinned ? '고정 해제' : '고정'}</button>
              <a class="btn btn-sm" href="#notices/${n.id}">수정</a>
              <button class="btn btn-sm btn-danger" data-del-notice="${n.id}">삭제</button>
            </td></tr>`).join('') || '<tr><td colspan="4" class="empty">공지가 없습니다</td></tr>'}</tbody>
        </table></div>`;

      onSubmit(document.getElementById('noticeForm'), async (f) => {
        const payload = { title: f.title.value.trim(), className: f.className.value, pinned: f.pinned.checked, body: f.body.value.trim() };
        if (editing) {
          await Store.update('notices', editing.id, payload);
          UI.toast('수정했습니다.');
          history.replaceState(null, '', '#notices');
        } else {
          await Store.insert('notices', payload);
          UI.toast('공지를 게시했습니다.');
        }
      }, '저장 중...');
      onClick('[data-pin]', async (b) => {
        const n = Store.get('notices', b.dataset.pin);
        await Store.update('notices', n.id, { pinned: !n.pinned });
      });
      onClick('[data-del-notice]', async (b) => {
        if (!confirm('이 공지를 삭제할까요?')) return false;
        await Store.remove('notices', b.dataset.delNotice);
        UI.toast('삭제했습니다.');
        history.replaceState(null, '', '#notices');
      });
    },

    /* ---------- 성적 관리 ---------- */
    scores(id) {
      if (id) return scoreEntry(id);
      const classes = Store.classes();
      if (scoreClass !== 'all' && !classes.includes(scoreClass)) scoreClass = 'all';
      const allTests = Store.all('tests').slice().sort((a, b) => b.date.localeCompare(a.date));
      const list = scoreClass === 'all' ? allTests : allTests.filter((t) => t.className === scoreClass);
      const chip = (k, label) => `<button class="chip ${scoreClass === k ? 'active' : ''}" data-sclass="${esc(k)}">${esc(label)}</button>`;
      $view.innerHTML = `
        <details class="card form-card" ${list.length ? '' : 'open'}>
          <summary>＋ 새 테스트 만들기</summary>
          <form id="testForm" class="stack">
            ${noClassHint()}
            <div class="form-grid">
              <label class="field span-2"><span>테스트 이름</span><input type="text" name="title" required placeholder="예) 단원평가 3회 · 인수분해"></label>
              <label class="field"><span>응시 반</span><select name="className" required>${classOptions('', false)}</select></label>
              <label class="field"><span>시험일</span><input type="date" name="date" required value="${UI.todayStr()}"></label>
              <label class="field"><span>만점</span><input type="number" name="maxScore" value="100" min="1" required></label>
            </div>
            <div class="form-actions"><button class="btn btn-primary">만들고 성적 입력하기</button></div>
          </form>
        </details>
        ${classes.length > 1 ? `<div class="filter-bar">${chip('all', '모든 반')}${classes.map((c) => chip(c, c)).join('')}</div>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>테스트</th><th>반</th><th>시험일</th><th>입력</th><th>평균</th><th>최고 / 최저</th><th></th></tr></thead>
          <tbody>${list.map((t) => {
            const st = Store.testStats(t.id);
            const total = Store.studentsFor(t.className).length;
            return `<tr>
              <td><a class="title-link" href="#scores/${t.id}">${esc(t.title)}</a></td>
              <td><span class="badge">${esc(t.className)}</span></td>
              <td class="muted">${UI.fmtDate(t.date)}</td>
              <td>${st.count} / ${total} ${st.count < total ? '<span class="badge badge-warn">미입력</span>' : '<span class="badge badge-success">완료</span>'}</td>
              <td><b>${st.avg ?? '-'}</b> <span class="muted small">/ ${t.maxScore}</span></td>
              <td class="muted">${st.max ?? '-'} / ${st.min ?? '-'}</td>
              <td class="actions"><a class="btn btn-sm btn-primary" href="#scores/${t.id}">성적·피드백 입력</a><button class="btn btn-sm btn-danger" data-del-test="${t.id}">삭제</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="empty">테스트가 없습니다</td></tr>'}</tbody>
        </table></div>`;

      $view.querySelectorAll('[data-sclass]').forEach((b) => b.onclick = () => { scoreClass = b.dataset.sclass; render(); });
      const form = document.getElementById('testForm');
      if (scoreClass !== 'all') form.className.value = scoreClass;
      form.onsubmit = (e) => {
        e.preventDefault();
        UI.busy(e.submitter, async () => {
          const t = await Store.insert('tests', { title: form.title.value.trim(), className: form.className.value, date: form.date.value, maxScore: Number(form.maxScore.value) });
          location.hash = '#scores/' + t.id;
        }, '만드는 중...');
      };
      onClick('[data-del-test]', async (b) => {
        if (!confirm('이 테스트와 입력된 성적을 모두 삭제할까요?')) return false;
        await Store.remove('tests', b.dataset.delTest); // 성적은 DB에서 자동 삭제
        UI.toast('삭제했습니다.');
      });
    },

    /* ---------- 학생 관리 ---------- */
    students(id) {
      if (id) return studentEdit(id);
      const list = Store.all('students').slice().sort((a, b) => Store.classLabel(a).localeCompare(Store.classLabel(b)) || a.name.localeCompare(b.name));
      $view.innerHTML = `
        <details class="card form-card" ${list.length ? '' : 'open'}>
          <summary>＋ 학생 계정 만들기</summary>
          <form id="stuForm" class="stack">
            <div class="form-grid">
              <label class="field"><span>이름</span><input type="text" name="name" required></label>
              <label class="field"><span>학교</span><input type="text" name="school" placeholder="예) 부일고"></label>
              <label class="field span-2"><span>학부모 연락처</span><input type="tel" name="parentPhone" placeholder="010-1234-5678" inputmode="tel"></label>
              ${classPicker()}
              <label class="field"><span>로그인 아이디 (영문·숫자)</span><input type="text" name="loginId" required pattern="[A-Za-z0-9._\\-]{3,30}" title="영문, 숫자 3~30자" autocapitalize="off" placeholder="예) minjun08"></label>
              <label class="field"><span>초기 비밀번호 (6자 이상)</span><input type="text" name="password" required minlength="6" autocomplete="off"></label>
            </div>
            <div class="form-actions"><button class="btn btn-primary">계정 만들기</button></div>
          </form>
        </details>
        ${Store.classes().length ? `
        <details class="card form-card">
          <summary>🏷️ 반 관리 (이름 바꾸기)</summary>
          <div class="table-wrap" style="margin-top:10px"><table>
            <thead><tr><th>반</th><th>학생</th><th>숙제</th><th>테스트</th><th></th></tr></thead>
            <tbody>${Store.classes().map((c) => `<tr>
              <td><span class="badge">${esc(c)}</span></td>
              <td>${Store.studentsFor(c).length}명</td>
              <td>${Store.where('assignments', (a) => a.className === c).length}개</td>
              <td>${Store.where('tests', (t) => t.className === c).length}개</td>
              <td class="actions"><button class="btn btn-sm" data-rename="${esc(c)}">이름 바꾸기</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <p class="muted small">이름을 바꾸면 학생들의 반과 그 반의 숙제·자료·공지·테스트도 함께 새 이름으로 바뀌어요. 이미 있는 반 이름을 적으면 두 반이 하나로 합쳐져요.</p>
        </details>` : ''}
        <div class="table-wrap"><table>
          <thead><tr><th>이름</th><th>아이디</th><th>학교</th><th>반</th><th>학부모 연락처</th><th>숙제 제출</th><th>최근 점수</th><th></th></tr></thead>
          <tbody>${list.map((s) => {
            const hw = Store.where('assignments', (a) => Store.targets(a, s.classNames));
            const done = hw.filter((a) => Store.submissionOf(a.id, s.id)).length;
            // 최근 점수는 반별로 따로
            const lastOf = (c) => Store.where('tests', (t) => t.className === c).sort((a, b) => b.date.localeCompare(a.date))
              .map((t) => ({ t, sc: Store.scoreOf(t.id, s.id) })).find((x) => hasScore(x.sc));
            const lasts = s.classNames.map((c) => ({ c, x: lastOf(c) })).filter((r) => r.x);
            const multi = s.classNames.length > 1;
            return `<tr>
              <td><b>${esc(s.name)}</b></td>
              <td class="muted">${esc(s.loginId)}</td>
              <td>${esc(s.school)}</td>
              <td>${classBadges(s)}</td>
              <td>${s.parentPhone ? esc(UI.fmtPhone(s.parentPhone)) : '<span class="badge badge-warn">미등록</span>'}${Store.parentsOf(s.id).length ? ' <span class="badge badge-primary" title="학부모 앱 계정 있음">📱 앱</span>' : ''}</td>
              <td>${done} / ${hw.length}</td>
              <td>${lasts.length ? lasts.map(({ c, x }) => `<div>${multi ? `<span class="muted small">${esc(c)}</span> ` : ''}<b>${x.sc.score}</b> <span class="muted small">${esc(x.t.title)}</span></div>`).join('') : '<span class="muted">-</span>'}</td>
              <td class="actions"><a class="btn btn-sm" href="#students/${s.id}">수정</a><button class="btn btn-sm" data-pw="${s.id}">비밀번호 변경</button><button class="btn btn-sm btn-danger" data-del-stu="${s.id}">삭제</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="8" class="empty">등록된 학생이 없습니다</td></tr>'}</tbody>
        </table></div>`;

      onSubmit(document.getElementById('stuForm'), async (f) => {
        await Store.createStudent({
          name: f.name.value.trim(), school: f.school.value.trim(), classNames: readClasses(f),
          loginId: f.loginId.value.trim(), password: f.password.value, parentPhone: UI.phoneDigits(f.parentPhone.value),
        });
        UI.toast(`${f.name.value.trim()} 학생 계정을 만들었습니다.`);
      }, '만드는 중...');
      onClick('[data-rename]', async (b) => {
        const oldName = b.dataset.rename;
        const input = prompt(`'${oldName}' 반의 새 이름`, oldName);
        if (input === null) return false;
        const newName = input.trim();
        if (!newName || newName === oldName) return false;
        if (newName === '전체') { UI.toast("'전체'는 반 이름으로 쓸 수 없어요.", 'error'); return false; }
        if (Store.classes().includes(newName)
          && !confirm(`'${newName}' 반이 이미 있어요. 두 반을 하나로 합칠까요?\n('${oldName}'의 학생·숙제·테스트가 모두 '${newName}'(으)로 옮겨져요)`)) return false;
        await Store.renameClass(oldName, newName);
        UI.toast(`'${oldName}' → '${newName}' 으로 바꿨어요.`);
      });
      onClick('[data-pw]', async (b) => {
        const pw = prompt(`${studentName(b.dataset.pw)} 학생의 새 비밀번호 (6자 이상)`);
        if (pw === null) return false;
        if (pw.length < 6) { UI.toast('비밀번호는 6자 이상이어야 해요.', 'error'); return false; }
        await Store.setStudentPassword(b.dataset.pw, pw);
        UI.toast('비밀번호를 변경했습니다.');
        return false;
      });
      onClick('[data-del-stu]', async (b) => {
        if (!confirm(`${studentName(b.dataset.delStu)} 학생 계정을 삭제할까요?\n제출물과 성적도 함께 삭제되며 되돌릴 수 없습니다.`)) return false;
        await Store.deleteStudent(b.dataset.delStu);
        UI.toast('삭제했습니다.');
      });
    },

    /* ---------- 학부모 리포트 ---------- */
    reports() {
      const classes = Store.classes();
      if (!rep.className || (rep.className !== '전체' && !classes.includes(rep.className))) rep.className = classes[0] || '전체';
      const students = Store.studentsFor(rep.className);
      const noPhone = students.filter((s) => !s.parentPhone).length;

      $view.innerHTML = `
        <section class="card stack" id="repOptions">
          <div class="form-grid">
            <label class="field"><span>반</span><select name="className">${classOptions(rep.className)}</select></label>
            <label class="field"><span>시작일</span><input type="date" name="from" value="${rep.from}"></label>
            <label class="field"><span>종료일</span><input type="date" name="to" value="${rep.to}"></label>
            <div class="field"><span>빠른 선택</span>
              <div class="row wrap"><button type="button" class="btn btn-sm" data-range="7">1주</button><button type="button" class="btn btn-sm" data-range="14">2주</button><button type="button" class="btn btn-sm" data-range="30">1개월</button></div>
            </div>
            <div class="field span-4"><span>포함 항목</span>
              <div class="row wrap" style="gap:16px">
                <label class="check"><input type="checkbox" name="hw" ${rep.hw ? 'checked' : ''}> 숙제 현황</label>
                <label class="check"><input type="checkbox" name="scores" ${rep.scores ? 'checked' : ''}> 테스트 성적</label>
                <label class="check"><input type="checkbox" name="fb" ${rep.fb ? 'checked' : ''}> 선생님 피드백</label>
              </div>
            </div>
            <label class="field span-4"><span>마무리 문구</span><textarea name="closing" rows="2">${esc(rep.closing)}</textarea></label>
          </div>
          <p class="muted small">💡 학부모 앱 계정이 있으면 [학부모 앱으로 보내기]로 학부모님 앱에 바로 전달되고, 읽으면 '읽음 ✓'으로 표시돼요. 또는 [복사] 후 카카오톡에 붙여넣거나, 휴대폰에서 이 화면을 열면 [문자 보내기]로 문자 앱이 바로 열립니다. 아래 문구는 보내기 전에 직접 고칠 수 있어요.</p>
        </section>
        ${noPhone ? `<p class="small" style="color:var(--warn)">⚠️ 학부모 연락처가 없는 학생이 ${noPhone}명 있어요. 이름 옆 [연락처 등록]을 눌러 추가하세요.</p>` : ''}
        <div class="sub-grid">
          ${students.map((s) => {
            const text = buildReport(s);
            const last = Store.where('report_logs', (l) => l.studentId === s.id).sort(byNewest)[0];
            const hasApp = Store.parentsOf(s.id).length > 0;
            return `
            <div class="card sub-card" data-card="${s.id}">
              <div class="row between">
                <span class="who">${esc(s.name)} <span class="muted small" style="font-weight:500">${esc(Store.classLabel(s))}</span></span>
                ${s.parentPhone ? `<span class="small">📞 ${esc(UI.fmtPhone(s.parentPhone))}</span>` : `<a class="btn btn-sm" href="#students/${s.id}">연락처 등록</a>`}
              </div>
              <textarea class="report-text" data-text="${s.id}">${esc(text)}</textarea>
              <div class="row between">
                <span class="muted small" data-last="${s.id}">${lastText(last)}</span>
                <span class="row wrap">
                  <button class="btn btn-sm" data-copy="${s.id}">📋 복사</button>
                  ${s.parentPhone ? `<a class="btn btn-sm" data-sms="${s.id}" href="#">💬 문자 보내기</a>` : ''}
                  ${hasApp ? `<button class="btn btn-sm btn-primary" data-app="${s.id}">📱 학부모 앱으로 보내기</button>`
                    : `<a class="btn btn-sm" href="#students/${s.id}" title="학부모 앱 계정을 만들면 앱으로 바로 보낼 수 있어요">📱 앱 계정 만들기</a>`}
                </span>
              </div>
            </div>`;
          }).join('') || '<div class="empty">학생이 없습니다</div>'}
        </div>`;

      // 옵션 변경 → 문구 다시 만들기
      const opt = document.getElementById('repOptions');
      opt.querySelectorAll('select, input').forEach((el) => el.onchange = () => {
        rep.className = opt.querySelector('[name=className]').value;
        rep.from = opt.querySelector('[name=from]').value || rep.from;
        rep.to = opt.querySelector('[name=to]').value || rep.to;
        rep.hw = opt.querySelector('[name=hw]').checked;
        rep.scores = opt.querySelector('[name=scores]').checked;
        rep.fb = opt.querySelector('[name=fb]').checked;
        render();
      });
      opt.querySelector('[name=closing]').onchange = (e) => {
        rep.closing = e.target.value;
        try { localStorage.setItem('lms_report_closing', rep.closing); } catch (err) { /* 무시 */ }
        render();
      };
      opt.querySelectorAll('[data-range]').forEach((b) => b.onclick = () => {
        rep.to = UI.todayStr(); rep.from = daysAgo(Number(b.dataset.range)); render();
      });

      const textOf = (sid) => $view.querySelector(`[data-text="${sid}"]`).value;
      const logSend = async (sid, channel) => {
        try {
          const row = await Store.insert('report_logs', { studentId: sid, channel, periodStart: rep.from, periodEnd: rep.to, content: textOf(sid) });
          const el = $view.querySelector(`[data-last="${sid}"]`);
          if (el) el.textContent = lastText(row);
        } catch (e) {
          console.error(e);
          if (channel === 'app') throw e; // 앱 발송 실패는 알려야 함
        }
      };
      $view.querySelectorAll('[data-app]').forEach((b) => b.onclick = () => {
        const s = Store.get('students', b.dataset.app);
        if (!confirm(`${s.name} 학생 학부모님 앱으로 이 리포트를 보낼까요?\n(보낸 뒤에는 학부모님 앱에 바로 표시돼요)`)) return;
        UI.busy(b, async () => {
          await logSend(s.id, 'app');
          UI.toast('학부모 앱으로 보냈어요.');
        }, '보내는 중...');
      });
      $view.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
        const ok = await UI.copyText(textOf(b.dataset.copy));
        if (!ok) return UI.toast('복사에 실패했어요. 직접 선택해서 복사해주세요.', 'error');
        UI.toast('복사했어요. 카카오톡 등에 붙여넣으세요.');
        logSend(b.dataset.copy, 'copy');
      });
      $view.querySelectorAll('[data-sms]').forEach((a) => a.onclick = (e) => {
        const s = Store.get('students', a.dataset.sms);
        a.href = UI.smsHref(s.parentPhone, textOf(s.id)); // 클릭 순간의 (수정된) 문구로 링크 생성
        logSend(s.id, 'sms');
      });
    },

    /* ---------- 질문노트 (by-the-river.github.io/ask 로 들어온 질문) ---------- */
    ask(id) {
      if (id) return askDetail(id);
      if (!ask.loaded && !ask.loading) loadAsk(true);
      const f = ask.filter;
      const chip = (k, label) => `<button class="chip ${f.mode === k ? 'active' : ''}" data-ask-mode="${k}">${label}</button>`;
      const students = Store.all('students').slice().sort((a, b) => a.name.localeCompare(b.name));
      const m = ask.month;

      $view.innerHTML = `
        <section class="card summary-row">
          <div><b>${m ? m.today : '-'}</b><span>오늘 질문</span></div>
          <div><b>${m ? m.count : '-'}</b><span>이번 달 질문</span></div>
          <div><b>${m ? '$' + m.cost.toFixed(2) : '-'}</b><span>이번 달 예상 비용 (약 ${m ? Math.round(m.cost * 1400).toLocaleString() : '-'}원)</span></div>
          <div><b>${m ? m.wrong : '-'}</b><span>이번 달 오답 첨삭</span></div>
        </section>
        <div class="row between wrap">
          <div class="filter-bar">${chip('all', '전체')}${chip('solve', '풀이 요청')}${chip('check', '풀이 첨삭')}${chip('wrong', '오답 판정만')}</div>
          <div class="row">
            <select id="askStudent" class="ask-select">
              <option value="all">모든 질문자</option>
              <option value="members" ${f.student === 'members' ? 'selected' : ''}>학습앱 학생만</option>
              <option value="anon" ${f.student === 'anon' ? 'selected' : ''}>비로그인만</option>
              ${students.map((s) => `<option value="${s.id}" ${f.student === s.id ? 'selected' : ''}>${esc(s.name)} (${esc(Store.classLabel(s))})</option>`).join('')}
            </select>
            <button class="btn btn-sm" id="askReload">↻ 새로고침</button>
          </div>
        </div>
        ${ask.error ? `<p class="small" style="color:var(--danger)">${esc(ask.error)}</p>` : ''}
        <div class="ask-grid">
          ${ask.rows.map(askCard).join('') || `<div class="empty">${ask.loading ? '불러오는 중...' : '아직 들어온 질문이 없어요'}</div>`}
        </div>
        ${ask.hasMore && ask.rows.length ? `<div style="text-align:center"><button class="btn" id="askMore">${ask.loading ? '불러오는 중...' : '더 보기'}</button></div>` : ''}`;

      $view.querySelectorAll('[data-ask-mode]').forEach((b) => b.onclick = () => { ask.filter.mode = b.dataset.askMode; loadAsk(true); });
      document.getElementById('askStudent').onchange = (e) => { ask.filter.student = e.target.value; loadAsk(true); };
      document.getElementById('askReload').onclick = () => loadAsk(true);
      const more = document.getElementById('askMore');
      if (more) more.onclick = () => loadAsk(false);
    },
  };

  /* ---------- 질문노트 데이터 ---------- */
  const ASK_PAGE = 24;
  const ASK_PRICE_IN = 4 / 1e6, ASK_PRICE_OUT = 20 / 1e6; // Claude Opus 5.5 토큰당 달러
  const ask = { rows: [], loaded: false, loading: false, hasMore: true, error: '', month: null, filter: { mode: 'all', student: 'all' } };

  async function loadAsk(reset) {
    const sb = Store.client;
    if (reset) { ask.rows = []; ask.hasMore = true; }
    ask.loading = true; ask.error = '';
    if (location.hash.startsWith('#ask')) render();
    try {
      let q = sb.from('ask_questions').select('*').order('created_at', { ascending: false })
        .range(ask.rows.length, ask.rows.length + ASK_PAGE - 1);
      const f = ask.filter;
      if (f.mode === 'solve' || f.mode === 'check') q = q.eq('mode', f.mode);
      if (f.mode === 'wrong') q = q.eq('mode', 'check').eq('verdict', 'wrong');
      if (f.student === 'members') q = q.not('student_id', 'is', null);
      else if (f.student === 'anon') q = q.is('student_id', null);
      else if (f.student !== 'all') q = q.eq('student_id', f.student);
      const res = await q;
      if (res.error) throw res.error;
      const rows = res.data.map((r) => ({ ...r, images: Array.isArray(r.images) ? r.images : [] }));
      ask.rows = ask.rows.concat(rows);
      ask.hasMore = rows.length === ASK_PAGE;
      if (reset) await loadAskMonth();
    } catch (e) {
      console.error(e);
      ask.error = /ask_questions|images/.test(e.message || '')
        ? '질문 기록을 불러오지 못했어요. supabase/ask-schema.sql, ask-schema-2.sql 을 실행했는지 확인해주세요.'
        : UI.errMsg(e);
    }
    ask.loading = false; ask.loaded = true;
    if (location.hash.startsWith('#ask')) render();
  }

  // 이번 달(한국 시간) 통계
  async function loadAskMonth() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const res = await Store.client.from('ask_questions').select('created_at, mode, verdict, input_tokens, output_tokens').gte('created_at', from);
    if (res.error) throw res.error;
    const today = UI.todayStr();
    ask.month = res.data.reduce((m, r) => {
      m.count += 1;
      if (Store.toLocalDate(new Date(r.created_at)) === today) m.today += 1;
      if (r.mode === 'check' && r.verdict === 'wrong') m.wrong += 1;
      m.cost += (r.input_tokens || 0) * ASK_PRICE_IN + (r.output_tokens || 0) * ASK_PRICE_OUT;
      return m;
    }, { count: 0, today: 0, wrong: 0, cost: 0 });
  }

  const ASK_VERDICT = { correct: ['정답', 'badge-success'], wrong: ['오답', 'badge-danger'], unclear: ['확인 어려움', 'badge-warn'] };
  function askBadges(r) {
    const v = r.mode === 'check' && ASK_VERDICT[r.verdict];
    return `<span class="badge ${r.mode === 'check' ? 'badge-warn' : 'badge-primary'}">${r.mode === 'check' ? '풀이 첨삭' : '풀이 요청'}</span>`
      + (v ? `<span class="badge ${v[1]}">${v[0]}</span>` : '');
  }
  const askWho = (r) => (r.student_id ? esc(studentName(r.student_id)) : '<span class="muted">비로그인</span>');
  const askPreview = (r) => UI.answerPreview(r.answer);

  function askCard(r) {
    const imgs = r.images || [];
    return `
      <a class="card ask-card" href="#ask/${r.id}">
        <div class="ask-thumbs">
          ${imgs.length ? imgs.slice(0, 4).map((im) => `<div class="ask-thumb ${im.kind}"><img data-file-id="${esc(im.path)}" alt=""></div>`).join('')
            : '<div class="ask-thumb none">사진 없음</div>'}
        </div>
        <div class="row wrap" style="gap:6px">${askBadges(r)}</div>
        <div class="ask-meta"><b>${askWho(r)}</b><span class="muted small">${UI.fmtDateTime(r.created_at)}</span></div>
        ${r.note ? `<p class="ask-note">💬 ${esc(r.note)}</p>` : ''}
        <p class="ask-preview muted small">${esc(askPreview(r))}</p>
      </a>`;
  }

  // 풀이 글: 마크다운 + 수식(KaTeX)
  const renderAnswer = (src) => UI.renderMd(UI.stripVerdict(src));

  async function askDetail(id) {
    let r = ask.rows.find((x) => x.id === id);
    if (!r) {
      $view.innerHTML = '<div class="empty">불러오는 중...</div>';
      const res = await Store.client.from('ask_questions').select('*').eq('id', id).maybeSingle();
      if (res.error || !res.data) { $view.innerHTML = '<div class="empty">질문을 찾을 수 없어요</div>'; return; }
      r = { ...res.data, images: Array.isArray(res.data.images) ? res.data.images : [] };
    }
    $title.innerHTML = `<a class="crumb" href="#ask">‹ 질문노트</a>${r.mode === 'check' ? '풀이 첨삭' : '풀이 요청'} · ${UI.fmtDateTime(r.created_at)}`;
    const group = (kind, label) => {
      const list = r.images.filter((im) => im.kind === kind);
      if (!list.length) return '';
      return `<div class="card-title">${label}</div>
        <div class="thumbs ask-big">${list.map((im, i) => `
          <button type="button" class="thumb" data-view="${esc(im.path)}" data-name="${esc(label)} ${i + 1}" title="크게 보기">
            <img data-file-id="${esc(im.path)}" alt="${esc(label)} ${i + 1}">
          </button>`).join('')}</div>`;
    };
    const cost = (r.input_tokens || 0) * ASK_PRICE_IN + (r.output_tokens || 0) * ASK_PRICE_OUT;
    $view.innerHTML = `
      <div class="ask-detail">
        <section class="card stack">
          <div class="row wrap" style="gap:6px">${askBadges(r)}</div>
          <div class="ask-meta"><b>${askWho(r)}</b><span class="muted small">${UI.fmtDateTime(r.created_at)}</span></div>
          ${r.note ? `<div class="feedback-box"><strong>학생 메모</strong>${nl2br(r.note)}</div>` : ''}
          ${group('problem', '문제 사진')}
          ${group('work', '학생 풀이 사진')}
          ${r.images.length ? '' : '<p class="muted small">사진이 저장되지 않은 질문이에요. (사진 보관 기능 이전에 들어온 질문)</p>'}
          <p class="muted small">사진을 누르면 크게 볼 수 있어요.</p>
          <p class="muted small">비용 약 $${cost.toFixed(3)} · 입력 ${(r.input_tokens || 0).toLocaleString()} / 출력 ${(r.output_tokens || 0).toLocaleString()} 토큰 · ${r.duration_ms ? Math.round(r.duration_ms / 1000) + '초' : ''}</p>
          <div class="row"><button class="btn btn-sm" id="askCopy">📋 답변 복사</button><button class="btn btn-sm btn-danger" id="askDelete">삭제</button></div>
        </section>
        <section class="card ask-answer ${r.mode === 'check' ? esc(r.verdict || '') : ''}">${renderAnswer(r.answer)}</section>
      </div>`;
    UI.hydrateImages($view);
    document.getElementById('askCopy').onclick = async () => {
      UI.toast((await UI.copyText(String(r.answer || '').replace(/^\s*판정:[^\n]*\n?/, ''))) ? '답변을 복사했어요.' : '복사에 실패했어요.', 'ok');
    };
    document.getElementById('askDelete').onclick = (e) => UI.busy(e.currentTarget, async () => {
      if (!confirm('이 질문과 사진을 삭제할까요? 되돌릴 수 없어요.')) return;
      await FileDB.remove(r.images.map((im) => im.path));
      const res = await Store.client.from('ask_questions').delete().eq('id', r.id);
      if (res.error) throw res.error;
      ask.rows = ask.rows.filter((x) => x.id !== r.id);
      UI.toast('삭제했어요.');
      location.hash = '#ask';
    });
  }

  /* ---------- 학부모 리포트: 설정 + 문구 만들기 ---------- */
  function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return Store.toLocalDate(d); }
  const rep = {
    className: '', from: daysAgo(30), to: UI.todayStr(), hw: true, scores: true, fb: true,
    closing: (() => { try { return localStorage.getItem('lms_report_closing'); } catch (e) { return null; } })()
      || '궁금하신 점은 언제든 연락 주세요. 감사합니다.',
  };
  const md = (v) => `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}`;
  const CHANNEL = { sms: '문자', copy: '복사', app: '앱' };
  const lastText = (l) => (l
    ? `최근 발송 ${UI.fmtDateTime(l.createdAt)} (${CHANNEL[l.channel] || l.channel}${l.channel === 'app' ? (l.readAt ? ' · 읽음 ✓' : ' · 안 읽음') : ''})`
    : '발송 기록 없음');
  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();

  function buildReport(s) {
    const L = [`[${Store.settings().academyName}] ${s.name} 학생 학습 리포트`, `기간: ${md(rep.from)} ~ ${md(rep.to)}`];
    const inRange = (d) => d >= rep.from && d <= rep.to;

    if (rep.hw) {
      const hw = Store.where('assignments', (a) => Store.targets(a, s.classNames) && inRange(a.dueDate))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const done = hw.filter((a) => Store.submissionOf(a.id, s.id)).length;
      L.push('', `■ 숙제 (${hw.length}개 중 ${done}개 제출)`);
      if (!hw.length) L.push('- 해당 기간 숙제가 없습니다.');
      for (const a of hw) {
        const sub = Store.submissionOf(a.id, s.id);
        const status = sub
          ? (UI.isLate(a.dueDate, sub.submittedAt) ? '지각 제출' : '제출 완료')
          : (UI.isOverdue(a.dueDate) ? '미제출' : `진행 중 (마감 ${md(a.dueDate)})`);
        L.push(`- ${a.title}: ${status}`);
        if (rep.fb && sub?.feedback) L.push(`  └ ${oneLine(sub.feedback)}`);
      }
    }

    if (rep.scores) {
      // 여러 반을 듣는 학생은 반별로 나눠서 적음
      const multi = s.classNames.length > 1;
      for (const c of s.classNames) {
        const tests = Store.where('tests', (t) => t.className === c && inRange(t.date))
          .sort((a, b) => a.date.localeCompare(b.date));
        L.push('', multi ? `■ 테스트 성적 · ${c}` : '■ 테스트 성적');
        if (!tests.length) L.push('- 해당 기간 테스트가 없습니다.');
        for (const t of tests) {
          const sc = Store.scoreOf(t.id, s.id);
          const st = Store.testStats(t.id);
          if (!hasScore(sc)) { L.push(`- ${t.title} (${md(t.date)}): 점수 없음`); continue; }
          L.push(`- ${t.title} (${md(t.date)}): ${sc.score}점 / ${t.maxScore}점${st.avg !== null ? ` (반 평균 ${st.avg}점)` : ''}`);
          if (rep.fb && sc.feedback) L.push(`  └ ${oneLine(sc.feedback)}`);
        }
      }
    }

    if (rep.closing.trim()) L.push('', rep.closing.trim());
    return L.join('\n');
  }

  /* ---------- 학생 정보 수정 ---------- */
  function studentEdit(id) {
    const s = Store.get('students', id);
    if (!s) { location.hash = '#students'; return; }
    $title.innerHTML = `<a class="crumb" href="#students">‹ 학생 관리</a>${esc(s.name)} 정보 수정`;
    $view.innerHTML = `
      <form class="card stack" id="stuEdit" style="max-width:720px">
        <div class="form-grid">
          <label class="field"><span>이름</span><input type="text" name="name" required value="${esc(s.name)}"></label>
          <label class="field"><span>학교</span><input type="text" name="school" value="${esc(s.school)}"></label>
          <label class="field"><span>로그인 아이디</span><input type="text" value="${esc(s.loginId)}" disabled></label>
          <label class="field"><span>학부모 연락처</span><input type="tel" name="parentPhone" inputmode="tel" placeholder="010-1234-5678" value="${esc(UI.fmtPhone(s.parentPhone))}"></label>
          ${classPicker(s.classNames)}
        </div>
        <p class="muted small">반에서 빼도 그 반에서 받은 점수는 지워지지 않아요. 다시 넣으면 그대로 보여요. 학생이 한 명도 없는 반은 반 목록에서 사라져요.</p>
        <div class="form-actions"><a class="btn" href="#students">취소</a><button class="btn btn-primary">저장</button></div>
      </form>
      ${parentSection(s)}`;
    onSubmit(document.getElementById('stuEdit'), async (f) => {
      const classNames = readClasses(f);
      await Store.update('students', s.id, {
        name: f.name.value.trim(), school: f.school.value.trim(), className: classNames[0], classNames,
        parentPhone: UI.phoneDigits(f.parentPhone.value),
      });
      UI.toast('저장했습니다.');
      history.back();
    }, '저장 중...');
    bindParentSection(s);
  }

  /* ---------- 학생 수정 화면: 학부모 앱 계정 ---------- */
  let justCreated = null; // 방금 만든 학부모 계정 (안내 문구에 비밀번호를 넣기 위해 화면에만 잠깐 보관)
  // 기본 비밀번호 = 학부모 연락처 뒤 8자리. 다른 비밀번호로 만들거나 바꾼 계정은 이 브라우저에 표시해 둠
  const defaultParentPw = (s) => UI.phoneDigits(s.parentPhone).slice(-8);
  const PW_CUSTOM_KEY = 'lms_parent_pw_custom';
  const pwCustom = () => { try { return JSON.parse(localStorage.getItem(PW_CUSTOM_KEY)) || {}; } catch (e) { return {}; } };
  const markPw = (parentId, s, pw) => {
    const m = pwCustom();
    if (pw === defaultParentPw(s)) delete m[parentId]; else m[parentId] = true;
    try { localStorage.setItem(PW_CUSTOM_KEY, JSON.stringify(m)); } catch (e) { /* 무시 */ }
  };
  const guidePw = (p, s) => {
    if (justCreated?.id === p.id) return justCreated.pw;
    const d = defaultParentPw(s);
    return !pwCustom()[p.id] && d.length >= 6 ? d : '';
  };
  const appUrl = () => new URL('student.html', location.href).href.replace(/student\.html$/, '');
  function parentGuide(s, loginId, pw) {
    return [
      `[${Store.settings().academyName}] ${s.name} 학생 학부모님 앱 안내`,
      '',
      `아래 주소에서 [학부모] 탭을 눌러 로그인하시면 숙제 제출 현황, 성적, 학습 리포트를 보실 수 있습니다.`,
      `주소: ${appUrl()}`,
      `아이디: ${loginId}`,
      `비밀번호: ${pw || '(따로 안내드린 비밀번호)'}`,
      '',
      '로그인 화면의 [바로가기 아이콘 만들기]를 누르면 휴대폰 홈 화면에 앱 아이콘이 생깁니다.',
    ].join('\n');
  }
  function parentSection(s) {
    const linked = Store.parentsOf(s.id);
    const taken = (id) => Store.all('parents').some((p) => p.loginId === id);
    let suggestId = `${s.loginId}_p`;
    for (let n = 2; taken(suggestId); n += 1) suggestId = `${s.loginId}_p${n}`;
    const suggestPw = UI.phoneDigits(s.parentPhone).slice(-8);
    return `
      <section class="card stack" style="max-width:720px" id="parentBox">
        <div class="card-title">👪 학부모 앱 계정 <span class="muted small" style="font-weight:500">학부모님은 숙제 제출 여부·성적·리포트만 볼 수 있어요</span></div>
        ${linked.length ? `<div class="stack">${linked.map((p) => {
          const kids = Store.childrenOf(p.id).filter((k) => k.id !== s.id).map((k) => k.name);
          const guide = parentGuide(s, p.loginId, guidePw(p, s));
          return `
          <div class="sub-card" style="border:1px solid var(--line);border-radius:12px;padding:12px">
            <div class="row between wrap">
              <span><b>${esc(p.loginId)}</b> ${p.name ? `<span class="muted small">${esc(p.name)}</span>` : ''}${kids.length ? ` <span class="badge">형제: ${esc(kids.join(', '))}</span>` : ''}</span>
              <span class="row wrap">
                <button type="button" class="btn btn-sm" data-ppw="${p.id}">비밀번호 변경</button>
                <button type="button" class="btn btn-sm" data-unlink="${p.id}">연결 해제</button>
                <button type="button" class="btn btn-sm btn-danger" data-pdel="${p.id}">계정 삭제</button>
              </span>
            </div>
            <textarea class="report-text" rows="7" data-guide="${p.id}" style="margin-top:8px">${esc(guide)}</textarea>
            <div class="row" style="justify-content:flex-end;margin-top:6px">
              <button type="button" class="btn btn-sm" data-gcopy="${p.id}">📋 안내 문구 복사</button>
              ${s.parentPhone ? `<a class="btn btn-sm btn-primary" data-gsms="${p.id}" href="#">💬 문자로 보내기</a>` : ''}
            </div>
          </div>`;
        }).join('')}</div>` : '<p class="muted small">아직 학부모 계정이 없어요.</p>'}
        <details ${linked.length ? '' : 'open'}>
          <summary class="small" style="cursor:pointer;font-weight:700">＋ 새 학부모 계정 만들기</summary>
          <form id="parentForm" class="stack" style="margin-top:10px">
            <div class="form-grid">
              <label class="field"><span>학부모 아이디 (영문·숫자)</span><input type="text" name="loginId" required pattern="[A-Za-z0-9._\\-]{3,30}" title="영문, 숫자 3~30자" autocapitalize="off" value="${esc(suggestId)}"></label>
              <label class="field"><span>비밀번호 (6자 이상)</span><input type="text" name="password" required minlength="6" autocomplete="off" value="${esc(suggestPw)}" placeholder="예) 휴대폰 번호 뒤 8자리"></label>
              <label class="field span-2"><span>호칭 (선택)</span><input type="text" name="name" placeholder="예) 어머니, 아버지"></label>
            </div>
            <div class="form-actions"><button class="btn btn-primary">학부모 계정 만들기</button></div>
          </form>
        </details>
        <details>
          <summary class="small" style="cursor:pointer;font-weight:700">🔗 형제·자매의 학부모 계정에 연결하기</summary>
          <form id="linkForm" class="row wrap" style="margin-top:10px">
            <input type="text" name="loginId" required placeholder="이미 있는 학부모 아이디" autocapitalize="off" list="parentIds" style="flex:1;min-width:180px">
            <datalist id="parentIds">${Store.all('parents').filter((p) => !linked.includes(p)).map((p) => `<option value="${esc(p.loginId)}">`).join('')}</datalist>
            <button class="btn">연결</button>
          </form>
        </details>
      </section>`;
  }
  function bindParentSection(s) {
    const box = document.getElementById('parentBox');
    if (!box) return;
    const pName = (id) => Store.get('parents', id)?.loginId || '';
    onSubmit(document.getElementById('parentForm'), async (f) => {
      const loginId = f.loginId.value.trim().toLowerCase();
      await Store.createParent({ loginId, password: f.password.value, name: f.name.value.trim(), studentId: s.id });
      const p = Store.all('parents').find((x) => x.loginId === loginId);
      if (p) { justCreated = { id: p.id, pw: f.password.value }; markPw(p.id, s, f.password.value); }
      UI.toast('학부모 계정을 만들었어요. 안내 문구를 보내 주세요.');
    }, '만드는 중...');
    onSubmit(document.getElementById('linkForm'), async (f) => {
      await Store.linkParent(f.loginId.value, s.id);
      UI.toast('연결했어요.');
    }, '연결 중...');
    const btns = (sel, fn) => box.querySelectorAll(sel).forEach((b) => {
      b.onclick = () => UI.busy(b, async () => { if ((await fn(b)) !== false) render(); });
    });
    btns('[data-ppw]', async (b) => {
      const pw = prompt(`학부모 계정(${pName(b.dataset.ppw)})의 새 비밀번호 (6자 이상)`);
      if (pw === null) return false;
      if (pw.length < 6) { UI.toast('비밀번호는 6자 이상이어야 해요.', 'error'); return false; }
      await Store.setParentPassword(b.dataset.ppw, pw);
      justCreated = { id: b.dataset.ppw, pw };
      markPw(b.dataset.ppw, s, pw);
      UI.toast('비밀번호를 변경했어요.');
    });
    btns('[data-unlink]', async (b) => {
      if (!confirm(`학부모 계정(${pName(b.dataset.unlink)})과 ${s.name} 학생의 연결을 끊을까요?\n계정은 남아 있어요.`)) return false;
      await Store.unlinkParent(b.dataset.unlink, s.id);
      UI.toast('연결을 해제했어요.');
    });
    btns('[data-pdel]', async (b) => {
      if (!confirm(`학부모 계정(${pName(b.dataset.pdel)})을 삭제할까요?\n연결된 모든 자녀와의 연결도 사라지고 되돌릴 수 없어요.`)) return false;
      await Store.deleteParent(b.dataset.pdel);
      UI.toast('삭제했어요.');
    });
    const guideOf = (id) => box.querySelector(`[data-guide="${id}"]`).value;
    box.querySelectorAll('[data-gcopy]').forEach((b) => b.onclick = async () => {
      const ok = await UI.copyText(guideOf(b.dataset.gcopy));
      UI.toast(ok ? '복사했어요. 카카오톡 등에 붙여넣으세요.' : '복사에 실패했어요.', ok ? 'ok' : 'error');
    });
    box.querySelectorAll('[data-gsms]').forEach((a) => a.onclick = () => { a.href = UI.smsHref(s.parentPhone, guideOf(a.dataset.gsms)); });
  }

  function statusBadge(s, a) {
    const late = a && UI.isLate(a.dueDate, s.submittedAt) ? ' <span class="badge badge-warn">지각</span>' : '';
    return (s.status === 'checked' ? '<span class="badge badge-success">확인완료</span>' : '<span class="badge badge-danger">확인 대기</span>') + late;
  }

  /* ---------- 숙제 상세: 학생별 제출물 확인 + 피드백 ---------- */
  let hwFilter = 'all';
  function homeworkDetail(id) {
    const a = Store.get('assignments', id);
    if (!a) { location.hash = '#homework'; return; }
    $title.innerHTML = `<a class="crumb" href="#homework">‹ 숙제 관리</a>${esc(a.title)}`;

    const rows = Store.studentsFor(a.className).map((st) => ({ st, sub: Store.submissionOf(a.id, st.id) }));
    const counts = {
      all: rows.length,
      pending: rows.filter((r) => r.sub?.status === 'submitted').length,
      checked: rows.filter((r) => r.sub?.status === 'checked').length,
      none: rows.filter((r) => !r.sub).length,
    };
    const filtered = rows.filter((r) => hwFilter === 'all'
      || (hwFilter === 'pending' && r.sub?.status === 'submitted')
      || (hwFilter === 'checked' && r.sub?.status === 'checked')
      || (hwFilter === 'none' && !r.sub));
    const chip = (k, label) => `<button class="chip ${hwFilter === k ? 'active' : ''}" data-filter="${k}">${label} ${counts[k]}</button>`;
    const totalFiles = rows.reduce((n, r) => n + (r.sub?.files?.length || 0), 0);

    $view.innerHTML = `
      <section class="card">
        <div class="row wrap" style="gap:12px">
          <span class="badge">${esc(a.className)}</span>
          <span>마감 <b>${UI.fmtDate(a.dueDate)}</b></span>
          ${UI.isOverdue(a.dueDate) ? '<span class="badge">마감됨</span>' : `<span class="badge badge-warn">${UI.dday(a.dueDate)}</span>`}
        </div>
        ${a.description ? `<p class="muted" style="margin-top:10px">${nl2br(a.description)}</p>` : ''}
      </section>
      <div class="row between wrap">
        <div class="filter-bar">${chip('all', '전체')}${chip('pending', '확인 대기')}${chip('checked', '확인완료')}${chip('none', '미제출')}</div>
        ${totalFiles ? `<button class="btn btn-sm" id="zipAll">📥 제출물 전체 다운로드 (ZIP · ${totalFiles}개)</button>` : ''}
      </div>
      <div class="sub-grid">
        ${filtered.map(({ st, sub }) => sub ? `
          <div class="card sub-card">
            <div class="row between"><span class="who">${esc(st.name)}</span>${statusBadge(sub, a)}</div>
            <div class="row between">
              <span class="muted small">${UI.fmtDateTime(sub.submittedAt)} 제출 · 파일 ${sub.files?.length || 0}개</span>
              ${sub.files?.length ? `<button class="btn btn-sm" data-zip="${sub.id}">📥 ${sub.files.length > 1 ? '전체 받기' : '받기'}</button>` : ''}
            </div>
            <div>${UI.fileList(sub.files)}</div>
            ${sub.note ? `<p class="small" style="background:var(--surface-2);padding:8px 10px;border-radius:8px">💬 ${esc(sub.note)}</p>` : ''}
            <textarea placeholder="피드백 입력 (학생 앱에 표시됩니다)" data-fb="${sub.id}">${esc(sub.feedback || '')}</textarea>
            <div class="row" style="justify-content:flex-end">
              ${sub.status === 'checked' ? `<button class="btn btn-sm" data-uncheck="${sub.id}">확인 취소</button>` : ''}
              <button class="btn btn-sm btn-primary" data-check="${sub.id}">${sub.status === 'checked' ? '피드백 수정' : '✓ 확인 완료'}</button>
            </div>
          </div>` : `
          <div class="card sub-card none">
            <div class="row between"><span class="who">${esc(st.name)}</span><span class="badge">미제출</span></div>
            <p class="muted small">${esc(st.school)} · 아직 제출하지 않았습니다.</p>
          </div>`).join('') || '<div class="empty">해당하는 학생이 없습니다</div>'}
      </div>`;

    $view.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => { hwFilter = b.dataset.filter; render(); });

    // 학생 한 명의 제출 파일 받기 (1개면 그대로, 여러 개면 ZIP)
    $view.querySelectorAll('[data-zip]').forEach((b) => b.onclick = () => {
      const sub = Store.get('submissions', b.dataset.zip);
      const name = studentName(sub.studentId);
      if (sub.files.length === 1) return UI.download(sub.files[0].fileId, UI.zipEntries(name, sub.files)[0].path);
      UI.busy(b, () => UI.downloadZip(`${a.title}_${name}`, UI.zipEntries(name, sub.files),
        (d, n) => { b.textContent = `압축 중 ${d}/${n}`; }), '준비 중...');
    });
    // 숙제 전체 제출물 ZIP (학생별 폴더)
    const zipAll = document.getElementById('zipAll');
    if (zipAll) zipAll.onclick = () => {
      const dup = (n) => rows.filter((r) => r.st.name === n).length > 1; // 동명이인은 아이디를 붙여 구분
      const entries = rows.filter((r) => r.sub?.files?.length).flatMap((r) => {
        const label = dup(r.st.name) ? `${r.st.name}_${r.st.loginId}` : r.st.name;
        return UI.zipEntries(label, r.sub.files, label);
      });
      UI.busy(zipAll, () => UI.downloadZip(`${a.title}_제출물_${UI.todayStr()}`, entries,
        (d, n) => { zipAll.textContent = `압축 중 ${d}/${n}`; }), '준비 중...');
    };
    onClick('[data-check]', async (b) => {
      const fb = $view.querySelector(`[data-fb="${b.dataset.check}"]`).value.trim();
      await Store.update('submissions', b.dataset.check, { status: 'checked', feedback: fb, checkedAt: Store.nowISO() });
      UI.toast('확인 완료! 학생에게 피드백이 전달됩니다.');
    });
    onClick('[data-uncheck]', async (b) => {
      await Store.update('submissions', b.dataset.uncheck, { status: 'submitted' });
    });
  }

  /* ---------- 성적 + 피드백 입력 ---------- */
  let scoreClass = 'all'; // 성적 관리 목록의 반 필터
  function scoreEntry(id) {
    const t = Store.get('tests', id);
    if (!t) { location.hash = '#scores'; return; }
    $title.innerHTML = `<a class="crumb" href="#scores">‹ 성적 관리</a>${esc(t.title)}`;
    const students = Store.studentsFor(t.className);
    const st = Store.testStats(t.id);

    $view.innerHTML = `
      <section class="card row between wrap">
        <div class="summary-row">
          <div><b>${esc(t.className)}</b><span>응시 반</span></div>
          <div><b>${UI.fmtDate(t.date)}</b><span>시험일</span></div>
          <div><b>${t.maxScore}</b><span>만점</span></div>
          <div><b>${st.avg ?? '-'}</b><span>평균</span></div>
          <div><b>${st.max ?? '-'} / ${st.min ?? '-'}</b><span>최고 / 최저</span></div>
        </div>
      </section>
      <form id="scoreForm">
        <div class="table-wrap"><table>
          <thead><tr><th style="width:140px">학생</th><th style="width:120px">점수</th><th>피드백 (학생 앱에 표시)</th></tr></thead>
          <tbody>${students.map((s) => {
            const sc = Store.scoreOf(t.id, s.id);
            return `<tr>
              <td><b>${esc(s.name)}</b><div class="muted small">${esc(s.school)}</div></td>
              <td><input type="number" class="score-input" name="score_${s.id}" min="0" max="${t.maxScore}" step="0.5" value="${hasScore(sc) ? sc.score : ''}" placeholder="-"></td>
              <td><textarea class="fb-input" name="fb_${s.id}" rows="1" placeholder="예) 계산 실수 주의! 서술형 풀이 좋아요">${esc(sc?.feedback || '')}</textarea></td>
            </tr>`;
          }).join('') || '<tr><td colspan="3" class="empty">이 반에 학생이 없습니다</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions" style="margin-top:14px">
          <a class="btn" href="#scores">목록으로</a>
          <button class="btn btn-primary">💾 전체 저장</button>
        </div>
      </form>`;

    // Enter 키로 다음 학생 점수칸 이동
    const inputs = [...$view.querySelectorAll('.score-input')];
    inputs.forEach((inp, i) => inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); (inputs[i + 1] || inp).focus(); inputs[i + 1]?.select(); }
    }));

    onSubmit(document.getElementById('scoreForm'), async (f) => {
      const rows = students.map((s) => {
        const raw = f[`score_${s.id}`].value;
        return { studentId: s.id, name: s.name, score: raw === '' ? null : Number(raw), feedback: f[`fb_${s.id}`].value.trim() };
      });
      const bad = rows.find((r) => r.score !== null && (r.score < 0 || r.score > t.maxScore));
      if (bad) throw new Error(`${bad.name}: 점수는 0~${t.maxScore} 사이여야 합니다.`);
      await Store.saveScores(t.id, rows);
      UI.toast('성적과 피드백을 저장했습니다.');
    }, '저장 중...');
  }

  /* ---------- 시작 ---------- */
  document.getElementById('logoutBtn').onclick = async () => { await Store.signOut(); render(); };
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#homework/')) hwFilter = 'all'; render(); window.scrollTo(0, 0); });
  UI.bindDownloads(document);
  // 학생이 숙제를 제출하면 자동 반영 (입력 중일 때는 건너뜀)
  Store.onChange(() => {
    const ae = document.activeElement;
    if (ae && ae !== document.body && $view.contains(ae)) return;
    render();
  });

  (async function boot() {
    if (!Store.client) {
      document.querySelector('.layout').classList.add('hidden');
      const box = document.createElement('div'); box.innerHTML = UI.setupNotice(); document.body.appendChild(box);
      return;
    }
    try { await Store.init(); }
    catch (e) { console.error(e); UI.toast(UI.errMsg(e), 'error'); }
    render();
  })();
})();
