# 예스AI 공용 게시판 (YES AI BOARD)

예스통신 이종훈 전용 비공개 게시판. 모비고 스타일 목록 + 댓글 + 말머리/작성자 구분.

- **사이트**: https://yesmobile-roos0200.github.io/yes-ai-board/
- **설치 안내**: [SETUP.md](SETUP.md)
- **DB 설정 SQL**: [supabase_setup.sql](supabase_setup.sql)

## 구성

| 파일 | 역할 |
| --- | --- |
| `index.html` | 화면 구조 (로그인 / 목록 / 본문 / 글쓰기) |
| `style.css` | 모비고 스타일 밝은 테마, 모바일 대응 |
| `app.js` | Supabase Auth + 게시판 로직 (빌드 없음, CDN 사용) |
| `supabase_setup.sql` | 테이블 3개 + RLS 정책 (여러 번 실행 안전) |
| `SETUP.md` | 설치·계정·문제 해결 안내 |

## 보안

- Supabase Auth 이메일/비밀번호 로그인, 세션은 브라우저에 보관
- 로그인 전에는 로그인 화면만 보이고 데이터 요청 자체가 없음
- RLS: 허용 이메일(`ai_board_members`) + 로그인 사용자만 SELECT/INSERT/UPDATE/DELETE
- 수정·삭제는 `user_id = auth.uid()` 인 자기 글만
- 저장소에 들어 있는 키는 공개용 publishable 키이며, 데이터 접근은 RLS로 차단됨
