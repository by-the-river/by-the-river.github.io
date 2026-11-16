/* ============================================================
   질문노트 그래프 그리기 (AskGraph)
   AI 답변 속 ```graph { JSON } ``` 블록을 SVG 그림으로 바꿈.
   - 함수식은 자체 계산기로 해석 (eval 사용 안 함)
   - 같은 파일이 profile-site/ask/graph.js 와 learning-app/js/graph.js 에 있음 (둘 다 고칠 것)
   형식 예:
   {"x":[-3,8],"y":[-6,10],"caption":"개형",
    "curves":[{"f":"x^3/4-3/2*x^2+x","label":"y=f(x)"},{"f":"x","dash":true,"label":"y=x"}],
    "points":[{"x":2,"y":-2,"label":"(2,-2)"},{"x":0,"y":0,"hollow":true}],
    "vlines":[{"x":2,"label":"x=2"}], "hlines":[{"y":1}],
    "segments":[{"from":[0,0],"to":[3,4],"dash":true}],
    "shade":[{"f":"x^2","g":"0","from":0,"to":1}],
    "xmarks":[2,{"x":6,"label":"6"}], "ymarks":[-2], "equal":false}
   ============================================================ */
(function (global) {
  'use strict';
  const COLORS = ['#2148d4', '#d9441a', '#1d7a52', '#b7791f', '#7c3aed'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 수식 계산기 ---------- */
  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log2: Math.log2, log10: Math.log10, floor: Math.floor, ceil: Math.ceil,
    log: (a, b) => (b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a)), // log(밑, 진수)
    max: Math.max, min: Math.min,
  };
  const CONSTS = { pi: Math.PI, e: Math.E };

  function tokenize(src) {
    const s = String(src).replace(/π/g, 'pi').replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^');
    const out = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
      if (num && /[\d.]/.test(c)) { out.push({ t: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
      const id = s.slice(i).match(/^[a-zA-Z_][a-zA-Z_0-9]*/);
      if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      if ('+-*/^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
      throw new Error('모르는 기호: ' + c);
    }
    return out;
  }

  // 식 문자열 → (x) => 값
  function compile(src) {
    const tk = tokenize(src); let p = 0;
    const peek = () => tk[p], eat = (t) => { if (tk[p] && tk[p].t === t) { p++; return true; } return false; };
    const need = (t) => { if (!eat(t)) throw new Error(t + ' 필요'); };
    const startsAtom = (k) => k && (k.t === 'n' || k.t === 'id' || k.t === '(');
    function expr() {
      let a = term();
      for (;;) {
        if (eat('+')) { const l = a, r = term(); a = (x) => l(x) + r(x); }
        else if (eat('-')) { const l = a, r = term(); a = (x) => l(x) - r(x); }
        else return a;
      }
    }
    function term() {
      let a = unary();
      for (;;) {
        if (eat('*')) { const l = a, r = unary(); a = (x) => l(x) * r(x); }
        else if (eat('/')) { const l = a, r = unary(); a = (x) => l(x) / r(x); }
        else if (startsAtom(peek())) { const l = a, r = power(); a = (x) => l(x) * r(x); } // 2x, 3(x-1)
        else return a;
      }
    }
    function unary() {
      if (eat('-')) { const a = unary(); return (x) => -a(x); }
      if (eat('+')) return unary();
      return power();
    }
    function power() {
      const b = atom();
      if (eat('^')) { const e = unary(); return (x) => Math.pow(b(x), e(x)); }
      return b;
    }
    function atom() {
      const k = tk[p++];
      if (!k) throw new Error('식이 끝남');
      if (k.t === 'n') { const v = k.v; return () => v; }
      if (k.t === '(') { const a = expr(); need(')'); return a; }
      if (k.t === 'id') {
        const name = k.v;
        if (name === 'x' || name === 't') return (x) => x;
        if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
        if (name in FUNCS) {
          const fn = FUNCS[name];
          if (eat('^')) { // sin^2(x)
            const e = atom(); need('('); const a = expr(); need(')');
            return (x) => Math.pow(fn(a(x)), e(x));
          }
          need('('); const args = [expr()]; while (eat(',')) args.push(expr()); need(')');
          return (x) => fn(...args.map((g) => g(x)));
        }
        throw new Error('모르는 이름: ' + name);
      }
      throw new Error('잘못된 식');
    }
    const f = expr();
    if (p < tk.length) throw new Error('식 해석 실패');
    return f;
  }
  const num = (v, dflt) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim()) { try { return compile(v)(0); } catch (e) { /* 아래로 */ } }
    return dflt;
  };

  /* ---------- 그리기 ---------- */
  function render(jsonText) {
    let g;
    try { g = JSON.parse(jsonText); } catch (e) { return null; }
    if (!g || typeof g !== 'object') return null;
    const [x0, x1] = (g.x || [-5, 5]).map((v) => num(v, NaN));
    const [y0, y1] = (g.y || [-5, 5]).map((v) => num(v, NaN));
    if (![x0, x1, y0, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;

    const W = 400, PAD = 14;
    let H = 300;
    if (g.equal) H = Math.max(200, Math.min(560, (W - 2 * PAD) * (y1 - y0) / (x1 - x0) + 2 * PAD));
    const sx = (x) => PAD + (x - x0) / (x1 - x0) * (W - 2 * PAD);
    const sy = (y) => H - PAD - (y - y0) / (y1 - y0) * (H - 2 * PAD);
    const R = (v) => Math.round(v * 10) / 10;
    const id = 'g' + Math.random().toString(36).slice(2, 8);
    const out = [];
    const labels = [];
    const label = (x, y, text, color, anchor) => {
      if (!text) return;
      let a = anchor || 'start';
      let px = x, py = y;
      if (a === 'start' && px > W - 70) { a = 'end'; px -= 12; }
      px = Math.max(4, Math.min(W - 4, px)); py = Math.max(14, Math.min(H - 4, py));
      labels.push(`<text x="${R(px)}" y="${R(py)}" fill="${color}" text-anchor="${a}" font-size="13" paint-order="stroke" stroke="#fff" stroke-width="3.5" stroke-linejoin="round">${esc(text)}</text>`);
    };

    // 넓이 칠하기
    (g.shade || []).forEach((s, i) => {
      try {
        const f = compile(s.f), h = compile(s.g ?? '0');
        const a = Math.max(num(s.from, x0), x0), b = Math.min(num(s.to, x1), x1);
        if (!(b > a)) return;
        const N = 160, top = [], bot = [];
        for (let k = 0; k <= N; k++) {
          const x = a + (b - a) * k / N, u = f(x), v = h(x);
          if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
          top.push(`${R(sx(x))},${R(sy(u))}`); bot.unshift(`${R(sx(x))},${R(sy(v))}`);
        }
        if (top.length > 1) out.push(`<polygon points="${top.concat(bot).join(' ')}" fill="${COLORS[(s.color ?? i) % COLORS.length]}" fill-opacity=".16" stroke="none"/>`);
      } catch (e) { /* 건너뜀 */ }
    });

    // 축
    const axis = '#161d33';
    const ax = y0 <= 0 && 0 <= y1 ? sy(0) : null, ay = x0 <= 0 && 0 <= x1 ? sx(0) : null;
    if (ax !== null) {
      out.push(`<line x1="${PAD - 6}" y1="${R(ax)}" x2="${W - 4}" y2="${R(ax)}" stroke="${axis}" stroke-width="1.2" marker-end="url(#${id}a)"/>`);
      labels.push(`<text x="${W - 6}" y="${R(ax + 16)}" font-size="13" text-anchor="end" font-style="italic" fill="${axis}">x</text>`);
    }
    if (ay !== null) {
      out.push(`<line x1="${R(ay)}" y1="${H - PAD + 6}" x2="${R(ay)}" y2="4" stroke="${axis}" stroke-width="1.2" marker-end="url(#${id}a)"/>`);
      labels.push(`<text x="${R(ay + 8)}" y="14" font-size="13" font-style="italic" fill="${axis}">y</text>`);
    }
    if (ax !== null && ay !== null) labels.push(`<text x="${R(ay - 5)}" y="${R(ax + 15)}" font-size="12" text-anchor="end" fill="${axis}">O</text>`);

    // 눈금 표시
    const marks = (list, isX) => (list || []).forEach((m) => {
      const v = num(typeof m === 'object' ? m.x ?? m.y : m, NaN);
      if (!Number.isFinite(v)) return;
      const text = typeof m === 'object' && m.label != null ? m.label : String(Math.round(v * 100) / 100);
      if (isX) {
        const X = sx(v), Y = ax ?? H - PAD;
        out.push(`<line x1="${R(X)}" y1="${R(Y - 3)}" x2="${R(X)}" y2="${R(Y + 3)}" stroke="${axis}"/>`);
        labels.push(`<text x="${R(X)}" y="${R(Math.min(H - 3, Y + 16))}" font-size="12" text-anchor="middle" fill="${axis}" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(text)}</text>`);
      } else {
        const Y = sy(v), X = ay ?? PAD;
        out.push(`<line x1="${R(X - 3)}" y1="${R(Y)}" x2="${R(X + 3)}" y2="${R(Y)}" stroke="${axis}"/>`);
        labels.push(`<text x="${R(Math.max(10, X - 6))}" y="${R(Y + 4)}" font-size="12" text-anchor="end" fill="${axis}" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(text)}</text>`);
      }
    });
    marks(g.xmarks, true); marks(g.ymarks, false);

    // 보조선
    const dashed = 'stroke-dasharray="5 4"';
    (g.vlines || []).forEach((v) => {
      const x = num(v.x, NaN); if (!Number.isFinite(x)) return;
      out.push(`<line x1="${R(sx(x))}" y1="${PAD}" x2="${R(sx(x))}" y2="${H - PAD}" stroke="#5d6579" stroke-width="1" ${dashed}/>`);
      label(sx(x) + 4, PAD + 12, v.label, '#5d6579');
    });
    (g.hlines || []).forEach((v) => {
      const y = num(v.y, NaN); if (!Number.isFinite(y)) return;
      out.push(`<line x1="${PAD}" y1="${R(sy(y))}" x2="${W - PAD}" y2="${R(sy(y))}" stroke="#5d6579" stroke-width="1" ${dashed}/>`);
      label(W - PAD - 2, sy(y) - 5, v.label, '#5d6579', 'end');
    });
    (g.segments || []).forEach((s, i) => {
      const a = (s.from || []).map((v) => num(v, NaN)), b = (s.to || []).map((v) => num(v, NaN));
      if (![...a, ...b].every(Number.isFinite) || a.length < 2 || b.length < 2) return;
      const c = s.color != null ? COLORS[s.color % COLORS.length] : '#5d6579';
      out.push(`<line x1="${R(sx(a[0]))}" y1="${R(sy(a[1]))}" x2="${R(sx(b[0]))}" y2="${R(sy(b[1]))}" stroke="${c}" stroke-width="1.6" ${s.dash ? dashed : ''}/>`);
      if (s.label) label((sx(a[0]) + sx(b[0])) / 2 + 4, (sy(a[1]) + sy(b[1])) / 2 - 4, s.label, c);
    });

    // 곡선
    const yspan = y1 - y0;
    (g.curves || []).forEach((c, i) => {
      let f; try { f = compile(c.f); } catch (e) { return; }
      const color = COLORS[(c.color ?? i) % COLORS.length];
      const a = Math.max(num(c.from, x0), x0), b = Math.min(num(c.to, x1), x1);
      if (!(b > a)) return;
      const N = 600; let d = '', prev = null, last = null, best = null;
      for (let k = 0; k <= N; k++) {
        const x = a + (b - a) * k / N; const y = f(x);
        const ok = Number.isFinite(y) && y > y0 - yspan * 4 && y < y1 + yspan * 4;
        if (!ok || (prev !== null && Math.abs(y - prev) > yspan * 2)) { prev = ok ? y : null; if (ok) d += `M${R(sx(x))},${R(sy(y))}`; continue; }
        d += (prev === null ? 'M' : 'L') + `${R(sx(x))},${R(sy(y))}`;
        prev = y;
        if (y >= y0 && y <= y1) { last = [sx(x), sy(y)]; if (!best && x >= a + (b - a) * 0.8) best = last; }
      }
      if (!d) return;
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" ${c.dash ? dashed : ''} clip-path="url(#${id}c)"/>`);
      const at = best || last;
      if (c.label && at) label(at[0] + 6, at[1] - 6, c.label, color);
    });

    // 점
    (g.points || []).forEach((pt) => {
      const x = num(pt.x, NaN), y = num(pt.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const c = pt.color != null ? COLORS[pt.color % COLORS.length] : '#161d33';
      out.push(`<circle cx="${R(sx(x))}" cy="${R(sy(y))}" r="4" fill="${pt.hollow ? '#fff' : c}" stroke="${c}" stroke-width="1.8"/>`);
      label(sx(x) + 7, sy(y) - 7, pt.label, c);
    });

    const svg = `<svg viewBox="0 0 ${W} ${R(H)}" width="100%" style="max-width:${W}px;display:block;margin:0 auto" role="img" aria-label="${esc(g.caption || '그래프')}" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="${id}a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${axis}"/></marker>
<clipPath id="${id}c"><rect x="${PAD}" y="${PAD}" width="${W - 2 * PAD}" height="${R(H - 2 * PAD)}"/></clipPath></defs>
${out.join('\n')}
${labels.join('\n')}
</svg>`;
    return `<figure class="ask-graph" style="margin:14px 0;padding:10px 8px 6px;background:#fff;border:1px solid #e2e3e0;border-radius:12px">${svg}${g.caption ? `<figcaption style="margin-top:4px;text-align:center;font-size:13px;color:#5d6579">${esc(g.caption)}</figcaption>` : ''}</figure>`;
  }

  /* ---------- 마크다운 연결 도우미 ----------
     extract(text): ```graph 블록을 @@G0@@ 자리표시로 바꾸고 목록을 돌려줌 (스트리밍 중 덜 온 블록은 '그리는 중')
     inject(html, list): 자리표시를 그림으로 바꿈 */
  function extract(text) {
    const list = [];
    let t = String(text || '').replace(/```graph[^\n]*\n([\s\S]*?)```/g, (_, body) => { list.push(body); return `\n\n@@G${list.length - 1}@@\n\n`; });
    t = t.replace(/```graph[\s\S]*$/, () => { list.push(null); return `\n\n@@G${list.length - 1}@@\n\n`; });
    return { text: t, list };
  }
  function inject(html, list) {
    return html.replace(/(?:<p>\s*)?@@G(\d+)@@(?:\s*<\/p>)?/g, (_, i) => {
      const body = list[+i];
      if (body === null) return '<p style="color:#5d6579;font-size:14px">그래프 그리는 중…</p>';
      return render(body) || '';
    });
  }
  const strip = (s) => String(s || '').replace(/```graph[\s\S]*?(```|$)/g, ' ');

  global.AskGraph = { render, extract, inject, strip, compile };
})(typeof window !== 'undefined' ? window : globalThis);
