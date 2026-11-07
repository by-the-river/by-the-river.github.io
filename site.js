// 카카오톡 오픈채팅 링크. 바꾸면 모든 문의 버튼에 적용됨
const KAKAO_URL = 'https://open.kakao.com/o/sIgvAQDi';

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="inquiry" aria-labelledby="inquiryTitle">
    <form id="inquiryForm">
      <div class="dialog-head">
        <h2 id="inquiryTitle">수업 문의</h2>
        <button class="close" id="closeInquiry" type="button" aria-label="닫기">×</button>
      </div>
      <p class="guide">문의 내용을 쓰고 아래 버튼을 누르면 내용이 복사되고 카카오톡 채팅이 열립니다. 채팅창에 붙여넣어 보내 주세요.</p>
      <textarea id="message" required aria-label="문의 내용" placeholder="예) 해운대고 1학년 학생입니다. 최근 모의고사 3등급이고 수업 상담을 받고 싶습니다."></textarea>
      <button class="button" type="submit">내용 복사하고 카카오톡 열기</button>
      <p class="status" id="status" role="status"></p>
    </form>
  </dialog>
`);

const dialog = document.getElementById('inquiry');
const message = document.getElementById('message');
const statusText = document.getElementById('status');

function showStatus(text, type) {
  statusText.textContent = text;
  statusText.className = 'status ' + type;
}

// 카카오톡 창이 열리면 이 페이지가 포커스를 잃으므로 그 전에 동기 방식으로 복사
function copyMessage() {
  message.select();
  return document.execCommand('copy');
}

document.querySelectorAll('[data-inquiry]').forEach(button => {
  button.addEventListener('click', () => {
    showStatus('', '');
    dialog.showModal();
  });
});

document.getElementById('closeInquiry').addEventListener('click', () => dialog.close());

// 바깥 어두운 영역을 누르면 닫기
dialog.addEventListener('click', e => {
  if (e.target === dialog) dialog.close();
});

document.getElementById('inquiryForm').addEventListener('submit', e => {
  e.preventDefault();
  const copied = copyMessage();
  window.open(KAKAO_URL, '_blank', 'noopener');
  if (copied) {
    showStatus('내용을 복사했습니다. 카카오톡 채팅창에 붙여넣어 보내 주세요.', 'ok');
  } else {
    showStatus('자동 복사에 실패했습니다. 내용을 직접 복사해 채팅창에 붙여넣어 주세요.', 'error');
  }
});
