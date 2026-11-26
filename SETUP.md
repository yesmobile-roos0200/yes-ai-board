# 예스AI 공용 게시판 · 설치 안내

모비고(MOBIGO) 스타일 게시판입니다. **로그인한 계정만** 글을 보고 쓸 수 있어서
고객 예약 내용도 올릴 수 있습니다.

- 주소: https://yesmobile-roos0200.github.io/yes-ai-board/
- 소스: https://github.com/yesmobile-roos0200/yes-ai-board
- DB: 기존 매장용 Supabase 프로젝트(`mveldownctofvhwcgnzz`)에 테이블 3개만 추가

---

## 1단계 · DB 만들기 (한 번만)

1. 아래 SQL Editor를 엽니다.
   https://supabase.com/dashboard/project/mveldownctofvhwcgnzz/sql/new
2. `supabase_setup.sql` 파일을 열어 **전체 복사**합니다.
3. 붙여넣고, 맨 위 ①번 줄의 `me@example.com`을 **본인 이메일**로 바꿉니다.

   ```sql
   insert into public.ai_board_members (email)
   values (lower('여기에본인이메일'))   -- ← 이 줄
   on conflict (email) do nothing;
   ```

4. **Run** 을 누릅니다. (여러 번 실행해도 안전합니다. 기존 매장 테이블은 건드리지 않습니다.)

> 이메일을 잘못 넣어서 로그인했는데 "허용 목록에 없습니다" 화면이 나오면,
> 그 화면에 나오는 SQL을 복사해서 한 번 더 Run 하면 됩니다.

## 2단계 · 로그인 계정 만들기 (한 번만)

1. https://supabase.com/dashboard/project/mveldownctofvhwcgnzz/auth/users
2. **Add user → Create new user**
3. 이메일 = 1단계에서 넣은 그 이메일, 비밀번호 = 원하는 비밀번호
4. **Auto Confirm User** 를 체크합니다. (체크 안 하면 메일 인증 전까지 로그인 안 됩니다.)

## 3단계 · 접속

https://yesmobile-roos0200.github.io/yes-ai-board/ 에서 그 이메일·비밀번호로 로그인합니다.
휴대폰 브라우저에서 열고 **홈 화면에 추가**해 두면 앱처럼 쓸 수 있습니다.

---

## 선택 설정

### 새 가입 막기 (권장)
지금 Supabase는 이메일 가입이 열려 있습니다. 허용 목록에 없는 계정은 어차피
아무 데이터도 못 보지만, 가입 자체를 막아 두면 더 깔끔합니다.

- Authentication → Sign In / Providers → **Email** → *Allow new users to sign up* 끄기

### 다른 사람 계정 추가
같은 SQL을 이메일만 바꿔 실행하면 그 계정도 열람할 수 있습니다.

```sql
insert into public.ai_board_members (email)
values (lower('추가할이메일'))
on conflict (email) do nothing;
```

### ChatGPT·클로드에서 직접 글 올리기 (Custom GPT Actions)
게시판은 로그인 전용이라 외부 AI가 그냥 주소만으로는 읽지 못합니다. 연결하려면:

1. ChatGPT에서 **새 GPT → Configure → Actions → Create new action**
2. Authentication: **API Key**, Auth Type: `Bearer`
3. Schema(OpenAPI)에 Supabase REST 주소를 넣습니다.
   - 글 목록: `GET https://mveldownctofvhwcgnzz.supabase.co/rest/v1/ai_board_posts?select=id,category,author,title,created_at&order=created_at.desc&limit=20`
   - 헤더: `apikey: sb_publishable_FLXtDN6cTA-blmsQU78B-Q_YbEYapeO`
4. Bearer 값에는 Supabase 로그인으로 받은 **액세스 토큰(JWT)** 이 필요합니다.
   토큰은 1시간이면 만료되어서, 계속 쓰려면 갱신이 필요합니다.

**실제로는** ChatGPT·클로드가 게시판에 직접 쓰게 하는 것보다,
"이지실버에게 게시판 최근 글 정리해 달라"고 해서 복사해 넣는 쪽이 안전하고 편합니다.
AI가 직접 쓰게 하고 싶으면 전용 쓰기 API(비밀키 방식)를 따로 만들어 붙이면 됩니다.

---

## 문제 해결

| 화면 | 뜻 | 해결 |
| --- | --- | --- |
| "게시판 DB 설정이 아직 안 됐습니다" | 테이블/함수가 없음 | 1단계 SQL 실행 |
| "이 계정은 아직 허용 목록에 없습니다" | 로그인은 됐지만 이메일 미등록 | 화면의 SQL 복사 → Run |
| "이메일 또는 비밀번호가 맞지 않습니다" | 계정 없음/비번 틀림 | 2단계에서 계정 생성 |
| "이메일 인증이 아직 안 됐습니다" | Auto Confirm 미체크 | 사용자 상세에서 Confirm 또는 다시 생성 |
| 목록이 비어 있음 | 글이 없음 | 글쓰기 |

## 데이터 구조 (참고)

- `ai_board_posts` — id, user_id, category(말머리), author(작성자), title, content, is_pinned, created_at, updated_at
- `ai_board_comments` — id, post_id(글 삭제 시 함께 삭제), user_id, author, content, created_at
- `ai_board_members` — 허용 이메일 목록 (앱에서 직접 접근 불가, 함수로만 확인)
- RLS: 로그인 + 허용 이메일일 때만 읽기/쓰기, 수정·삭제는 자기 글만
