/* ============================================================
 * 바로가기 아이콘 만들기 (홈 화면에 앱 아이콘 추가)
 *  - 안드로이드 크롬·삼성인터넷·PC 크롬/엣지: 브라우저의 설치 창을 바로 띄움 (한 번 누르면 끝)
 *  - 아이폰(사파리·크롬): 웹페이지가 아이콘을 직접 만들 수 없어서, 누를 곳을 그림으로 안내
 *  - 카카오톡 등 앱 안의 브라우저: 아이콘을 만들 수 없어서 사파리/크롬으로 다시 열어 줌
 * ============================================================ */
(function (global) {
  'use strict';
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const inKakao = /KAKAOTALK/i.test(ua);
  const inApp = inKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|FB_IAB|Line\/|DaumApps|everytimeApp|BAND\//i.test(ua);
  const iosChrome = isIOS && /CriOS/i.test(ua);
  const samsung = /SamsungBrowser/i.test(ua);

  let deferred = null;        // 브라우저가 준 설치 창 (안드로이드/PC)
  let installedNow = false;
  const listeners = [];
  const changed = () => listeners.forEach((fn) => fn());

  global.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
  global.addEventListener('appinstalled', () => { deferred = null; installedNow = true; changed(); });

  // 화면이 잠깐 안 보여도 괜찮은 아주 단순한 서비스 워커 (설치 조건 충족용, 캐시 안 함)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
  }

  const Install = {
    // 이미 아이콘으로 열었으면 버튼을 숨김
    isStandalone() {
      return global.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    },
    shouldShow() { return !this.isStandalone() && !installedNow; },
    onChange(fn) { listeners.push(fn); },

    button(label = '📲 바로가기 아이콘 만들기') {
      if (!this.shouldShow()) return '';
      return `<button type="button" class="btn btn-block install-btn" data-install>${label}</button>
        <p class="muted small install-sub">홈 화면에 아이콘을 만들어 두면 앱처럼 바로 열 수 있어요.</p>`;
    },
    bind(root = document) {
      root.querySelectorAll('[data-install]').forEach((b) => { b.onclick = () => Install.start(); });
    },

    async start() {
      // 1) 브라우저 설치 창이 있으면 바로 띄우기
      if (deferred) {
        const ev = deferred; deferred = null;
        try {
          await ev.prompt();
          const { outcome } = await ev.userChoice;
          if (outcome === 'accepted') { installedNow = true; UI.toast('홈 화면에 아이콘이 생겼어요!'); changed(); }
          return;
        } catch (e) { console.warn(e); } // 설치 창을 못 띄우면 아래 안내로
      }
      // 2) 카카오톡 안 → 기본 브라우저(사파리/크롬)로 다시 열기
      if (inKakao) {
        location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
        return showGuide('kakao');
      }
      // 3) 다른 앱 안의 브라우저 (안드로이드는 크롬으로 바로 열기)
      if (inApp && isAndroid) {
        location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
        return showGuide('inapp');
      }
      if (inApp) return showGuide('inapp');
      // 4) 아이폰 / 그 밖의 브라우저 → 누를 곳 안내
      if (isIOS) return showGuide(iosChrome ? 'iosChrome' : 'iosSafari');
      if (samsung) return showGuide('samsung');
      if (isAndroid) return showGuide('android');
      return showGuide('desktop');
    },
  };

  const SHARE_ICON = '<span class="ig-ico" aria-label="공유 버튼">⬆︎</span>';
  const GUIDES = {
    iosSafari: {
      title: '아이폰 사파리에서 아이콘 만들기',
      steps: [
        `화면 아래(또는 위)의 공유 버튼 ${SHARE_ICON} 을 눌러요.<br><span class="muted small">안 보이면 <b>···</b> 버튼을 먼저 눌러요.</span>`,
        '목록을 내려서 <b>‘홈 화면에 추가’</b> 를 눌러요.',
        '오른쪽 위 <b>‘추가’</b> 를 누르면 끝!',
      ],
    },
    iosChrome: {
      title: '아이폰 크롬에서 아이콘 만들기',
      steps: [
        `주소창 오른쪽의 공유 버튼 ${SHARE_ICON} 을 눌러요.`,
        '<b>‘홈 화면에 추가’</b> 를 눌러요. (안 보이면 목록 아래 ‘더 보기’)',
        '오른쪽 위 <b>‘추가’</b> 를 누르면 끝!',
      ],
    },
    samsung: {
      title: '삼성 인터넷에서 아이콘 만들기',
      steps: ['화면 아래 메뉴 <b>≡</b> 를 눌러요.', '<b>‘현재 페이지 추가’ → ‘홈 화면’</b> 을 눌러요.', '<b>‘추가’</b> 를 누르면 끝!'],
    },
    android: {
      title: '크롬에서 아이콘 만들기',
      steps: ['오른쪽 위 <b>⋮</b> 메뉴를 눌러요.', '<b>‘홈 화면에 추가’</b> 또는 <b>‘앱 설치’</b> 를 눌러요.', '<b>‘설치’ / ‘추가’</b> 를 누르면 끝!'],
    },
    desktop: {
      title: 'PC에서 바로가기 만들기',
      steps: ['크롬·엣지 주소창 오른쪽의 <b>설치 아이콘(⊕)</b> 을 눌러요.', '안 보이면 메뉴 <b>⋮ → ‘앱 설치’</b> 또는 <b>‘바로가기 만들기’</b>.'],
    },
    kakao: {
      title: '브라우저에서 다시 열어 주세요',
      steps: ['카카오톡 안에서는 아이콘을 만들 수 없어요.', '사파리/크롬으로 이 화면이 다시 열리면, 거기서 <b>‘바로가기 아이콘 만들기’</b> 를 한 번 더 눌러 주세요.'],
    },
    inapp: {
      title: '브라우저에서 다시 열어 주세요',
      steps: [
        '지금 앱 안의 브라우저에서는 아이콘을 만들 수 없어요.',
        `오른쪽 위(또는 아래) <b>···</b> 메뉴에서 <b>‘${isIOS ? 'Safari로 열기' : '다른 브라우저로 열기'}’</b> 를 누르세요.`,
        '열린 화면에서 <b>‘바로가기 아이콘 만들기’</b> 를 한 번 더 눌러 주세요.',
      ],
    },
  };

  function showGuide(kind) {
    const g = GUIDES[kind];
    document.querySelector('.install-guide')?.remove();
    const el = document.createElement('div');
    el.className = 'install-guide';
    el.innerHTML = `
      <div class="ig-sheet" role="dialog" aria-label="${g.title}">
        <div class="ig-head"><b>${g.title}</b><button type="button" class="icon-btn" data-close aria-label="닫기">✕</button></div>
        <ol class="ig-steps">${g.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        ${isIOS && kind.startsWith('ios') ? '<p class="muted small">💡 아이콘을 만든 뒤에는 <b>아이콘으로 열어서 로그인</b>해 주세요. (사파리 로그인과 따로 저장돼요)</p>' : ''}
        <button type="button" class="btn btn-primary btn-block" data-close>알겠어요</button>
      </div>`;
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) el.remove(); });
    document.body.appendChild(el);
  }

  global.Install = Install;
})(window);
