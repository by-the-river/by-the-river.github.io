/* Supabase 연결 정보
 * Supabase 대시보드 > Project Settings > API 에서 복사해 넣으세요.
 *  - SUPABASE_URL:      Project URL (끝에 /rest/v1/ 없이)
 *  - SUPABASE_ANON_KEY: anon(public) 키 또는 publishable 키
 *    (이 키는 웹에 공개되어도 되는 키입니다. service_role / secret 키는 절대 넣지 마세요!)
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://ludhxbtyslscfgkcnmwa.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1ZGh4YnR5c2xzY2Zna2NubXdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyOTY3MDQsImV4cCI6MjEwOTg3MjcwNH0.jX7aE5dFmqOBKwpbmgZyhxMJESYvQPN3tKRm1rgn4l8',

  // 학생 아이디를 로그인용 이메일로 바꿀 때 쓰는 도메인 (실제 메일은 발송되지 않음)
  STUDENT_EMAIL_DOMAIN: 'student.ankangyeop.com',
};
