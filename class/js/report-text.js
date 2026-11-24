/* ============================================================
 * 학부모 리포트 문구 만들기 (관리자 웹)
 *  - 주간: 지난주 테스트·숙제(선택한 것만) + 단원별 취약 부분 → 상담하는 말투
 *  - 월간: 그 달 숙제 제출 여부 + 테스트 성적
 *  - 같은 문구가 반복되지 않도록 문장마다 여러 표현을 두고 "주마다" 돌려 씀
 *    (주 번호 + 학생 + 문장 자리로 고르므로 이번 주와 지난주는 항상 다른 표현,
 *     [🔄 다른 문구]를 누르면 shuffle 이 1 늘어 다른 조합이 됨)
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 한국어 도우미 ---------- */
  // 마지막 글자에 받침이 있는지 (숫자·영문도 대략 처리)
  function hasJong(word) {
    const w = String(word || '').replace(/[\s)\]'"]+$/, '');
    if (!w) return false;
    const c = w.charCodeAt(w.length - 1);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
    return /[013678lmnr]$/i.test(w);
  }
  // J('민준이', '는') → 민준이는 · J('수열', '가') → 수열이
  const PAIRS = { 은: ['은', '는'], 는: ['은', '는'], 이: ['이', '가'], 가: ['이', '가'], 을: ['을', '를'], 를: ['을', '를'], 과: ['과', '와'], 와: ['과', '와'] };
  const J = (w, p) => w + (PAIRS[p] ? PAIRS[p][hasJong(w) ? 0 : 1] : p);
  // 부르는 이름: 김민준 → 민준이, 이서아 → 서아
  function nick(name) {
    const n = String(name || '').trim();
    const given = n.length >= 3 ? n.slice(1) : n;
    return hasJong(given) ? given + '이' : given;
  }
  const md = (v) => `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}`;
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const mdw = (v) => `${md(v)} ${WEEK[new Date(v + "T00:00:00").getDay()]}`;
  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
  const endDot = (s) => { const t = oneLine(s); return !t || /[.!?…。~요다]$/.test(t) ? t : t + '.'; };
  const hasScore = (s) => s && s.score !== null && s.score !== undefined;
  // 테스트 시험 범위 단원 이름 (없으면 빈 글자)
  const range = (t) => Store.testUnits(t).map((u) => u.title).join(", ");
  const r1 = (x) => Math.round(x * 10) / 10;

  // 문자열 해시 (문장 자리마다 시작점을 다르게)
  function hash(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function picker(seed, key) {
    return (slot, pool) => {
      const list = pool.filter((x) => x !== null && x !== undefined);
      if (!list.length) return '';
      const v = list[(seed + hash(key + '|' + slot)) % list.length];
      return typeof v === 'function' ? v() : v;
    };
  }
  const dayIndex = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000);

  /* ---------- 기간 ---------- */
  // 그 날짜가 속한 주의 월요일
  function mondayOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return Store.toLocalDate(d);
  }
  function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return Store.toLocalDate(d); }
  // 보내는 주의 전주 (월~일)
  function lastWeek(today = UI.todayStr()) { const from = addDays(mondayOf(today), -7); return { from, to: addDays(from, 6) }; }
  // 11월 3주차 (목요일이 속한 달 기준)
  function weekLabel(from) {
    const th = addDays(from, 3);
    return `${Number(th.slice(5, 7))}월 ${Math.ceil(Number(th.slice(8, 10)) / 7)}주차`;
  }
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
  }
  function defaultMonth(today = UI.todayStr()) {
    // 10일까지는 지난달 리포트, 그 뒤로는 이번 달
    const d = new Date(today + 'T00:00:00');
    if (d.getDate() <= 10) d.setMonth(d.getMonth() - 1, 1);
    return Store.toLocalDate(d).slice(0, 7);
  }

  /* ---------- 데이터 모으기 ---------- */
  function testRow(t, s) {
    const sc = Store.scoreOf(t.id, s.id);
    const st = Store.testStats(t.id);
    // 같은 반 직전 테스트 (점수 있는 것)
    const prevT = Store.where('tests', (x) => x.className === t.className && x.date < t.date && hasScore(Store.scoreOf(x.id, s.id)))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    return { id: 't:' + t.id, t, sc, st, prev: prevT ? { t: prevT, sc: Store.scoreOf(prevT.id, s.id) } : null };
  }
  function hwRow(a, s) {
    const sub = Store.submissionOf(a.id, s.id);
    const state = sub ? (UI.isLate(a.dueDate, sub.submittedAt) ? 'late' : 'done') : (UI.isOverdue(a.dueDate) ? 'missing' : 'pending');
    return { id: 'h:' + a.id, a, sub, state };
  }
  // 리포트에 넣을 수 있는 항목들
  function items(s, from, to) {
    const inRange = (d) => d >= from && d <= to;
    const tests = Store.where('tests', (t) => s.classNames.includes(t.className) && inRange(t.date))
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)).map((t) => testRow(t, s));
    const hw = Store.where('assignments', (a) => Store.targets(a, s.classNames) && inRange(a.dueDate))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((a) => hwRow(a, s));
    const order = { weak: 0, improving: 1, resolved: 2 };
    const weakAll = Store.weakOf(s.id).map((w) => ({ w, unit: Store.get('units', w.unitId) })).filter((x) => x.unit)
      .map((x) => ({ ...x, id: 'w:' + x.w.id }))
      .sort((a, b) => order[a.w.level] - order[b.w.level] || a.unit.subject.localeCompare(b.unit.subject) || a.unit.seq - b.unit.seq);
    // '해결'은 최근(기간 시작 7일 전 ~ 지금)에 해결로 바꾼 것만 칭찬으로 넣음
    const since = addDays(from, -7);
    const weak = weakAll.filter((x) => x.w.level !== 'resolved' || (x.w.updatedAt || x.w.createdAt || '').slice(0, 10) >= since);
    return { tests, hw, weak };
  }

  /* ---------- 문장 모음 ---------- */
  function seasonPool(today) {
    const m = Number(today.slice(5, 7));
    if (m === 12) return ['날씨가 많이 추워졌습니다.', '어느덧 한 해를 마무리하는 시기가 되었네요.', '추운 날씨에 감기 조심하세요.'];
    if (m === 1) return ['새해 복 많이 받으세요.', '추운 날씨가 이어지고 있습니다.', '방학을 알차게 보내는 것이 중요한 시기입니다.'];
    if (m === 2) return ['새 학기를 준비하는 시기입니다.', '아직 날씨가 많이 춥습니다.'];
    if (m === 3) return ['새 학기 적응으로 바쁜 시기입니다.', '새 학기가 시작되었네요.'];
    if (m <= 5) return ['날씨가 많이 따뜻해졌습니다.', '환절기 건강 유의하세요.'];
    if (m <= 8) return ['날씨가 많이 더워졌습니다.', '무더운 날씨에 건강 유의하세요.'];
    if (m <= 10) return ['선선한 날씨가 이어지고 있습니다.', '환절기 건강 유의하세요.'];
    return ['아침저녁으로 날이 많이 쌀쌀해졌습니다.', '어느덧 한 해의 마무리가 다가오고 있네요.'];
  }

  // 점수 한 줄 + 해설 한 문장
  function scoreParts(x, N, P, withTrend) {
    const { t, sc, st, prev } = x;
    const title = t.title;
    if (!hasScore(sc)) {
      return {
        line: `- ${title} (${mdw(t.date)}): 미응시`,
        talk: P('absent' + t.id, [
          `${J(title, '는')} 응시하지 못해서, 다음 수업 때 따로 보고 결과를 알려 드리겠습니다.`,
          `${J(title, '은')} 결시해서 점수가 없습니다. 보충 시간에 같은 범위로 다시 확인하겠습니다.`,
          `${title} 날에는 함께하지 못해, 해당 범위는 따로 점검하도록 하겠습니다.`,
        ]),
      };
    }
    const score = sc.score, max = Number(t.maxScore) || 100;
    const scoreTxt = max === 100 ? `${score}점` : `${score}점(${max}점 만점)`;
    const avg = st.avg;
    const pct = (score / max) * 100;
    const diff = avg !== null ? r1(score - avg) : null;
    const dPct = avg !== null ? (diff / max) * 100 : null;
    const cat = avg === null ? (pct >= 90 ? 'top' : pct >= 70 ? 'mid' : 'low')
      : pct >= 95 || (dPct >= 10 && pct >= 85) ? 'top' : dPct >= 3 ? 'good' : dPct > -3 ? 'mid' : 'low';
    const A = avg !== null ? `${avg}점` : '';
    const pools = {
      top: [
        `${J(title, '에서')} ${scoreTxt}을 받았습니다. 이번 범위는 개념과 문제 적용 모두 잘 정리되어 있다고 보셔도 좋겠습니다.`,
        `${J(N, '는')} 이번 ${J(title, '에서')} ${J(scoreTxt, '으로')} 아주 좋은 결과를 냈습니다. 수업에 집중한 것이 점수로 잘 드러났어요.`,
        `${title} 결과는 ${scoreTxt}입니다. 끝까지 꼼꼼하게 풀어낸 점을 많이 칭찬해 주고 싶습니다.`,
        `이번 ${J(title, '에서')} ${scoreTxt}을 받았습니다. 반에서도 손꼽히는 점수로, 지금처럼만 해 주면 좋겠습니다.`,
      ],
      good: [
        `${J(title, '에서')} ${J(scoreTxt, '으로')} 반 평균(${A})보다 좋은 결과를 받았습니다.`,
        `${J(N, '는')} ${J(title, '에서')} ${scoreTxt}을 받아 반 평균보다 ${diff}점 높았습니다. 이번 범위의 기본기는 잘 갖춰져 있습니다.`,
        `이번 ${title} 점수는 ${J(scoreTxt, '으로')}, 반 평균 ${A}보다 앞선 결과입니다.`,
        `${J(title, '에서')} ${scoreTxt}을 받았습니다. 평균 이상으로 안정적인 결과라 지금 흐름을 잘 이어 가면 좋겠습니다.`,
      ],
      mid: [
        `${J(title, '에서')} ${scoreTxt}을 받았습니다.${A ? ` 반 평균(${A})과 비슷한 결과였습니다.` : ''}`,
        `이번 ${title} 점수는 ${scoreTxt}입니다. 기본 개념은 이해하고 있지만, 응용 문항에서 점수를 더 챙길 여지가 있습니다.`,
        `${J(N, '는')} ${J(title, '에서')} ${scoreTxt}을 받았습니다. 몇몇 부분만 보완하면 충분히 더 올라갈 수 있는 상태입니다.`,
        `${title} 결과는 ${J(scoreTxt, '으로')} ${A ? '반 평균과 큰 차이는 없었습니다' : '무난한 편이었습니다'}. 실수만 줄여도 점수가 더 오를 수 있습니다.`,
      ],
      low: [
        `${J(title, '에서')} ${scoreTxt}을 받아${A ? ` 반 평균(${A})보다는` : ''} 조금 아쉬운 결과였습니다.`,
        `이번 ${title} 점수는 ${J(scoreTxt, '으로')} ${A ? '평균에는 조금 못 미쳤습니다' : '아쉬움이 남는 결과였습니다'}. 틀린 문항을 함께 확인하며 원인을 짚어 보겠습니다.`,
        `${J(title, '에서')} ${scoreTxt}을 받았습니다. ${diff !== null ? `반 평균보다 ${-diff}점 낮은 결과라, ` : ''}이번 주에는 틀린 문항을 중심으로 다시 짚어 보겠습니다.`,
        `${J(N, '는')} 이번 ${J(title, '에서')} ${scoreTxt}을 받았습니다. 아직 이 범위가 완전히 손에 익지 않은 것으로 보여 수업에서 한 번 더 다지고 넘어가려고 합니다.`,
      ],
    };
    let talk = P('score-' + cat + t.id, pools[cat]);
    if (withTrend && prev && hasScore(prev.sc)) {
      const pMax = Number(prev.t.maxScore) || 100;
      const delta = pct - (prev.sc.score / pMax) * 100;
      const d = pMax === max ? r1(Math.abs(score - prev.sc.score)) : null;
      const dTxt = d !== null ? `${d}점` : '점수가';
      if (delta >= 5) talk += ' ' + P('up', [
        `지난 테스트보다 ${d !== null ? `${d}점 올라` : '점수가 올라'} 꾸준히 좋아지고 있는 모습입니다.`,
        `직전 테스트에 비해 ${dTxt} 올랐습니다. 노력한 만큼 결과가 나오고 있어요.`,
        `지난번보다 ${d !== null ? `${d}점이나` : '점수가'} 오른 점도 꼭 칭찬해 주세요.`,
      ]);
      else if (delta <= -5) talk += ' ' + P('down', [
        `지난 테스트보다는 ${d !== null ? `${d}점` : '점수가'} 내려갔는데, 범위가 바뀌면서 생긴 일시적인 흔들림일 수 있어 함께 지켜보겠습니다.`,
        `직전 테스트보다 ${d !== null ? `${d}점` : '조금'} 낮아져서, 이번 주에는 오답 위주로 다시 점검하겠습니다.`,
        `지난번보다 조금 내려간 점수라 어디서 흔들렸는지 같이 살펴보고 있습니다.`,
      ]);
      else talk += ' ' + P('steady', [
        '지난 테스트와 비슷한 점수로 꾸준함을 유지하고 있습니다.',
        '직전 테스트와 비슷한 수준을 잘 유지했습니다.',
        '',
      ]);
    }
    const line = `- ${title} (${mdw(t.date)}): ${score}점 / ${max}점${avg !== null ? ` · 반 평균 ${avg}점` : ''}`;
    return { line, talk: talk.trim(), feedback: oneLine(sc.feedback) };
  }

  function hwParts(rows, N, P, withFb) {
    const total = rows.length;
    const done = rows.filter((r) => r.state === 'done').length;
    const late = rows.filter((r) => r.state === 'late').length;
    const missing = rows.filter((r) => r.state === 'missing');
    const STATE = { done: '제출 완료', late: '지각 제출', missing: '미제출' };
    const lines = [];
    for (const r of rows) {
      lines.push(`- ${r.a.title} (마감 ${md(r.a.dueDate)}): ${STATE[r.state] || '진행 중'}`);
      if (withFb && r.sub?.feedback) lines.push(`  └ ${oneLine(r.sub.feedback)}`);
    }
    const titles = missing.slice(0, 2).map((r) => r.a.title).join(', ') + (missing.length > 2 ? ' 등' : '');
    let talk;
    if (!total) talk = '';
    else if (missing.length === total) talk = P('hw-none', [
      `지난주에는 숙제를 ${total > 1 ? '하나도 ' : ''}제출하지 못했습니다(${titles}). 숙제가 밀리지 않도록 수업 때 함께 확인하고, 이번 주 안에 마무리하도록 지도하겠습니다.`,
      `지난주 숙제(${titles})가 제출되지 않았습니다. 바쁜 일정이 있었는지 ${J(N, '와')} 이야기해 보고, 해 올 수 있는 분량과 시간을 함께 정해 보겠습니다.`,
      `숙제 제출이 없어 조금 걱정됩니다(${titles}). 가정에서도 한 번 챙겨 봐 주시면, 학원에서도 끝까지 마무리할 수 있도록 확인하겠습니다.`,
    ]);
    else if (missing.length) talk = P('hw-missing', [
      `숙제는 ${total}개 중 ${missing.length}개를 아직 제출하지 못했습니다(${titles}). 밀린 숙제는 이번 주 안에 마무리할 수 있도록 지도하겠습니다.`,
      `숙제는 ${total}개 중 ${done + late}개를 제출했습니다. 빠진 ${missing.length}개(${titles})는 수업 때 확인하겠지만, 가정에서도 한 번 물어봐 주시면 큰 도움이 됩니다.`,
      `지난주에는 숙제 ${missing.length}개가 빠졌습니다(${titles}). 숙제는 수업 내용을 스스로 복습하는 과정이라 꾸준히 챙길 수 있도록 함께 신경 쓰겠습니다.`,
      `${J(N, '가')} 숙제 ${missing.length}개(${titles})를 내지 못했습니다. 이번 주에는 미루지 않고 바로 해 올 수 있도록 챙기겠습니다.`,
    ]);
    else if (late) talk = P('hw-late', [
      `숙제는 모두 제출했지만, ${late}개는 마감보다 늦게 냈습니다. 기한을 지키는 습관도 함께 잡아 가겠습니다.`,
      `${total}개 숙제를 모두 냈는데 그중 ${late}개가 조금 늦었습니다. 가정에서도 마감일을 한 번씩 챙겨 봐 주시면 감사하겠습니다.`,
      `숙제는 빠짐없이 제출했습니다. 다만 ${late}개는 기한을 넘겨서, 다음 주에는 제때 낼 수 있도록 이야기해 두었습니다.`,
    ]);
    else talk = P('hw-done', [
      `숙제는 ${total}개 모두 기한 안에 제출했습니다. 성실하게 잘 따라오고 있어요.`,
      `지난주 숙제 ${total}개를 빠짐없이 제출했습니다. 꾸준한 공부 습관이 잘 잡혀 가고 있습니다.`,
      `${J(N, '는')} 숙제를 모두 제때 제출했습니다. 이 성실함이 앞으로 가장 큰 힘이 될 거예요.`,
      `숙제 ${total}개를 모두 성실하게 해 왔습니다. 집에서도 잘했다고 한마디 해 주시면 좋겠습니다.`,
    ]);
    return { head: `■ 숙제 (${total}개 중 ${done + late}개 제출${late ? ` · 지각 ${late}개` : ''})`, lines, talk };
  }

  function weakParts(rows, N, P, multiSubject) {
    const out = [];
    const active = rows.filter((x) => x.w.level !== 'resolved');
    const resolved = rows.filter((x) => x.w.level === 'resolved');
    const subj = [...new Set(active.map((x) => x.unit.subject))];
    if (active.length) {
      out.push(P('weak-intro', [
        `이번 테스트와 수업 내용을 바탕으로 ${N}의 현재 취약한 부분을 단원별로 정리해 드립니다.`,
        `요즘 ${N}에게 가장 보완이 필요한 부분은 다음과 같습니다.`,
        '테스트 결과를 단원별로 살펴보니, 아래 부분을 집중적으로 보완하면 좋겠습니다.',
        subj.length === 1 ? `지금 ${J(subj[0], '에서')} ${J(N, '가')} 특히 약한 부분을 짚어 드리면 다음과 같습니다.` : null,
        `${N}의 답안을 단원별로 살펴보며 약한 부분을 체크해 보았습니다.`,
      ]));
      for (const { w, unit } of active) {
        const where = multiSubject ? `${unit.subject} ${unit.title}` : unit.title;
        const pts = (w.points || []).join(', ');
        let s;
        if (w.level === 'improving') {
          s = pts ? P('imp' + unit.id, [
            `${J(pts, '은')} 보완하는 중인데, 조금씩 나아지고 있습니다.`,
            `${pts} 부분은 지난번보다 확실히 좋아졌지만 조금 더 연습이 필요합니다.`,
            `${pts} 유형은 이제 감을 잡아 가는 중입니다.`,
          ]) : P('imp' + unit.id, ['보완하는 중이며 조금씩 나아지고 있습니다.', '지난번보다 좋아졌지만 조금 더 다져야 합니다.']);
          s = `· ${where} (보완 중): ${s}`;
        } else {
          s = pts ? P('weak' + unit.id, [
            `${J(pts, '이')} 아직 충분히 잡히지 않았습니다.`,
            `${pts} 부분에서 자주 막힙니다.`,
            `${pts} 유형을 더 연습해야 합니다.`,
            `${J(pts, '을')} 정확하게 적용하는 연습이 더 필요합니다.`,
          ]) : P('weak' + unit.id, ['단원 전반적으로 보완이 필요합니다.', '아직 개념이 확실하게 자리 잡지 않았습니다.']);
          s = `· ${where}: ${s}`;
        }
        out.push(s + (w.note ? ' ' + endDot(w.note) : ''));
      }
      out.push(P('weak-plan', [
        '이번 주 수업에서는 위 부분을 중심으로 보충 문제를 풀고, 다음 테스트에서 다시 확인하겠습니다.',
        '해당 유형은 수업 시간에 따로 설명하고 비슷한 문제를 추가로 내 주려고 합니다.',
        '취약한 부분은 개별 과제로 한 번 더 연습시키고, 다음 주에 다시 점검해서 말씀드리겠습니다.',
        '한 번에 다 잡기보다는 하나씩 확실히 보완해 나가겠습니다. 진행 상황은 다음 리포트에서 다시 전해 드릴게요.',
        '이 부분들은 오답 정리와 유사 문제 풀이로 집중해서 채워 나가겠습니다.',
      ]));
    }
    if (resolved.length) {
      const names = resolved.map((x) => x.unit.title).join(', ');
      out.push(P('resolved', [
        `지난번 말씀드렸던 ${names} 부분은 이제 잘 해결되었습니다. 많이 칭찬해 주세요!`,
        `반가운 소식도 있습니다. 약했던 ${names} 부분이 이번에 확실히 좋아졌습니다.`,
        `그동안 보완해 온 ${names} 부분은 이제 안정적으로 풀어냅니다.`,
      ]));
    }
    if (!out.length) {
      out.push(P('weak-none', [
        '현재 특별히 취약한 단원은 없습니다. 지금처럼 꾸준히 해 나가면 좋겠습니다.',
        '지금 배우는 단원에서 크게 약한 부분은 보이지 않습니다. 이대로 실수만 줄여 가면 됩니다.',
      ]));
    }
    return { head: '■ 현재 취약 부분 체크', lines: out };
  }

  /* ---------- 주간 리포트 ---------- */
  // opt: { academy, honor, closing, fb, from, to, shuffle, pick: {tests, hw, weak} (리포트에 넣을 행), weakOn }
  function weekly(s, opt) {
    const N = nick(s.name);
    const P = picker(Math.floor(dayIndex(opt.from) / 7) + (opt.shuffle || 0), s.id);
    const H = opt.honor && opt.honor !== '학부모님' ? opt.honor : '';
    const hi1 = H ? `안녕하세요, ${H}.` : '안녕하세요.';
    const hi3 = H ? `${H}, 안녕하세요.` : '안녕하세요.';
    const hi2 = H ? `안녕하세요 ${H}, ${opt.academy}입니다.` : `안녕하세요, ${opt.academy}입니다.`;
    const today = UI.todayStr();
    const L = [`[${opt.academy}] ${s.name} 학생 주간 학습 리포트`, `${weekLabel(opt.from)} (${md(opt.from)} ~ ${md(opt.to)})`, ''];

    const season = P('season', [...seasonPool(today), '', '']);
    L.push(P('hello', [
      `${hi1} ${opt.academy}입니다. ${season} 지난 한 주 ${N}의 학습 내용을 정리해 말씀드립니다.`,
      `${hi2} ${season} ${N}의 지난주 공부 내용을 공유드립니다.`,
      `${hi3} ${opt.academy}입니다. ${season} 한 주 동안 ${J(N, '가')} 어떻게 공부했는지 정리해 보았습니다.`,
      `${hi1} 한 주 잘 보내셨나요? ${opt.academy}입니다. ${N}의 지난주 학습 상황을 전해 드립니다.`,
      `${hi1} ${opt.academy}입니다. ${season} ${weekLabel(opt.from)} ${N}의 학습 리포트를 보내 드립니다.`,
    ]).replace(/\s{2,}/g, ' '));

    const tests = opt.pick.tests;
    if (tests.length) {
      L.push('', '■ 지난주 테스트');
      const talks = [];
      tests.forEach((x, i) => {
        const p = scoreParts(x, N, P, i === tests.length - 1);
        L.push(p.line);
        if (range(x.t)) L.push(`  · 범위: ${range(x.t)}`);
        if (opt.fb && p.feedback) L.push(`  └ ${p.feedback}`);
        if (p.talk) talks.push(p.talk);
      });
      L.push(talks.join(' '));
    }

    if (opt.pick.hw.length) {
      const h = hwParts(opt.pick.hw, N, P, opt.fb);
      L.push('', h.head, ...h.lines);
      if (h.talk) L.push(h.talk);
    }

    if (opt.weakOn) {
      const multi = new Set(opt.pick.weak.map((x) => x.unit.subject)).size > 1;
      const w = weakParts(opt.pick.weak, N, P, multi);
      L.push('', w.head, ...w.lines);
    }

    L.push('', P('bye', [
      `다음 주에도 ${J(N, '가')} 꾸준히 성장할 수 있도록 잘 이끌겠습니다.`,
      `한 주 동안 수고한 ${N}에게 따뜻한 격려 한마디 부탁드립니다.`,
      `앞으로도 ${N}의 변화를 꼼꼼히 살피며 자주 소식 전해 드리겠습니다.`,
      `이번 주도 ${J(N, '와')} 함께 차근차근 채워 나가겠습니다.`,
      '작은 변화도 놓치지 않고 계속 살펴보겠습니다.',
    ]));
    if (opt.closing && opt.closing.trim()) L.push(opt.closing.trim());
    return L.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  /* ---------- 월간 리포트 ---------- */
  function monthly(s, opt) {
    const N = nick(s.name);
    const m = Number(opt.from.slice(5, 7));
    const P = picker(Number(opt.from.slice(0, 4)) * 12 + m + (opt.shuffle || 0), s.id);
    const H = opt.honor && opt.honor !== '학부모님' ? opt.honor : '';
    const hi1 = H ? `안녕하세요, ${H}.` : '안녕하세요.';
    const hi3 = H ? `${H}, 안녕하세요.` : '안녕하세요.';
    const hi2 = H ? `안녕하세요 ${H}, ${opt.academy}입니다.` : `안녕하세요, ${opt.academy}입니다.`;
    const { tests, hw } = items(s, opt.from, opt.to);
    const L = [`[${opt.academy}] ${s.name} 학생 ${m}월 월간 리포트`, `기간: ${md(opt.from)} ~ ${md(opt.to)}`, ''];
    L.push(P('hello', [
      `${hi1} ${opt.academy}입니다. ${N}의 ${m}월 학습 현황을 정리해 보내 드립니다.`,
      `${hi2} ${m}월 한 달 동안 ${N}의 숙제와 테스트 결과를 정리했습니다.`,
      `${hi3} ${opt.academy}입니다. ${N}의 ${m}월 월간 리포트를 보내 드립니다.`,
    ]));

    // 숙제
    const sent = hw.filter((r) => r.state === 'done' || r.state === 'late').length;
    const due = hw.filter((r) => r.state !== 'pending').length;
    const rate = due ? Math.round((hw.filter((r) => r.state === 'done' || r.state === 'late').length / due) * 100) : null;
    L.push('', `■ 숙제 (${hw.length}개 중 ${sent}개 제출${rate !== null ? ` · 제출률 ${rate}%` : ''})`);
    if (!hw.length) L.push('- 이번 달 숙제가 없습니다.');
    const STATE = { done: '제출 완료', late: '지각 제출', missing: '미제출' };
    for (const r of hw) L.push(`- ${r.a.title} (마감 ${md(r.a.dueDate)}): ${STATE[r.state] || '진행 중'}`);

    // 테스트 (반별)
    const multi = s.classNames.length > 1;
    let myPcts = [], avgPcts = [];
    for (const c of s.classNames) {
      const rows = tests.filter((x) => x.t.className === c);
      if (!rows.length && multi) continue;
      L.push('', multi ? `■ 테스트 성적 · ${c}` : '■ 테스트 성적');
      if (!rows.length) L.push('- 이번 달 테스트가 없습니다.');
      for (const x of rows) {
        const max = Number(x.t.maxScore) || 100;
        if (!hasScore(x.sc)) { L.push(`- ${x.t.title} (${md(x.t.date)}): 미응시`); if (range(x.t)) L.push(`  · 범위: ${range(x.t)}`); continue; }
        L.push(`- ${x.t.title} (${md(x.t.date)}): ${x.sc.score}점 / ${max}점${x.st.avg !== null ? ` · 반 평균 ${x.st.avg}점` : ''}`);
        if (range(x.t)) L.push(`  · 범위: ${range(x.t)}`);
        if (opt.fb && x.sc.feedback) L.push(`  └ ${oneLine(x.sc.feedback)}`);
        myPcts.push((x.sc.score / max) * 100);
        if (x.st.avg !== null) avgPcts.push((x.st.avg / max) * 100);
      }
    }
    if (!tests.length && multi) L.push('', '■ 테스트 성적', '- 이번 달 테스트가 없습니다.');
    const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    const my = mean(myPcts), cls = mean(avgPcts);
    if (my !== null) L.push(`→ 이번 달 평균 ${my}점${cls !== null ? ` (반 평균 ${cls}점)` : ''}${tests.some((x) => Number(x.t.maxScore) !== 100) ? ' · 100점 환산' : ''}`);

    // 한 줄 정리
    const hwGood = rate === null || rate >= 90;
    const scGood = my === null || cls === null || my >= cls;
    L.push('', hwGood && scGood ? P('sum', [
      `이번 달 ${J(N, '는')} 숙제와 테스트 모두 성실하게 잘 해냈습니다.`,
      `${m}월 한 달 동안 꾸준히 잘 따라와 주었습니다. 다음 달에도 이 흐름을 이어 가겠습니다.`,
    ]) : hwGood ? P('sum', [
      `숙제는 성실하게 해 왔지만 테스트 점수는 조금 아쉬움이 남는 한 달이었습니다. 다음 달에는 오답 보완에 더 신경 쓰겠습니다.`,
      `숙제 습관은 잘 잡혀 있습니다. 테스트 점수가 더 오를 수 있도록 약한 부분을 집중적으로 보완하겠습니다.`,
    ]) : P('sum', [
      `이번 달은 숙제 제출이 조금 아쉬웠습니다. 다음 달에는 빠짐없이 해 올 수 있도록 함께 챙기겠습니다.`,
      `숙제를 꾸준히 해 오는 것이 실력을 다지는 가장 좋은 방법이라, 다음 달에는 제출률을 더 높여 보겠습니다.`,
    ]));
    if (opt.closing && opt.closing.trim()) L.push(opt.closing.trim());
    return L.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  global.ReportText = { weekly, monthly, items, lastWeek, weekLabel, monthRange, defaultMonth, addDays, mondayOf, nick, J };
})(window);
