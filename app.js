/* 예스AI 공용 게시판 — app.js
   Supabase(이메일 로그인 + RLS) 기반 정적 게시판. 빌드 없음. */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://mveldownctofvhwcgnzz.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_FLXtDN6cTA-blmsQU78B-Q_YbEYapeO';

  /* 2026-11-27 종훈 님 요청: 누적성 자료(일일 마감·월간 결산·매입 일련번호·시세표)를 모으는
     `결산·자료` 말머리를 추가하고 상단 `📚 결산·자료실` 탭(#/archive)을 따로 뒀다. */
  const CATEGORIES = ['업무', '고객예약', '개발·앱', '세무·정산', '개인', '결산·자료'];
  /* 2026-11-27 종훈 님 확정: 피클 3명 이름 변경 — 이지실버→종훈비서 · 예스통신→예스매장 · 예스총괄→예스물류.
     새 드롭다운 선택지는 새 이름만 두고, 옛 이름은 AUTHOR_CLASS(색)와 AUTHOR_RENAMES(저장값 이전)에서만 받는다. */
  const AUTHORS = ['종훈비서', '예스매장', '예스물류', 'ChatGPT', 'Claude', '제미나이', 'Vooy', '종훈'];
  const AUTHOR_RENAMES = { '이지실버': '종훈비서', '예스통신': '예스매장', '예스총괄': '예스물류' };
  const canonicalAuthor = (name) => AUTHOR_RENAMES[name] || name;
  const isKnownAuthor = (name) => AUTHORS.includes(name) || !!AUTHOR_RENAMES[name];
  /* 2026-11-28 종훈 님 요청: ☰ 메뉴에서 정한 '기본 작성자'. 정해 두면 글·댓글 쓸 때 항상 그 이름이 먼저 선택된다.
     정하지 않으면 예전처럼 마지막에 쓴 이름(localStorage yes_ai_board_author)을 쓴다. */
  const DEFAULT_AUTHOR_KEY = 'yes_ai_board_default_author';
  function defaultAuthor() {
    const a = canonicalAuthor(localStorage.getItem(DEFAULT_AUTHOR_KEY));
    return AUTHORS.includes(a) ? a : '';
  }
  function preferredAuthor() {
    const d = defaultAuthor();
    if (d) return d;
    const saved = canonicalAuthor(localStorage.getItem('yes_ai_board_author'));
    return AUTHORS.includes(saved) ? saved : '';
  }
  /* 받침 유무에 맞는 조사 — '예스매장으로' / '종훈비서로' */
  function josaRo(word) {
    const s = String(word || '');
    const c = s.charCodeAt(s.length - 1);
    if (!(c >= 0xac00 && c <= 0xd7a3)) return '로';
    return (c - 0xac00) % 28 === 0 ? '로' : '으로';
  }
  const PAGE_SIZE = 15;
  const ALL = '전체';

  /* 대시보드(#/) 설정 — DB 변경 없이 제목 태그·`완료:` 댓글만으로 계산한다.
     2026-11-27 Claude 보완: 개발·앱 칸 앱별 최신 배포, ③과 중복 제외, 빈 칸 한 줄 접기, 모바일 영역 칸 가로 넘김.
     2026-11-27 Claude 2단계: 상태·중요도·담당·기한 칸(DB) 연결. 칸이 비어 있으면 1단계 규칙 그대로. */
  const TODO_TAGS = ['[결정필요]', '[긴급]', '[오류]', '[일정]'];
  /* ① 주요 · 최신 글 (2026-11-28 개편) — 예전 '지금 처리할 일'은 상태·태그가 비어 늘 0건이었다.
     지금은 중요도 높은 미완료 글을 먼저(최대 3개) + 최근 작성·수정 글을 채워 최대 5개를 보여 준다. */
  const KEY_POST_LIMIT = 5;
  const KEY_IMPORTANT_LIMIT = 3;
  const RULE_POST_ID = 6;                       // 게시판 이용 규칙 글
  const RULE_TAGS = ['[확정 규칙]', '[공지]'];
  const AREA_DEFS = [
    { key: '고객예약', label: '고객·예약', cls: 'area-reserve' },
    { key: '개발·앱', label: '개발·앱', cls: 'area-dev', compact: true },
    { key: '업무', label: '매장·업무', cls: 'area-work' },
    { key: '세무·정산', label: '세무·정산', cls: 'area-tax' }
  ];
  const AREA_EXTRA_LINK = {
    '고객예약': { href: 'https://app.notion.com/p/4182ce9e3d8f816fbc3dd82e7898aefb', label: '고객관리 원본' }
  };
  /* 2단계(2026-11-27): 상태·중요도·담당·기한 칸. 모두 비워도 되고, 비어 있으면 1단계 규칙(제목 태그 + 완료: 댓글)으로 판정 */
  const STATUSES = ['진행', '결정필요', '보류', '완료'];
  const STATUS_CLASS = { '진행': 'st-doing', '결정필요': 'st-decide', '보류': 'st-hold', '완료': 'st-done' };
  const PRIORITY_LABEL = { 1: '중요도 1', 2: '중요도 2', 3: '중요도 3' };
  const DUE_SOON_DAYS = 7;

  /* 2026-11-28: 러버블 yescom-game-hq /missions·/history 의 2순위 장기 일정(issues) 통합.
     테이블은 같은 Supabase 프로젝트의 `issues`를 그대로 쓰고, 컬럼·값은 실측 그대로 맞춘다.
     · 분류: 고객예약·금전·법무·매장·세금·행정·재고·기타 · 상태: 대기·진행중·확인필요·완료(진행 목록에서 빠짐) · 중요도: 높음·보통·낮음 */
  const ISSUE_CATEGORIES = ['고객예약', '금전', '법무', '매장', '세금·행정', '재고', '기타'];
  const ISSUE_STATUSES = ['대기', '진행중', '확인필요', '완료'];
  const ISSUE_PRIORITIES = ['높음', '보통', '낮음'];
  const ISSUE_DONE = '완료';
  const ISSUE_CAT_CLASS = {
    '고객예약': 'ic-reserve',
    '금전': 'ic-money',
    '법무': 'ic-legal',
    '매장': 'ic-store',
    '세금·행정': 'ic-tax',
    '재고': 'ic-stock',
    '기타': 'ic-etc'
  };

  /* 결산·자료실(#/archive) — 2026-11-27 추가.
     DB 변경 없이 `결산·자료`·`세무·정산` 말머리와 제목 낱말로만 누적 자료를 골라낸다.
     소분류는 상단 필터(전체 / 결산·세무 / 매입·일련번호 / 시세·기준)와 짝을 이룬다. */
  const ARCH_KINDS = [
    { key: 'tax', label: '결산·세무', short: '결산', re: /결산|마감|세무|정산|신고|장부/ },
    { key: 'buy', label: '매입·일련번호', short: '매입', re: /매입|일련번호|IMEI|시리얼/i },
    { key: 'market', label: '시세·기준', short: '시세', re: /시세|고정\s*기준|공통\s*기준|기준표|확정\s*규칙/ }
  ];
  const ARCHIVE_TITLE_RE = /매입|일련번호|IMEI|시리얼|시세|결산|자료|고정\s*기준|공통\s*기준|기준표|확정\s*규칙/i;
  /* 공지·업데이트 글은 제목에 결산·자료 낱말이 있어도 자료로 모으지 않는다(안내문이 자료실을 채우는 것 방지) */
  const ARCHIVE_SKIP_RE = /^\s*\[(업데이트|공지|배포|배포\s*공유)\]/;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CAT_CLASS = {
    '업무': 'cat-work',
    '고객예약': 'cat-reserve',
    '개발·앱': 'cat-dev',
    '세무·정산': 'cat-tax',
    '개인': 'cat-personal',
    '결산·자료': 'cat-archive'
  };
  const AUTHOR_CLASS = {
    '종훈비서': 'badge-jisilver',
    '이지실버': 'badge-jisilver',        // 구 이름 글 배지 색 유지
    '예스매장': 'badge-yes',
    '예스통신': 'badge-yes',             // 구 이름
    '예스물류': 'badge-chonggwal',
    '예스총괄': 'badge-chonggwal',       // 구 이름
    'ChatGPT': 'badge-chatgpt',
    'Claude': 'badge-claude',
    '제미나이': 'badge-gemini',
    'Vooy': 'badge-vooy',
    '종훈': 'badge-jonghun'
  };

  const state = {
    session: null,
    member: false,
    email: '',
    view: 'list',
    category: ALL,
    q: '',
    page: 1,
    total: 0,
    posts: [],
    loaded: false,
    dirty: true,
    listKey: '',
    postId: null,
    post: null,
    comments: [],
    editing: false,
    dash: null,          // { posts, cmts, at }
    dashDirty: true,
    arch: null,          // 결산·자료실 { posts, counts, at }
    archDirty: true,
    archFilter: 'all',
    personalOpen: false,
    lines: null,          // 회선 { lines, addons, at }
    linesDirty: true,
    linesFilter: '전체',
    lineOpenId: null,     // 상세 모달에 열린 회선 id
    lineFormId: null,     // 수정 중인 회선 id (신규면 null)
    issues: null,         // 일정 { list, at }
    issuesDirty: true,
    issuesFilter: '전체',
    archTab: 'data',      // data = 자료 · 결산 글 · history = 완료 기록 (2026-11-28)
    archHistCat: '전체',
    archHistQ: '',
    issueFormId: null     // 수정 중인 일정 id (신규면 null)
  };

  let db = null;

  /* ---------- 유틸 ---------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  function fmtShort(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }

  function fmtFull(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  function fmtDay(d) {
    const x = d instanceof Date ? d : new Date(d);
    if (isNaN(x)) return '';
    return `${x.getFullYear()}.${pad(x.getMonth() + 1)}.${pad(x.getDate())} (${WEEKDAY[x.getDay()]})`;
  }

  /* ---------- 대시보드용 계산 ---------- */
  /* 제목 맨 앞 `[태그]` 추출·분리 (태그는 12자 이내, 내부 공백 허용) */
  function titleTag(title) {
    const m = String(title == null ? '' : title).match(/^\s*(\[[^\]\n]{1,12}\])/);
    return m ? m[1] : '';
  }

  /* 기한까지 남은 날짜(오늘 0, 지남 음수). 날짜가 없으면 null */
  function dueDays(due) {
    if (!due) return null;
    const m = String(due).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  }

  function dueLabel(due) {
    const n = dueDays(due);
    if (n === null) return '';
    if (n === 0) return '오늘까지';
    return n > 0 ? `D-${n}` : `${-n}일 지남`;
  }

  /* 글의 상태·중요도·담당·기한 칩 (목록·대시보드·본문 공통) */
  function flagChips(p, opts) {
    const o = opts || {};
    const out = [];
    if (!o.noStatus && p.status) out.push(`<span class="flag flag-status ${STATUS_CLASS[p.status] || ''}">${esc(p.status)}</span>`);
    if (!o.noPriority && p.priority) out.push(`<span class="flag flag-pri p${Number(p.priority)}">${esc(PRIORITY_LABEL[p.priority] || '')}</span>`);
    if (!o.noOwner && p.owner) out.push(`<span class="flag flag-owner">담당 ${esc(p.owner)}</span>`);
    if (p.due_date && p.status !== '완료') {
      const n = dueDays(p.due_date);
      out.push(`<span class="flag flag-due${n !== null && n < 0 ? ' late' : (n !== null && n <= DUE_SOON_DAYS ? ' soon' : '')}">${esc(dueLabel(p.due_date))}</span>`);
    }
    return out.join('');
  }

  function stripTag(title) {
    return String(title == null ? '' : title).replace(/^\s*\[[^\]\n]{1,12}\]\s*/, '').trim();
  }

  /* 완료 판정: 댓글 첫 비공백 줄이 `완료:`로 시작하거나, 첫 줄이 '완료' 한 단어(뒤에 . ! 。 하나까지)면 그 글은 완료.
     '완료 여부 확인해줘'처럼 뒤에 다른 말이 붙은 문장, 본문 중간의 '완료:'는 세지 않는다. (2026-11-27 Claude: '완료'만 쓴 점주 댓글 인식) */
  const DONE_LINE_RE = /^\s*완료\s*(?:[:：]|[.!。]?\s*$)/;
  function firstLine(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') return lines[i];
    }
    return '';
  }

  function isDonePost(comments) {
    return (comments || []).some((c) => DONE_LINE_RE.test(firstLine(c.content)));
  }

  /* 미리보기 한 줄 — 마크다운 기호를 띄고 길이를 줄인다. */
  /* 최근 활동 요약용: '결론'·'근거' 같은 소제목만 있는 줄은 건너뛰고 첫 내용 줄을 쓴다 */
  const ACT_HEAD_RE = /^(결론|근거|배경|변경|변경사항|근거\/변경사항|근거·변경사항|다음 할 일|쓰는 법|확인|요약|참고|보완|공유|전달)\s*[:：]?$/;
  function actSummary(text, done) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/```[\s\S]*?```/g, ' ').split('\n');
    for (let i = 0; i < lines.length; i++) {
      let s = lines[i].replace(/[*#>`|~]/g, ' ').replace(/^\s*[-•·]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').replace(/\s+/g, ' ').trim();
      if (!s) continue;
      if (i === 0 && done) { s = s.replace(/^완료\s*[:：]?\s*/, '').replace(/^[.!。]$/, '').trim(); if (!s) continue; }
      if (ACT_HEAD_RE.test(s)) continue;
      return s.replace(/^(결론|요약)\s*[:：]\s*/, '');
    }
    return '';
  }

  function snippet(text, n) {
    const t = String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`|~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > n ? t.slice(0, n - 1).trim() + '…' : t;
  }

  /* 고객·예약 칸 개인정보 마스킹 — 이름·전화번호가 그대로 보이지 않게 한다.
     · 010-1234-5678 → 010-****-5678
     · 홍길동 님 → 홍*동 님 / 남궁민수 님 → 남**수 님 (직함 '고객님·사장님' 등은 건드리지 않음)
     · 예약자/성함/고객명/이름 뒤의 이름 → 첫 글자만 남기고 가림 */
  const ROLE_NIM = ['고객님', '사장님', '선생님', '기사님', '대표님', '원장님', '점장님', '실장님', '팀장님', '부장님', '과장님', '사모님', '어머님', '아버님', '주인님', '형님', '누님', '사장', '고객'];
  function maskNameToken(name) {
    if (name.length <= 2) return name.slice(0, 1) + '*';
    return name.slice(0, 1) + '*'.repeat(name.length - 2) + name.slice(-1);
  }

  function maskNames(s) {
    let out = String(s == null ? '' : s);
    out = out.replace(/(01[016789])[-\s]?(\d{3,4})[-\s]?(\d{4})/g, '$1-****-$3');
    out = out.replace(/([가-힣]{2,4})(?=\s*님)/g, (full) => (ROLE_NIM.includes(full) ? full : maskNameToken(full)));
    out = out.replace(/((?:예약자|성함|고객명|이름)\s*[:：]?\s*)([가-힣]{2,4})/g, (full, head, name) =>
      ROLE_NIM.includes(name) ? full : head + maskNameToken(name));
    return out;
  }

  function maskPII(s) {
    return maskNames(s);
  }

  function catChip(cat) {
    const cls = CAT_CLASS[cat] || 'cat-etc';
    return `<span class="cat-chip ${cls}">${esc(cat || '기타')}</span>`;
  }

  function badge(author) {
    const cls = AUTHOR_CLASS[author] || 'badge-jonghun';
    return `<span class="badge ${cls}">${esc(author || '?')}</span>`;
  }

  function inlineMd(s) {
    return s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  /* 본문 렌더러 — AI들이 쓰는 마크다운 문법을 그대로 살린다.
     지원: 문단·줄바꿈, **굵게**, `코드`, [링크](https://...), - 글머리 목록,
           1. 순서 목록, ### / ## / # 소제목, > 인용구, --- 구분선, ``` 코드블록
     보안: 모든 텍스트는 esc()로 먼저 이스케이프한 뒤 인라인 문법만 적용한다(HTML 주입 불가). */
  function renderBody(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!src.trim()) return '<p class="muted">(내용 없음)</p>';

    const lines = src.split('\n');
    const out = [];
    let para = [];
    let listTag = null;   // 'ul' | 'ol' | null
    let quote = [];       // 인용구에 쌓인 줄

    const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const flushList = () => { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } };
    const flushQuote = () => { if (quote.length) { out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 코드블록 ``` (여는 줄 ~ 닫는 줄, 안쪽은 전부 이스케이프만)
      if (/^\s*```/.test(line)) {
        flushAll();
        const lang = line.replace(/^\s*```\s*/, '').trim().toLowerCase().slice(0, 20);
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        const cls = /^[a-z0-9+#-]+$/.test(lang) ? ` class="lang-${lang}"` : '';
        out.push(`<pre><code${cls}>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // 구분선 ---
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        out.push('<hr>');
        continue;
      }

      // 소제목 # / ## / ### (게시글 제목이 h1이므로 #, ## → h2, ### 이상 → h3)
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        const tag = h[1].length <= 2 ? 'h2' : 'h3';
        const txt = h[2].replace(/\s+#+\s*$/, '').trim();
        out.push(`<${tag}>${inlineMd(esc(txt))}</${tag}>`);
        continue;
      }

      // 인용구 >
      const q = line.match(/^\s*>\s?(.*)$/);
      if (q) {
        flushPara(); flushList();
        quote.push(inlineMd(esc(q[1])));
        continue;
      }

      // 순서 있는 목록 1. / 1)
      const ol = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
      if (ol) {
        flushPara(); flushQuote();
        if (listTag !== 'ol') { flushList(); out.push('<ol>'); listTag = 'ol'; }
        out.push('<li>' + inlineMd(esc(ol[1])) + '</li>');
        continue;
      }

      // 글머리 목록 - * +
      const ul = line.match(/^\s*[-*+]\s+(.+)$/);
      if (ul) {
        flushPara(); flushQuote();
        if (listTag !== 'ul') { flushList(); out.push('<ul>'); listTag = 'ul'; }
        out.push('<li>' + inlineMd(esc(ul[1])) + '</li>');
        continue;
      }

      // 빈 줄
      if (line.trim() === '') {
        flushAll();
        continue;
      }

      // 일반 문단
      flushList(); flushQuote();
      para.push(inlineMd(esc(line)));
    }

    flushAll();
    return out.join('');
  }

  /* ---------- 복사용 텍스트(다른 AI에 붙여넣기) ---------- */
  function boardUrl() {
    return location.origin + location.pathname;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { toast(okMsg); return true; }
      window.prompt('아래 내용을 직접 복사하세요 (Ctrl+C)', text);
      return false;
    }
  }

  function buildPostMd(p, comments, opts) {
    const o = opts || {};
    const out = [];
    out.push(o.heading ? `## [${p.category}] ${p.title}` : `[${p.category}] ${p.title}`);
    const meta = [`작성자 ${p.author}`, fmtFull(p.created_at)];
    if (p.is_pinned) meta.push('📌 고정');
    out.push(meta.join(' · '));
    const flags = [];
    if (p.status) flags.push(`상태 ${p.status}`);
    if (p.priority) flags.push(`중요도 ${p.priority}`);
    if (p.owner) flags.push(`담당 ${p.owner}`);
    if (p.due_date) flags.push(`기한 ${String(p.due_date).slice(0, 10)}${p.status !== '완료' ? ` (${dueLabel(p.due_date)})` : ''}`);
    if (flags.length) out.push(flags.join(' · '));
    out.push(`링크: ${boardUrl()}#/p/${p.id}`);
    out.push('');
    out.push(String(p.content || '').trim() || '(내용 없음)');
    const cs = comments || [];
    if (cs.length) {
      out.push('');
      out.push(`--- 댓글 ${cs.length}건 ---`);
      cs.forEach((c) => {
        const body = String(c.content || '').trim().replace(/\n/g, '\n  ');
        out.push(`- ${c.author} (${fmtFull(c.created_at)}): ${body}`);
      });
    }
    return out.join('\n');
  }

  async function copyPostMd() {
    if (!state.post) return;
    await copyText(buildPostMd(state.post, state.comments), '글과 댓글을 마크다운으로 복사했습니다.');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function syncTopSearch() {
    const el = $('#top-search-input');
    if (!el) return;
    const val = state.view === 'list' ? (state.q || '') : '';
    if (el.value !== val) el.value = val;
  }

  function showScreen(id) {
    ['#screen-login', '#screen-setup', '#screen-denied', '#screen-board'].forEach((s) => {
      $(s).hidden = s !== id;
    });
    $('#topbar-user').hidden = !state.session;
    const writeBtn = $('#btn-write');
    if (writeBtn) writeBtn.hidden = id !== '#screen-board';
    const searchForm = $('#top-search-form');
    if (searchForm) searchForm.hidden = id !== '#screen-board';
    if (!state.session) setMenu(false);
    syncTopSearch();
  }

  function showView(v) {
    state.view = v;
    $('#view-dashboard').hidden = v !== 'dashboard';
    $('#view-list').hidden = v !== 'list';
    $('#view-archive').hidden = v !== 'archive';
    const linesView = $('#view-lines');
    if (linesView) linesView.hidden = v !== 'lines';
    const issView = $('#view-issues');
    if (issView) issView.hidden = v !== 'issues';
    $('#view-detail').hidden = v !== 'detail';
    $('#view-write').hidden = v !== 'write';
    const bar = $('.board-toolbar');
    if (bar) bar.hidden = !(v === 'list' || v === 'archive');
    $('#tabs').hidden = v === 'write';
    if (v === 'archive') {
      $('#board-title').innerHTML = '📚 결산·자료실 <span class="muted">쌓아 두고 다시 보는 자료</span>';
    } else if (v === 'list' && state.loaded) {
      renderBoardTitle();
    }
    buildTabs();
    syncTopSearch();
    window.scrollTo(0, 0);
  }

  /* ---------- 오류 판별 ---------- */
  function errText(err) {
    if (!err) return '';
    return [err.code, err.message, err.details, err.hint].filter(Boolean).join(' | ');
  }

  function isSetupError(err) {
    const code = (err && err.code) || '';
    if (['42P01', '42883', 'PGRST205', 'PGRST202'].includes(code)) return true;
    return /does not exist|schema cache|Could not find the (table|function)|relation .* does not exist/i.test(errText(err));
  }

  function isAuthError(err) {
    const code = (err && err.code) || '';
    const msg = errText(err);
    return code === 'PGRST301' || /JWT expired|invalid JWT|Invalid authentication credentials|jwt/i.test(msg);
  }

  /* ---------- 로그인/멤버십 ---------- */
  function mapAuthError(err) {
    const msg = (err && err.message) || '';
    if (/Invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/Email not confirmed/i.test(msg)) return '이메일 인증이 아직 안 됐습니다. Supabase Authentication → Users에서 이 계정을 확인(Auto Confirm)해 주세요.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
    if (/rate limit|Too many/i.test(msg)) return '로그인 시도가 너무 많습니다. 잠시 뒤에 다시 해 주세요.';
    return msg || '로그인하지 못했습니다.';
  }

  async function checkMembership() {
    const { data, error } = await db.rpc('ai_board_whoami');
    if (error) {
      $('#setup-error-detail').textContent = errText(error);
      showScreen('#screen-setup');
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    state.member = !!(row && row.is_member);
    if (!state.member) {
      const email = (row && row.email) || state.email;
      showDenied(email);
      return false;
    }
    return true;
  }

  function showDenied(email) {
    $('#denied-email').textContent = email || '(이메일 없음)';
    const safe = String(email || '').replace(/'/g, "''");
    $('#denied-sql').textContent =
      `insert into public.ai_board_members (email)\nvalues (lower('${safe}'))\non conflict (email) do nothing;`;
    showScreen('#screen-denied');
  }

  async function enter(session) {
    state.session = session || null;
    if (!session) {
      state.member = false;
      $('#who-email').textContent = '';
      showScreen('#screen-login');
      setTimeout(() => $('#login-email') && $('#login-email').focus(), 60);
      return;
    }
    state.email = session.user && session.user.email ? session.user.email : '';
    $('#who-email').textContent = state.email;
    syncMenu();
    const ok = await checkMembership();
    if (!ok) return;
    showScreen('#screen-board');
    buildTabs();
    fillSelects();
    route();
  }

  /* ---------- 목록 ---------- */
  /* 탭은 두 줄로 나눠 만든다 — 주요 화면(전체 글·결산·자료실) / 말머리.
     2026-11-27: 모바일 390px에서 탭이 넘치지 않도록 주요 화면은 한 줄 고정, 말머리는 3열×2줄.
     2026-11-28: `대시보드` 탭 삭제(브랜드 `예스AI`를 누르면 대시보드) · `📚` 이모지 제거 → 주요 화면 2개. */
  function buildTabs() {
    const listOn = state.view === 'list' && state.category === ALL;
    const archOn = state.view === 'archive';
    const linesOn = state.view === 'lines';
    const issOn = state.view === 'issues';
    const mainParts = [
      `<button type="button" class="tab${listOn ? ' active' : ''}" role="tab" data-nav="all" aria-selected="${listOn}">전체 글</button>`,
      `<button type="button" class="tab tab-arch${archOn ? ' active' : ''}" role="tab" data-nav="archive" aria-selected="${archOn}">결산·자료실</button>`,
      `<button type="button" class="tab tab-lines${linesOn ? ' active' : ''}" role="tab" data-nav="lines" aria-selected="${linesOn}">회선</button>`,
      `<button type="button" class="tab tab-iss${issOn ? ' active' : ''}" role="tab" data-nav="issues" aria-selected="${issOn}">일정</button>`
    ];
    const catParts = CATEGORIES.map((c) => {
      const on = state.view === 'list' && state.category === c;
      return `<button type="button" class="tab${on ? ' active' : ''}" role="tab" data-nav="${esc(c)}" aria-selected="${on}">${esc(c)}</button>`;
    });
    const mainEl = $('#tabs-main');
    const catEl = $('#tabs-cats');
    if (mainEl && catEl) {
      mainEl.innerHTML = mainParts.join('');
      catEl.innerHTML = catParts.join('');
    } else {
      $('#tabs').innerHTML = mainParts.concat(catParts).join('');
    }
  }

  /* 옛 이름(이지실버·예스통신·예스총괄)으로 쓴 글을 수정할 때: 선택지에 그 이름이 없으면
     임시 option을 넣어 값이 지워지거나 다른 이름으로 바뀌지 않게 한다. */
  function ensureAuthorOption(name) {
    if (!name || AUTHORS.includes(name)) return;
    ['#write-author', '#comment-author', '#write-owner'].forEach((sel) => {
      const el = $(sel);
      if (!el || Array.from(el.options).some((o) => o.value === name)) return;
      el.insertAdjacentHTML('beforeend', `<option value="${esc(name)}">${esc(name)} (구 이름)</option>`);
    });
  }

  function fillSelects() {
    const catOpts = CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const authorOpts = AUTHORS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('#write-category').innerHTML = catOpts;
    $('#write-author').innerHTML = authorOpts;
    $('#comment-author').innerHTML = authorOpts;
    $('#write-owner').innerHTML = '<option value="">없음</option>' + authorOpts;
    const saved = preferredAuthor();
    if (saved && AUTHORS.includes(saved)) {
      $('#write-author').value = saved;
      $('#comment-author').value = saved;
    }
  }

  /* ☰ 메뉴 — 로그인 계정 · 기본 작성자 · 로그아웃 (2026-11-28) */
  function setMenu(open) {
    const panel = $('#top-menu');
    const btn = $('#btn-menu');
    if (!panel || !btn) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncMenu() {
    const email = $('#menu-email');
    if (email) email.textContent = state.email || '(계정 없음)';
    const sel = $('#default-author');
    if (!sel) return;
    if (!sel.options.length) {
      sel.innerHTML = '<option value="">설정 안 함 (최근 사용 이름)</option>' +
        AUTHORS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    }
    sel.value = defaultAuthor();
  }

  function sanitizeTerm(t) {
    return String(t || '').trim().replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
  }

  async function loadPosts() {
    const key = `${state.category}|${state.q}|${state.page}`;
    state.listKey = key;
    $('#post-rows').innerHTML = `<tr><td colspan="5" class="empty">불러오는 중…</td></tr>`;
    $('#list-empty').hidden = true;

    let query = db.from('ai_board_posts')
      .select('id,category,author,title,is_pinned,created_at,user_id,status,priority,owner,due_date', { count: 'exact' });
    if (state.category !== ALL) query = query.eq('category', state.category);
    const term = sanitizeTerm(state.q);
    if (term) query = query.or(`title.ilike.*${term}*,content.ilike.*${term}*`);
    query = query
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (state.listKey !== key) return;

    if (error) {
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#setup-error-detail').textContent = errText(error);
        showScreen('#screen-setup');
        return;
      }
      $('#post-rows').innerHTML = '';
      $('#list-empty').hidden = false;
      $('#list-empty').textContent = '목록을 불러오지 못했습니다: ' + (error.message || '알 수 없는 오류');
      return;
    }

    state.posts = data || [];
    state.total = count || 0;
    state.loaded = true;
    state.dirty = false;

    if (state.page > 1 && state.posts.length === 0 && state.total > 0) {
      state.page = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      return loadPosts();
    }

    renderBoardTitle(term);
    const counts = await fetchCommentCounts(state.posts.map((p) => p.id));
    if (state.listKey !== key) return; /* 그새 다른 페이지·검색으로 바뀌었으면 그리지 않는다 (2026-11-28) */

    const rows = state.posts.map((p) => {
      const cmt = counts.get(p.id) || 0;
      return `<tr>
        <td class="col-no"><span class="cell-no">${p.is_pinned ? '📌 ' : ''}${p.id}</span></td>
        <td class="col-cat">${catChip(p.category)}</td>
        <td class="col-title">
          <a class="cell-title" href="#/p/${p.id}">${esc(p.title)}${cmt ? `<span class="cmt">(${cmt})</span>` : ''}</a>${(p.status || p.due_date) ? `<span class="row-flags">${flagChips(p, { noPriority: true })}</span>` : ''}
          <span class="m-meta"><span class="m-meta-left">${p.is_pinned ? '<span class="pinmark">📌</span>' : ''}${catChip(p.category)}${badge(p.author)}${cmt ? `<span class="m-cmt">💬 ${cmt}</span>` : ''}</span><span class="m-date">${fmtShort(p.created_at)}</span></span>
        </td>
        <td class="col-author">${badge(p.author)}</td>
        <td class="col-date">${fmtShort(p.created_at)}</td>
      </tr>`;
    }).join('');

    $('#post-rows').innerHTML = rows;
    $('#list-empty').hidden = state.posts.length > 0;
    if (!state.posts.length) {
      $('#list-empty').textContent = term
        ? `'${term}' 검색 결과가 없습니다.`
        : '글이 없습니다. 첫 글을 남겨 보세요.';
    }
    renderPager();
    buildTabs();
  }

  function renderBoardTitle(term) {
    if (!term) term = sanitizeTerm(state.q);
    const base = state.category === ALL ? '전체 글' : esc(state.category) + ' 글';
    $('#board-title').innerHTML = term
      ? `‘${esc(term)}’ 검색 <b>${state.total}</b>건`
      : `${base} <b>${state.total}</b>`;
  }

  async function fetchCommentCounts(ids) {    const map = new Map();
    if (!ids || !ids.length) return map;
    const { data, error } = await db.from('ai_board_comments').select('post_id').in('post_id', ids);
    if (error) {
      if (isAuthError(error)) forceLogin();
      return map;
    }
    (data || []).forEach((r) => map.set(r.post_id, (map.get(r.post_id) || 0) + 1));
    return map;
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const cur = state.page;
    const pager = $('#pager');
    if (pages <= 1) { pager.innerHTML = ''; return; }

    const nums = [];
    let start = Math.max(1, cur - 2);
    let end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    for (let p = start; p <= end; p++) nums.push(p);

    let html = `<button type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''} aria-label="이전">‹</button>`;
    if (start > 1) {
      html += `<button type="button" data-page="1">1</button>`;
      if (start > 2) html += `<span class="ellipsis">…</span>`;
    }
    html += nums.map((p) => `<button type="button" data-page="${p}" class="${p === cur ? 'active' : ''}">${p}</button>`).join('');
    if (end < pages) {
      if (end < pages - 1) html += `<span class="ellipsis">…</span>`;
      html += `<button type="button" data-page="${pages}">${pages}</button>`;
    }
    html += `<button type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''} aria-label="다음">›</button>`;
    pager.innerHTML = html;
  }

  /* ---------- 대시보드 (#/) ----------
     기존 ai_board_posts · ai_board_comments만으로 프론트에서 계산한다(DB 변경 없음).
     ① 지금 처리할 일 ② 영역별 칸 ③ 확정 기준 보관함 ④ 최근 활동 */
  async function loadDashboard(force) {
    showView('dashboard');
    if (state.dash && !force && !state.dashDirty) {
      renderDashboard();
      return;
    }
    if (!state.dash) {
      $('#dash-todo-list').innerHTML = '';
      $('#dash-todo-empty').hidden = false;
      $('#dash-todo-empty').textContent = '불러오는 중…';
      $('#dash-area-grid').innerHTML = '<div class="dash-loading">불러오는 중…</div>';
      $('#dash-rule-list').innerHTML = '';
      $('#dash-activity-list').innerHTML = '';
    }

    const { data, error } = await db.from('ai_board_posts')
      .select('id,category,author,title,content,is_pinned,created_at,updated_at,status,priority,owner,due_date')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#setup-error-detail').textContent = errText(error);
        showScreen('#screen-setup');
        return;
      }
      $('#dash-area-grid').innerHTML = `<div class="dash-loading">불러오지 못했습니다: ${esc(error.message || '')}</div>`;
      return;
    }

    const posts = data || [];
    let cmts = [];
    const ids = posts.map((p) => p.id);
    if (ids.length) {
      const res = await db.from('ai_board_comments')
        .select('id,post_id,author,content,created_at')
        .in('post_id', ids)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (res.error) {
        if (isAuthError(res.error)) return forceLogin();
      } else {
        cmts = res.data || [];
      }
    }

    state.dash = { posts, cmts, at: new Date() };
    state.dashDirty = false;
    renderDashboard();
  }

  function postCommentsMap() {
    const map = new Map();
    ((state.dash && state.dash.cmts) || []).forEach((c) => {
      if (!map.has(c.post_id)) map.set(c.post_id, []);
      map.get(c.post_id).push(c);
    });
    return map;
  }

  function dashTitle(p) {
    const t = stripTag(p.title);
    return p.category === '고객예약' ? maskPII(t) : t;
  }

  /* 글의 기준 시각 — 작성(created_at)과 수정(updated_at) 중 더 최근 것 */
  function postStamp(p) {
    const c = new Date(p.created_at || 0).getTime() || 0;
    const u = new Date(p.updated_at || 0).getTime() || 0;
    return Math.max(c, u);
  }

  /* ① 주요 · 최신 글 선정 — ③ 확정 기준 보관함에 이미 있는 글(6번 규칙·[공지]·[확정 규칙])은 중복이라 뺀다.
     1순위) 완료되지 않은 중요 글: 중요도 1 · 상태 결정필요/진행 · 제목 [긴급]·[결정필요]·[오류]·[일정]
     2순위) 나머지는 최근 작성·수정 순(완료 글도 자리가 남으면 들어간다). */
  function pickKeyPosts(posts, byPost) {
    const isRulePost = (p) => p.id === RULE_POST_ID || RULE_TAGS.some((t) => String(p.title).includes(t));
    const isDone = (p) => p.status === '완료' || isDonePost(byPost.get(p.id));
    const pool = posts.filter((p) => !isRulePost(p) && p.status !== '보류');

    const important = pool.filter((p) => !isDone(p) && (
      Number(p.priority) === 1 ||
      p.status === '결정필요' || p.status === '진행' ||
      TODO_TAGS.includes(titleTag(p.title))
    ));
    important.sort((a, b) => (Number(a.priority) || 9) - (Number(b.priority) || 9) || postStamp(b) - postStamp(a));

    const newest = pool.slice().sort((a, b) => postStamp(b) - postStamp(a));
    const picked = [];
    const seen = new Set();
    const push = (p) => {
      if (!p || seen.has(p.id) || picked.length >= KEY_POST_LIMIT) return;
      seen.add(p.id);
      picked.push(p);
    };
    important.slice(0, KEY_IMPORTANT_LIMIT).forEach(push);
    newest.forEach(push);
    return picked;
  }

  function renderDashboard() {
    const d = state.dash;
    if (!d) return;
    const posts = d.posts || [];
    const byPost = postCommentsMap();

    /* ① 주요 · 최신 글 — 중요도 높은 미완료 글 먼저 + 최근 작성·수정 글, 최대 5개.
       뽐뿌식 목록 행: 제목 16px + 1px 구분선 + 말머리/작성자/중요도·상태 + 오른쪽 날짜. */
    const keyPosts = pickKeyPosts(posts, byPost);
    $('#dash-todo-count').textContent = String(keyPosts.length);

    $('#dash-todo-list').innerHTML = keyPosts.map((p) => {
      const cc = (byPost.get(p.id) || []).length;
      const done = p.status === '완료' || isDonePost(byPost.get(p.id));
      let mark = '';
      if (!done && Number(p.priority) === 1) mark = '<span class="key-mark">중요</span>';
      else if (!done && p.status) mark = `<span class="flag flag-status ${STATUS_CLASS[p.status] || ''}">${esc(p.status)}</span>`;
      return `<li class="key-item">
        <a class="key-link" href="#/p/${p.id}">
          <span class="key-top">
            <span class="key-title">${esc(dashTitle(p))}</span>
            <span class="key-date">${postStamp(p) ? fmtShort(new Date(postStamp(p)).toISOString()) : ''}</span>
          </span>
          <span class="key-meta">${catChip(p.category)}${badge(p.author)}${mark}${cc ? `<span class="key-cmt">댓글 ${cc}</span>` : ''}</span>
        </a>
      </li>`;
    }).join('');
    $('#dash-todo-list').hidden = keyPosts.length === 0;
    $('#dash-todo-empty').hidden = keyPosts.length > 0;
    $('#dash-todo-empty').textContent = '아직 글이 없습니다.';

    /* ② 영역별 칸
       - 확정 기준 보관함(③)에 들어가는 글(6번 규칙 글, [확정 규칙], [공지])은 영역 칸에서 빼서 중복 표시하지 않는다.
       - 개발·앱 칸은 [배포 공유]·[배포] 글을 앱별(태그 뒤 첫 단어) 최신 1건씩 최대 3개 보여 준다. 배포 글이 없으면 최신 글 1건.
       - 글이 없는 칸은 카드 대신 아래 한 줄로 접는다. */
    const isRulePost = (p) => p.id === RULE_POST_ID || RULE_TAGS.some((t) => String(p.title).includes(t));
    const areaRows = AREA_DEFS.map((a) => {
      const all = posts.filter((p) => p.category === a.key);
      return { a, all, list: all.filter((p) => !isRulePost(p)) };
    });
    const filledAreas = areaRows.filter((r) => r.list.length);
    const emptyAreas = areaRows.filter((r) => !r.list.length);
    const areaItem = (p) => {
      const cc = (byPost.get(p.id) || []).length;
      return `<li><a class="area-item" href="#/p/${p.id}">
          <span class="area-title">${esc(dashTitle(p))}</span>
          <span class="area-meta">${fmtShort(p.created_at)}${cc ? ` · 댓글 ${cc}` : ''}${p.status ? ` · ${esc(p.status)}` : ''}</span>
        </a></li>`;
    };
    const DEPLOY_TAG_RE = /^\s*\[배포( 공유)?\]/;
    const grid = $('#dash-area-grid');
    grid.style.setProperty('--area-cols', String(Math.max(1, filledAreas.length)));
    grid.innerHTML = filledAreas.map(({ a, all, list }) => {
      const extra = AREA_EXTRA_LINK[a.key];
      const head = `<header class="area-head">
          <h3>${esc(a.label)}</h3>
          <span class="area-count">${all.length}</span>
          <span class="area-links">
            ${extra ? `<a href="${esc(extra.href)}" target="_blank" rel="noopener noreferrer">${esc(extra.label)}</a>` : ''}
            <a href="#/c/${encodeURIComponent(a.key)}">전체</a>
          </span>
        </header>`;

      if (a.compact) {
        const seen = new Set();
        const deploys = [];
        list.filter((p) => DEPLOY_TAG_RE.test(String(p.title))).forEach((p) => {
          const app = stripTag(p.title).split(/\s+/)[0] || '';
          if (seen.has(app) || deploys.length >= 3) return;
          seen.add(app);
          deploys.push(p);
        });
        if (deploys.length) {
          return `<section class="area-card ${a.cls} area-compact">${head}
          <p class="area-sub">운영 버전 · 앱별 최신 배포</p>
          <ul class="area-list">${deploys.map(areaItem).join('')}</ul>
        </section>`;
        }
        const p = list[0];
        const cc = (byPost.get(p.id) || []).length;
        return `<section class="area-card ${a.cls} area-compact">${head}
          <a class="area-summary" href="#/p/${p.id}">
            <span class="area-summary-text">${esc(dashTitle(p))}</span>
            <span class="area-meta">${fmtShort(p.created_at)}${cc ? ` · 댓글 ${cc}` : ''}</span>
          </a>
        </section>`;
      }

      return `<section class="area-card ${a.cls}">${head}<ul class="area-list">${list.slice(0, 3).map(areaItem).join('')}</ul></section>`;
    }).join('');

    const emptyEl = $('#dash-area-empty');
    if (emptyEl) {
      emptyEl.hidden = emptyAreas.length === 0;
      emptyEl.innerHTML = emptyAreas.length
        ? '새 글 없음 · ' + emptyAreas.map(({ a, all }) => `<a href="#/c/${encodeURIComponent(a.key)}">${esc(a.label)}</a>${all.length ? ` <span class="area-empty-n">(기준 글 ${all.length})</span>` : ''}`).join(' · ')
        : '';
    }

    /* ③ 확정 기준 보관함 — 6번 규칙 글 + [확정 규칙] · [공지] */
    const rules = posts.filter((p) => p.id === RULE_POST_ID || RULE_TAGS.some((t) => String(p.title).includes(t)));
    rules.sort((a, b) => (a.id === RULE_POST_ID ? -1 : b.id === RULE_POST_ID ? 1 : new Date(b.created_at) - new Date(a.created_at)));
    $('#dash-rules-count').textContent = String(rules.length);
    $('#dash-rule-list').innerHTML = rules.map((p) => {
      const tag = titleTag(p.title);
      const label = p.id === RULE_POST_ID ? '규칙' : (tag ? tag.slice(1, -1) : '기준');
      return `<li class="rule-item"><a class="rule-link" href="#/p/${p.id}">
        <span class="rule-tag">${esc(label)}</span>
        <span class="rule-title">${esc(dashTitle(p))}</span>
        <span class="rule-meta">${esc(p.author || '')} · ${fmtShort(p.created_at)}</span>
      </a></li>`;
    }).join('');
    $('#dash-rules-empty').hidden = rules.length > 0;

    /* ④ 최근 활동 — 글 단위로 묶어서 보여 준다 (2026-11-27 Claude 개선)
       예전: 댓글 첫 줄('결론', '보완:' 등)이 큰 글씨로 나오고 어느 글인지는 작은 회색 줄에만 있어
       무슨 일인지 한눈에 안 보였고, 같은 글이 여러 줄 차지했다.
       지금: 한 줄 = 한 글. 큰 글씨는 글 제목, 아래 줄은 말머리 · 댓글 수 · 마지막 작성자 · 의미 있는 요약.
       지난번 대시보드를 연 뒤 새로 생긴 활동은 왼쪽 파란 점 + 연한 배경으로 표시한다(브라우저별 기억). */
    const ACT_SEEN_KEY = 'yes-ai-board-act-seen';
    if (state.actSeenBase == null) state.actSeenBase = Number(localStorage.getItem(ACT_SEEN_KEY) || 0);
    const seenBase = state.actSeenBase;
    const threadMap = new Map();
    posts.forEach((p) => threadMap.set(p.id, { p, cmts: [], last: p.created_at, personal: p.category === '개인' }));
    ((d.cmts) || []).forEach((c) => {
      const t = threadMap.get(c.post_id);
      if (!t) return;
      t.cmts.push(c);
      if (new Date(c.created_at) > new Date(t.last)) t.last = c.created_at;
    });
    const threads = [...threadMap.values()].sort((a, b) => new Date(b.last) - new Date(a.last));
    const main = threads.filter((t) => !t.personal).slice(0, 8);
    const personal = threads.filter((t) => t.personal).slice(0, 5);
    const newest = threads.reduce((m, t) => Math.max(m, new Date(t.last).getTime() || 0), 0);
    if (newest) localStorage.setItem(ACT_SEEN_KEY, String(newest));

    const actHtml = (t) => {
      /* 요약 줄 마스킹: 고객예약은 이름·전화번호, 그 외 말머리는 전화번호만 */
      const mask = (s) => (t.p.category === '고객예약' ? maskPII(s) : String(s).replace(/(01[016789])[-. ]?(\d{3,4})[-. ]?(\d{4})/g, '$1-****-$3'));
      const lastMs = new Date(t.last).getTime();
      const isNew = seenBase > 0 && lastMs > seenBase;
      const postIsNew = seenBase > 0 ? new Date(t.p.created_at).getTime() > seenBase : t.cmts.length === 0;
      const cm = t.cmts.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const lastC = cm[cm.length - 1];
      let sub = catChip(t.p.category);
      if (postIsNew || !lastC) sub += `<span class="act-kind act-post">새 글</span>${badge(t.p.author)}`;
      if (lastC) {
        const done = DONE_LINE_RE.test(firstLine(lastC.content));
        const summ = actSummary(lastC.content, done);
        sub += `<span class="act-count">댓글 ${cm.length}</span>${badge(lastC.author || '?')}`;
        if (done) sub += '<span class="act-done">✓ 완료</span>';
        if (summ) sub += `<span class="act-snip">${esc(snippet(mask(summ), 70))}</span>`;
      }
      return `<li class="act-item${isNew ? ' is-new' : ''}">
        <a class="act-link" href="#/p/${t.p.id}">
          <span class="act-top"><span class="act-dot" aria-hidden="true"></span><span class="act-title">${esc(dashTitle(t.p))}</span><span class="act-time">${fmtShort(t.last)}</span></span>
          <span class="act-sub">${sub}</span>
        </a>
      </li>`;
    };

    $('#dash-activity-list').innerHTML = main.map(actHtml).join('') || '<li class="act-empty">활동이 없습니다.</li>';
    $('#dash-personal-list').innerHTML = personal.map(actHtml).join('');
    const pw = $('#dash-personal-wrap');
    const pt = $('#dash-personal-toggle');
    pw.hidden = personal.length === 0;
    $('#dash-personal-list').hidden = !state.personalOpen;
    pt.setAttribute('aria-expanded', String(!!state.personalOpen));
    pt.textContent = `${state.personalOpen ? '접기' : '개인 활동 보기'} (${personal.length}건)`;

    $('#dash-foot-text').textContent = `기준 ${fmtFull(d.at.toISOString())} · 글 ${posts.length}건 · 댓글 ${d.cmts.length}건`;
  }

  /* ---------- 결산·자료실 (#/archive) ----------
     누적성 자료만 골라 월별로 모아 보여 준다. 판정 기준(2026-11-27 종훈 님 요청):
     ① 말머리 `결산·자료` 또는 `세무·정산` ② 제목에 [매입기록]·[결산]·[자료]·[시세]·고정 기준 등이 들어간 글. */
  function isArchivePost(p) {
    if (!p) return false;
    const title = String(p.title || '');
    if (p.category === '결산·자료' || p.category === '세무·정산') return true;
    if (ARCHIVE_SKIP_RE.test(title)) return false;
    return ARCHIVE_TITLE_RE.test(title);
  }

  function archKindsOf(p) {
    const t = String(p.title || '');
    const keys = ARCH_KINDS.filter((k) => k.re.test(t)).map((k) => k.key);
    if (!keys.length) keys.push('tax');   // 분류 낱말이 없는 결산·자료 글은 결산·세무로 본다
    return keys;
  }

  /* 서브 탭 두 개(자료 · 결산 글 / 완료 기록) 중 어느 쪽을 보여 줄지 — 2026-11-28 */
  function applyArchTab() {
    const tab = state.archTab === 'history' ? 'history' : 'data';
    $$('#arch-modes button').forEach((b) => {
      const on = b.dataset.archMode === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const dataPane = $('#arch-pane-data');
    const histPane = $('#arch-pane-history');
    if (dataPane) dataPane.hidden = tab !== 'data';
    if (histPane) histPane.hidden = tab !== 'history';
    const dataN = $('#arch-mode-data-n');
    if (dataN) dataN.textContent = state.arch ? String(state.arch.posts ? state.arch.posts.length : 0) : '…';
    const histN = $('#arch-mode-hist-n');
    if (histN) histN.textContent = state.issues ? String(issueStats().done) : '…';
    const issN = $('#iss-hist-n');
    if (issN) issN.textContent = String(issueStats().done);
  }

  async function loadArchive(force) {
    showView('archive');
    applyArchTab(); /* 딥링크(?tab=history)로 들어와도 자료 탭이 잠깐 보이지 않게 바로 전환 (2026-11-28) */
    const needPosts = !!force || !state.arch || state.archDirty;
    const needIssues = !!force || !state.issues || state.issuesDirty;
    if (!needPosts && !needIssues) { renderArchive(); return; }
    if (!state.arch) {
      $('#arch-list').hidden = false;
      $('#arch-list').innerHTML = '<div class="dash-loading">불러오는 중…</div>';
      $('#arch-empty').hidden = true;
    }
    if (needIssues && !state.issues) {
      const hbox = $('#arch-history-list');
      if (hbox) hbox.innerHTML = '<div class="dash-loading">불러오는 중…</div>';
      const hempty = $('#arch-history-empty');
      if (hempty) hempty.hidden = true;
    }

    const [postRes, issRes] = await Promise.all([
      needPosts ? db.from('ai_board_posts')
        .select('id,category,author,title,is_pinned,created_at,status,priority,owner,due_date')
        .order('created_at', { ascending: false })
        .limit(1000) : Promise.resolve(null),
      needIssues ? db.from('issues').select('*').order('created_at', { ascending: false }) : Promise.resolve(null)
    ]);

    if (postRes) {
      const { data, error } = postRes;
      if (error) {
        if (isAuthError(error)) return forceLogin();
        if (isSetupError(error)) {
          $('#setup-error-detail').textContent = errText(error);
          showScreen('#screen-setup');
          return;
        }
        $('#arch-list').innerHTML = `<div class="dash-loading">불러오지 못했습니다: ${esc(error.message || '')}</div>`;
      } else {
        const posts = (data || []).filter(isArchivePost);
        const counts = await fetchCommentCounts(posts.map((p) => p.id));
        state.arch = { posts, counts, at: new Date() };
        state.archDirty = false;
      }
    }

    if (issRes) {
      const { data, error } = issRes;
      if (error) {
        if (isAuthError(error)) return forceLogin();
        const msg = (error.code === '42501' || error.code === 'PGRST301')
          ? '완료 기록을 볼 권한이 없습니다. (Supabase RLS)'
          : (error.message || String(error));
        $('#arch-history-list').innerHTML = `<div class="dash-loading">불러오지 못했습니다: ${esc(msg)}</div>`;
      } else {
        state.issues = { list: data || [], at: new Date() };
        state.issuesDirty = false;
      }
    }

    renderArchive();
  }

  function renderArchive() {
    applyArchTab();
    const a = state.arch;
    if (!a) return;
    const posts = a.posts || [];
    const counts = a.counts || new Map();
    const filter = state.archFilter || 'all';
    const countFor = (key) => (key === 'all' ? posts.length : posts.filter((p) => archKindsOf(p).includes(key)).length);

    $$('#arch-filters .arch-filter').forEach((b) => {
      const on = b.dataset.arch === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      const n = $('.arch-n', b);
      if (n) n.textContent = String(countFor(b.dataset.arch));
    });

    const list = posts.filter((p) => filter === 'all' || archKindsOf(p).includes(filter));
    const groups = new Map();
    list.forEach((p) => {
      const d = new Date(p.created_at);
      const key = isNaN(d) ? '날짜 없음' : `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });

    const kindOf = (p) => {
      const keys = archKindsOf(p);
      return ARCH_KINDS.find((k) => k.key === keys[0]) || ARCH_KINDS[0];
    };

    $('#arch-list').innerHTML = [...groups.entries()].map(([month, arr]) => `
      <section class="arch-group">
        <h3 class="arch-month">${esc(month)}<span class="arch-month-n">${arr.length}건</span></h3>
        <ul class="arch-rows">${arr.map((p) => {
          const k = kindOf(p);
          const cc = counts.get(p.id) || 0;
          const title = p.category === '고객예약' ? maskPII(p.title) : p.title;
          return `<li class="arch-item"><a class="arch-link" href="#/p/${p.id}">
            <span class="arch-kind kind-${k.key}">${esc(k.short)}</span>
            <span class="arch-title">${p.is_pinned ? '📌 ' : ''}${esc(title)}</span>
            <span class="arch-meta"><span class="arch-meta-l">${catChip(p.category)}${badge(p.author)}${cc ? `<span class="arch-cmt">💬 ${cc}</span>` : ''}${flagChips(p, { noOwner: true, noPriority: true })}</span><span class="arch-meta-r">${fmtShort(p.created_at)}</span></span>
          </a></li>`;
        }).join('')}</ul>
      </section>`).join('');

    $('#arch-list').hidden = list.length === 0;
    $('#arch-empty').hidden = list.length > 0;
    const foot = $('#arch-foot');
    if (foot) foot.textContent = `기준 ${fmtFull(a.at.toISOString())} · 누적 자료 ${posts.length}건 · 지금 보기 ${list.length}건`;
    renderIssueHistory();
  }

  /* ---------- 회선 관리 (#/lines) — 2026-11-28 러버블 yescom-game-hq /lines 통합 ----------
     테이블(실측): lines 30컬럼 · line_addons 11컬럼(line_id FK, user_id 없음). 부가서비스는 별도 테이블. */
  const LINE_TYPES = ['약정', '가개통'];
  const LINE_GROUPS = ['SK', 'KT', 'LG', '알뜰'];
  const LINE_GROUP_LABEL = { SK: 'SKT', KT: 'KT', LG: 'LGU+' };
  const LINE_FILTERS = ['전체', '약정', '가개통', '완료'];

  const digitsOnly = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

  function fmtPhone(v) {
    const d = digitsOnly(v);
    if (!d) return '';
    if (d.startsWith('02')) {
      if (d.length <= 2) return d;
      if (d.length <= 5) return `02-${d.slice(2)}`;
      if (d.length <= 9) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
      return `02-${d.slice(2, 6)}-${d.slice(6, 10)}`;
    }
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 11)}`;
  }

  function won(n) {
    const v = Number(n || 0);
    return `${(Number.isFinite(v) ? v : 0).toLocaleString('ko-KR')}원`;
  }

  function ymdDate(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function todayYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function daysUntil(s) {
    const d = ymdDate(s);
    const t = ymdDate(todayYmd());
    if (!d || !t) return null;
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }
  function addDaysYmd(s, n) {
    const d = ymdDate(s);
    const num = Number(n);
    if (!d || !Number.isFinite(num)) return null;
    d.setDate(d.getDate() + num);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtDot(s) {
    const d = ymdDate(s);
    return d ? `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}` : '';
  }
  function ddayText(diff) {
    if (diff == null) return '';
    return diff < 0 ? `${-diff}일 지남` : diff === 0 ? '오늘' : `D-${diff}`;
  }
  function ddayClass(diff) {
    if (diff == null) return '';
    if (diff < 0 || diff === 0) return 'is-urgent';
    return diff <= 7 ? 'is-soon' : '';
  }

  /* --- 회선 데이터 헬퍼 --- */
  function lineStore() {
    return state.lines || { lines: [], addons: [], at: null };
  }
  function lineById(id) {
    return lineStore().lines.find((l) => String(l.id) === String(id)) || null;
  }
  function lineActiveAddons(lineId) {
    return lineStore().addons.filter((a) => String(a.line_id) === String(lineId) && a.is_active && !a.removed_at);
  }
  function lineRemovedAddons(lineId) {
    return lineStore().addons.filter((a) => String(a.line_id) === String(lineId) && (!a.is_active || a.removed_at));
  }
  function lineAddonFee(lineId) {
    return lineActiveAddons(lineId).reduce((s, a) => s + (Number(a.monthly_fee) || 0), 0);
  }
  function lineTotalFee(l) {
    return (Number(l.monthly_fee) || 0) + lineAddonFee(l.id);
  }
  function lineIsDone(l) {
    return !l.is_active || l.status === '완료';
  }
  function lineStatusLabel(l) {
    if (lineIsDone(l)) return '완료';
    return l.line_type === '약정' ? '유지중' : '진행중';
  }
  /* 다음에 챙길 날짜 하나 — 가개통은 요금제 변경·부가 삭제·유지 마감 중 가장 급한 것 */
  function lineNextDate(l) {
    const out = [];
    if (l.line_type === '약정') {
      if (l.contract_end_date) out.push({ label: '만기', date: l.contract_end_date, diff: daysUntil(l.contract_end_date) });
    } else {
      if (l.plan_change_available_date && !l.plan_changed_at) {
        out.push({ label: '요금제 변경', date: l.plan_change_available_date, diff: daysUntil(l.plan_change_available_date) });
      }
      lineActiveAddons(l.id).forEach((a) => {
        if (a.removable_date) out.push({ label: `${a.addon_name} 삭제`, date: a.removable_date, diff: daysUntil(a.removable_date) });
      });
      if (l.maintenance_end_date) {
        const d = daysUntil(l.maintenance_end_date);
        out.push({ label: d != null && d < 0 ? '회선 유지기간 경과' : '회선 유지 마감', date: l.maintenance_end_date, diff: d });
      }
    }
    const list = out.filter((x) => x.diff != null);
    if (!list.length) return null;
    list.sort((a, b) => {
      const ra = a.diff < 0 ? 0 : 1;
      const rb = b.diff < 0 ? 0 : 1;
      return ra === rb ? a.diff - b.diff : ra - rb;
    });
    return list[0];
  }

  /* --- 모달 공통 --- */
  function anyModalOpen() {
    return $$('.ln-modal').some((m) => !m.hidden);
  }
  function openModal(sel) {
    const m = $(sel);
    if (!m) return;
    m.hidden = false;
    document.body.classList.add('modal-open');
  }
  function closeModal(sel) {
    const m = $(sel);
    if (m) m.hidden = true;
    if (!anyModalOpen()) document.body.classList.remove('modal-open');
    if (!anyModalOpen()) state.lineOpenId = null;
  }
  function closeAllModals() {
    $$('.ln-modal').forEach((m) => { m.hidden = true; });
    document.body.classList.remove('modal-open');
    state.lineOpenId = null;
  }

  /* --- 불러오기 --- */
  function lineLoadError(error) {
    if (!error) return '알 수 없는 오류';
    if (error.code === '42501' || error.code === 'PGRST301') return '회선 데이터에 접근할 권한이 없습니다. (Supabase RLS)';
    return error.message || String(error);
  }

  async function loadLines(force) {
    showView('lines');
    if (state.lines && !force && !state.linesDirty) { renderLines(); return; }
    if (!state.lines) {
      $('#ln-list').innerHTML = '<li class="ln-loading">불러오는 중…</li>';
      $('#ln-list').hidden = false;
      $('#ln-empty').hidden = true;
    }

    const [resL, resA] = await Promise.all([
      db.from('lines').select('*').order('created_at', { ascending: false }),
      db.from('line_addons').select('*').order('created_at', { ascending: false })
    ]);

    if (resL.error || resA.error) {
      const error = resL.error || resA.error;
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#ln-list').innerHTML = '<li class="ln-loading">회선 테이블(`lines`)이 아직 없습니다. Supabase에 러버블 회선관리 스키마가 있는지 확인해 주세요.</li>';
        return;
      }
      $('#ln-list').innerHTML = `<li class="ln-loading">회선을 불러오지 못했습니다: ${esc(lineLoadError(error))}</li>`;
      return;
    }

    state.lines = { lines: resL.data || [], addons: resA.data || [], at: new Date() };
    state.linesDirty = false;
    renderLines();
  }

  /* --- 목록 --- */
  function lineSummary() {
    const all = lineStore().lines;
    const active = all.filter((l) => !lineIsDone(l));
    const ids = new Set(active.map((l) => String(l.id)));
    const lineFee = active.reduce((s, l) => s + (Number(l.monthly_fee) || 0), 0);
    const addonFee = lineStore().addons
      .filter((a) => a.is_active && !a.removed_at && ids.has(String(a.line_id)))
      .reduce((s, a) => s + (Number(a.monthly_fee) || 0), 0);
    const within30 = active.filter((l) => {
      const n = lineNextDate(l);
      return !!(n && n.diff >= 0 && n.diff <= 30);
    }).length;
    return {
      active: active.length,
      contract: active.filter((l) => l.line_type === '약정').length,
      prepaid: active.filter((l) => l.line_type === '가개통').length,
      done: all.length - active.length,
      within30,
      lineFee,
      addonFee,
      total: lineFee + addonFee
    };
  }

  function linesForFilter() {
    const all = lineStore().lines;
    const active = all.filter((l) => !lineIsDone(l));
    const f = state.linesFilter || '전체';
    const list = f === '완료' ? all.filter((l) => lineIsDone(l))
      : f === '약정' ? active.filter((l) => l.line_type === '약정')
        : f === '가개통' ? active.filter((l) => l.line_type === '가개통')
          : active;
    return [...list].sort((a, b) => {
      const na = lineNextDate(a);
      const nb = lineNextDate(b);
      const rank = (l, n) => (n && n.diff < 0 ? 0 : n ? 1 : l.line_type === '약정' && l.contract_end_date ? 2 : 3);
      const ra = rank(a, na);
      const rb = rank(b, nb);
      if (ra !== rb) return ra - rb;
      if (na && nb && na.diff !== nb.diff) return na.diff - nb.diff;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  }

  function lineItemHtml(l) {
    const next = lineNextDate(l);
    const done = lineIsDone(l);
    const cls = done || !next ? '' : ddayClass(next.diff);
    const owner = l.owner_name || l.name || '회선';
    const phone = fmtPhone(l.phone_number);
    const provider = [l.provider_name || l.provider_group, l.network_provider ? `${l.network_provider}망` : ''].filter(Boolean).join(' · ');
    const sub = [l.name && l.name !== owner ? l.name : '', provider].filter(Boolean).join(' · ');
    const dates = [];
    if (l.line_type === '가개통') {
      if (l.plan_change_available_date) {
        dates.push({
          label: l.plan_changed_at ? '요금제 변경 완료' : '요금제 변경',
          date: l.plan_change_available_date,
          diff: l.plan_changed_at ? null : daysUntil(l.plan_change_available_date)
        });
      }
      if (l.maintenance_end_date) dates.push({ label: '유지 마감', date: l.maintenance_end_date, diff: daysUntil(l.maintenance_end_date) });
    } else if (l.contract_end_date) {
      dates.push({ label: '만기', date: l.contract_end_date, diff: daysUntil(l.contract_end_date) });
    }
    const fee = lineTotalFee(l);
    const addonFee = lineAddonFee(l.id);
    const badge = done ? '<span class="ln-dday">완료</span>' : next ? `<span class="ln-dday ${ddayClass(next.diff)}">${esc(ddayText(next.diff))}</span>` : '';
    return `<li class="ln-item ${cls}" data-ln-open="${esc(l.id)}" tabindex="0" role="button">
      <div class="ln-item-top">
        <span class="ln-kind">${esc(l.line_type)} · ${esc(lineStatusLabel(l))}</span>
        ${badge}
      </div>
      <h3 class="ln-name">${esc(owner)}${phone ? `<span class="ln-phone">${esc(phone)}</span>` : ''}</h3>
      ${sub ? `<div class="ln-sub">${esc(sub)}</div>` : ''}
      ${dates.length ? `<div class="ln-dates">${dates.slice(0, 2).map((d) => `<span class="ln-date ${d.diff != null ? ddayClass(d.diff) : ''}">${esc(d.label)} ${esc(fmtDot(d.date))}</span>`).join('')}</div>` : ''}
      <div class="ln-fee">월 ${esc(won(fee))}${addonFee ? `<span class="ln-fee-sub">회선 ${esc(won(l.monthly_fee))} + 부가 ${esc(won(addonFee))}</span>` : ''}</div>
    </li>`;
  }

  function renderLines() {
    const s = lineSummary();
    $('#ln-sum-active').textContent = String(s.active);
    $('#ln-sum-contract').textContent = String(s.contract);
    $('#ln-sum-prepaid').textContent = String(s.prepaid);
    $('#ln-sum-soon').textContent = String(s.within30);
    $('#ln-sum-total').textContent = won(s.total);
    $('#ln-sum-split').textContent = `회선 ${won(s.lineFee)} · 부가 ${won(s.addonFee)}`;

    const counts = { '전체': s.active, '약정': s.contract, '가개통': s.prepaid, '완료': s.done };
    $$('#ln-filters .ln-filter').forEach((b) => {
      const key = b.dataset.lnFilter;
      const on = key === (state.linesFilter || '전체');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      const n = $('.ln-n', b);
      if (n) n.textContent = String(counts[key] || 0);
    });

    const list = linesForFilter();
    const ul = $('#ln-list');
    ul.innerHTML = list.map(lineItemHtml).join('');
    ul.hidden = list.length === 0;
    $('#ln-empty').hidden = list.length > 0;
    const foot = $('#ln-foot');
    if (foot) {
      foot.textContent = state.lines && state.lines.at
        ? `기준 ${fmtFull(state.lines.at.toISOString())} · 활성 ${s.active}건 · 완료 ${s.done}건`
        : '';
    }
  }

  /* --- 상세 --- */
  function lnRow(k, v, cls) {
    if (v == null || v === '') return '';
    return `<div class="ln-row"><span class="ln-k">${esc(k)}</span><span class="ln-v ${cls || ''}">${v}</span></div>`;
  }

  function openLineDetail(id) {
    const l = lineById(id);
    if (!l) return;
    state.lineOpenId = String(id);
    renderLineDetail();
    openModal('#line-modal');
  }

  function renderLineDetail() {
    const l = lineById(state.lineOpenId);
    if (!l) { closeAllModals(); return; }
    const done = lineIsDone(l);
    const addons = lineActiveAddons(l.id);
    const removed = lineRemovedAddons(l.id);
    const addonFee = lineAddonFee(l.id);
    const phone = fmtPhone(l.phone_number);
    const provider = [l.provider_name || l.provider_group, l.network_provider ? `${l.network_provider}망` : ''].filter(Boolean).join(' · ');
    const next = lineNextDate(l);
    const secs = [];

    /* 기본정보 */
    const basics = [
      lnRow('이름', l.owner_name ? esc(l.owner_name) : ''),
      lnRow('전화번호', phone ? esc(phone) : ''),
      lnRow('관리명', l.name ? esc(l.name) : ''),
      lnRow('통신사', provider ? esc(provider) : ''),
      lnRow('관리 장소', l.line_type === '약정' && l.owner_location ? esc(l.owner_location) : ''),
      lnRow('상품', l.line_type === '약정' && l.product ? esc(l.product) : '')
    ].join('');
    secs.push(`<div class="ln-sec"><div class="ln-sec-t">기본정보</div>${basics || '<div class="ln-row"><span class="ln-k">등록된 정보가 없습니다</span></div>'}</div>`);

    /* 금액 */
    const money = [
      lnRow('월 회선요금', esc(won(l.monthly_fee)), 'money'),
      lnRow('월 부가서비스', esc(won(addonFee)), 'money'),
      lnRow('월 총유지비', esc(won(lineTotalFee(l))), 'strong money'),
      l.benefit_amount != null ? lnRow('혜택·수수료', esc(won(l.benefit_amount)), 'money') : '',
      l.benefit_note ? lnRow('혜택 설명', esc(l.benefit_note)) : ''
    ].join('');
    secs.push(`<div class="ln-sec"><div class="ln-sec-t">금액</div>${money}</div>`);

    /* 주요 날짜 */
    const dates = [];
    if (l.line_type === '약정') {
      if (l.activation_date) dates.push(lnRow('계약 시작일', esc(fmtDot(l.activation_date))));
      if (l.contract_end_date) {
        const d = daysUntil(l.contract_end_date);
        dates.push(lnRow('약정 만기일', `${esc(fmtDot(l.contract_end_date))} <span class="ln-dday ${ddayClass(d)}">${esc(ddayText(d))}</span>`));
      }
    } else {
      if (l.activation_date) {
        dates.push(lnRow('개통일', esc(fmtDot(l.activation_date))));
        const elapsed = daysUntil(l.activation_date);
        const used = elapsed == null ? null : -elapsed;
        const goal = l.maintenance_days == null ? null : Number(l.maintenance_days);
        if (used != null && used >= 0) {
          let main = `${used}일`;
          let sub = '';
          if (goal && goal > 0) {
            main = `${used}일 / ${goal}일`;
            sub = used < goal ? `잔여 ${goal - used}일` : used === goal ? '오늘 유지 완료' : `${used - goal}일 경과`;
          }
          dates.push(lnRow('오늘까지 사용', `${esc(main)}${sub ? `<span class="ln-sub2"> · ${esc(sub)}</span>` : ''}`));
        }
      }
      if (l.opening_plan) dates.push(lnRow('개통요금제', esc(l.opening_plan)));
      if (l.plan_change_available_date) {
        const d = daysUntil(l.plan_change_available_date);
        dates.push(lnRow('요금제 변경 가능일', `${esc(fmtDot(l.plan_change_available_date))}${l.plan_changed_at ? '' : ` <span class="ln-dday ${ddayClass(d)}">${esc(ddayText(d))}</span>`}`));
      }
      if (l.plan_changed_at) dates.push(lnRow('요금제 변경 완료일', esc(fmtDot(l.plan_changed_at))));
      if (l.maintenance_end_date) {
        const d = daysUntil(l.maintenance_end_date);
        dates.push(lnRow('회선 유지 마감일', `${esc(fmtDot(l.maintenance_end_date))} <span class="ln-dday ${ddayClass(d)}">${esc(ddayText(d))}</span>`));
      }
      if (l.maintenance_days) dates.push(lnRow('회선 유지일수', `${esc(String(l.maintenance_days))}일`));
    }
    secs.push(`<div class="ln-sec"><div class="ln-sec-t">주요 날짜${next ? `<span class="ln-next ${ddayClass(next.diff)}">${esc(next.label)} ${esc(ddayText(next.diff))}</span>` : ''}</div>${dates.join('') || '<div class="ln-row"><span class="ln-k">등록된 날짜가 없습니다</span></div>'}</div>`);

    /* 요금제 변경 완료 버튼 */
    if (!done && l.line_type === '가개통' && l.plan_change_available_date && !l.plan_changed_at) {
      secs.push(`<button type="button" class="ln-btn ok ln-wide" data-ln-plan-change="${esc(l.id)}">요금제 변경 완료</button>`);
    }

    /* 부가서비스 */
    const addonRows = addons.length
      ? addons.map((a) => {
        const d = daysUntil(a.removable_date);
        return `<div class="ln-addon">
          <div class="ln-addon-top">
            <span class="ln-addon-name">${esc(a.addon_name)}</span>
            ${a.removable_date ? `<span class="ln-dday ${ddayClass(d)}">${esc(ddayText(d))}</span>` : ''}
          </div>
          <div class="ln-addon-meta">월 ${esc(won(a.monthly_fee))}${a.removable_date ? ` · 삭제가능 ${esc(fmtDot(a.removable_date))}` : ''}${a.joined_date ? ` · 가입 ${esc(fmtDot(a.joined_date))}` : ''}</div>
          ${a.memo ? `<div class="ln-addon-meta">${esc(a.memo)}</div>` : ''}
          <div class="ln-addon-btns">
            <button type="button" class="ln-btn" data-ln-addon-edit="${esc(a.id)}">수정</button>
            <button type="button" class="ln-btn ok" data-ln-addon-remove="${esc(a.id)}">삭제 완료</button>
          </div>
        </div>`;
      }).join('')
      : '<div class="ln-row"><span class="ln-k">등록된 부가서비스가 없습니다</span></div>';
    const removedBlock = removed.length
      ? `<details class="ln-removed"><summary>삭제 완료 기록 (${removed.length})</summary><ul>${removed.map((a) => `<li>${esc(a.addon_name)} · ${esc(won(a.monthly_fee))}${a.removed_at ? ` · 삭제 ${esc(fmtDot(a.removed_at))}` : ''}</li>`).join('')}</ul></details>`
      : '';
    secs.push(`<div class="ln-sec"><div class="ln-sec-t">부가서비스${done ? '' : `<button type="button" class="ln-btn blue ln-btn-xs" data-ln-addon-add="${esc(l.id)}">+ 추가</button>`}</div>${addonRows}${removedBlock}</div>`);

    /* 메모 */
    if (l.memo) secs.push(`<div class="ln-sec"><div class="ln-sec-t">메모</div><div class="ln-v ln-memo">${esc(l.memo)}</div></div>`);
    if (done && l.result_note) secs.push(`<div class="ln-sec"><div class="ln-sec-t">처리결과</div><div class="ln-v ln-memo">${esc(l.result_note)}</div></div>`);

    const head = `<div class="ln-sheet-head">
      <div>
        <h2 class="ln-sheet-title" id="ln-detail-title">${esc(l.owner_name || l.name || '회선')}${phone ? ` <span class="ln-phone">${esc(phone)}</span>` : ''}</h2>
        <p class="ln-sheet-sub">${esc(l.line_type)} · ${esc(lineStatusLabel(l))}${provider ? ` · ${esc(provider)}` : ''}${done ? ` · 종료 ${esc(fmtDot(l.completed_at || l.updated_at))}` : ''}</p>
      </div>
      <button type="button" class="ln-x" data-ln-close aria-label="닫기">×</button>
    </div>`;

    const foot = `<div class="ln-sheet-foot">
      <button type="button" class="ln-btn" data-ln-close>닫기</button>
      ${done ? '' : `<button type="button" class="ln-btn" data-ln-edit="${esc(l.id)}">수정</button>
      <button type="button" class="ln-btn warn" data-ln-complete="${esc(l.id)}">종료 처리</button>`}
    </div>`;

    $('#ln-detail-sheet').innerHTML = head + secs.join('') + foot;
  }

  /* --- 등록·수정 폼 --- */
  function segSet(sel, value) {
    $$(sel + ' button').forEach((b) => {
      const on = (b.dataset.lnType || b.dataset.lnGroup || b.dataset.lnNet) === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function lineFormType() { const f = $('#line-form'); return (f && f.dataset.type) || '약정'; }
  function lineFormGroup() { const f = $('#line-form'); return (f && f.dataset.group) || ''; }
  function lineFormNet() { const f = $('#line-form'); return (f && f.dataset.net) || ''; }

  function applyLineFormType(type) {
    const f = $('#line-form');
    if (!f) return;
    f.dataset.type = type;
    segSet('#ln-f-types', type);
    $$('#line-form [data-ln-only]').forEach((el) => { el.hidden = el.dataset.lnOnly !== type; });
    $('#ln-f-act-label').textContent = type === '약정' ? '계약 시작일' : '개통일';
    $('#ln-f-phone-req').textContent = type === '가개통' ? '*' : '(약정은 비워도 됨)';
    $('#ln-f-remind').placeholder = type === '약정' ? '기본 90' : '기본 30';
    syncMaintenance();
  }

  function syncMaintenance() {
    const daysEl = $('#ln-f-days');
    const actEl = $('#ln-f-act');
    const endEl = $('#ln-f-maint');
    if (!daysEl || !actEl || !endEl) return;
    const days = Number(digitsOnly(daysEl.value));
    if (days > 0 && actEl.value) {
      endEl.value = addDaysYmd(actEl.value, days - 1) || '';
      endEl.setAttribute('readonly', 'readonly');
    } else {
      endEl.removeAttribute('readonly');
    }
  }

  function showLineFormError(msg) {
    const el = $('#ln-form-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  function openLineForm(id) {
    const l = id ? lineById(id) : null;
    state.lineFormId = l ? String(l.id) : null;
    $('#line-form-title').textContent = l ? '회선 수정' : '새 회선';
    const type = l ? l.line_type : '약정';
    const f = $('#line-form');
    f.dataset.group = (l && l.provider_group) || '';
    f.dataset.net = (l && l.network_provider) || '';
    applyLineFormType(type);
    segSet('#ln-f-groups', f.dataset.group);
    segSet('#ln-f-nets', f.dataset.net);
    $('#ln-f-net-wrap').hidden = f.dataset.group !== '알뜰';

    $('#ln-f-owner').value = (l && l.owner_name) || '';
    $('#ln-f-phone').value = fmtPhone((l && l.phone_number) || '');
    $('#ln-f-name').value = (l && l.name) || '';
    $('#ln-f-provider').value = (l && l.provider_name) || '';
    $('#ln-f-fee').value = l && l.monthly_fee != null ? Number(l.monthly_fee).toLocaleString('ko-KR') : '';
    $('#ln-f-remind').value = l && l.reminder_days != null ? String(l.reminder_days) : (type === '약정' ? '90' : '30');
    $('#ln-f-act').value = (l && l.activation_date) || '';
    $('#ln-f-end').value = (l && l.contract_end_date) || '';
    $('#ln-f-loc').value = (l && l.owner_location) || '';
    $('#ln-f-product').value = (l && l.product) || '';
    $('#ln-f-plan').value = (l && l.opening_plan) || '';
    $('#ln-f-change').value = (l && l.plan_change_available_date) || '';
    $('#ln-f-days').value = l && l.maintenance_days != null ? String(l.maintenance_days) : '';
    $('#ln-f-maint').value = (l && l.maintenance_end_date) || '';
    $('#ln-f-benefit').value = l && l.benefit_amount != null ? Number(l.benefit_amount).toLocaleString('ko-KR') : '';
    $('#ln-f-benefitnote').value = (l && l.benefit_note) || '';
    $('#ln-f-memo').value = (l && l.memo) || '';
    showLineFormError('');
    syncMaintenance();
    openModal('#line-form-modal');
    setTimeout(() => { const el = $('#ln-f-owner'); if (el) el.focus(); }, 80);
  }

  function lineDbError(error) {
    if (!error) return '저장하지 못했습니다.';
    const code = error.code || '';
    if (code === '42501') return '저장 권한이 없습니다(RLS). Supabase 정책을 확인해 주세요.';
    if (code === '23502') return `필수 항목이 비었습니다: ${error.message || ''}`;
    if (code === 'PGRST204') return `없는 컬럼입니다: ${error.message || ''}`;
    return error.message || '저장하지 못했습니다.';
  }

  async function submitLineForm(e) {
    e.preventDefault();
    showLineFormError('');
    const type = lineFormType();
    const owner = $('#ln-f-owner').value.trim();
    const phone = digitsOnly($('#ln-f-phone').value);
    const group = lineFormGroup();
    if (!owner) return showLineFormError('이름을 입력해 주세요.');
    if (type === '가개통' && !phone) return showLineFormError('가개통 회선은 전화번호가 필요합니다.');
    if (phone && phone.length < 9) return showLineFormError('전화번호가 너무 짧습니다.');
    if (!group) return showLineFormError('통신사 구분(SK·KT·LG·알뜰)을 골라 주세요.');

    const providerInput = $('#ln-f-provider').value.trim();
    const providerName = providerInput || (group === '알뜰' ? '' : LINE_GROUP_LABEL[group]);
    const days = Number(digitsOnly($('#ln-f-days').value)) || 0;
    const act = $('#ln-f-act').value || null;
    const benefit = digitsOnly($('#ln-f-benefit').value);
    const remind = digitsOnly($('#ln-f-remind').value);

    const payload = {
      line_type: type,
      name: $('#ln-f-name').value.trim() || null,
      owner_name: owner,
      phone_number: phone || null,
      phone_last4: phone ? phone.slice(-4) : null,
      provider_group: group,
      provider_name: providerName || null,
      network_provider: group === '알뜰' ? (lineFormNet() || null) : null,
      monthly_fee: Number(digitsOnly($('#ln-f-fee').value)) || 0,
      benefit_amount: benefit ? Number(benefit) : null,
      benefit_note: $('#ln-f-benefitnote').value.trim() || null,
      memo: $('#ln-f-memo').value.trim() || null,
      activation_date: act,
      reminder_days: remind ? Number(remind) : null
    };

    if (type === '약정') {
      payload.owner_location = $('#ln-f-loc').value.trim() || null;
      payload.product = $('#ln-f-product').value.trim() || null;
      payload.contract_end_date = $('#ln-f-end').value || null;
      payload.opening_plan = null;
      payload.plan_change_available_date = null;
      payload.maintenance_days = null;
      payload.maintenance_end_date = null;
    } else {
      payload.owner_location = null;
      payload.product = null;
      payload.contract_end_date = null;
      payload.opening_plan = $('#ln-f-plan').value.trim() || null;
      payload.plan_change_available_date = $('#ln-f-change').value || null;
      payload.maintenance_days = days > 0 ? days : null;
      payload.maintenance_end_date = act && days > 0 ? addDaysYmd(act, days - 1) : ($('#ln-f-maint').value || null);
    }

    const btn = $('#btn-line-save');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '저장 중…';
    const editId = state.lineFormId;
    let newId = null;
    try {
      if (editId) {
        const { error } = await db.from('lines')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', editId);
        if (error) throw error;
        toast('회선을 수정했습니다.');
      } else {
        payload.user_id = state.session.user.id;
        const { data, error } = await db.from('lines').insert(payload).select('id');
        if (error) throw error;
        newId = data && data[0] ? String(data[0].id) : null;
        toast('회선을 등록했습니다.');
      }
      closeModal('#line-form-modal');
      state.lineFormId = null;
      state.linesDirty = true;
      await loadLines(true);
      const openId = editId || newId;
      if (openId) { state.lineOpenId = String(openId); renderLineDetail(); openModal('#line-modal'); }
    } catch (err) {
      showLineFormError(lineDbError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* --- 요금제 변경 완료 --- */
  async function markPlanChanged(id) {
    try {
      const { error } = await db.from('lines')
        .update({ plan_changed_at: todayYmd(), updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      toast('요금제 변경 완료로 표시했습니다.');
      state.linesDirty = true;
      await loadLines(true);
      renderLineDetail();
    } catch (err) {
      toast(lineDbError(err));
    }
  }

  /* --- 종료 처리 --- */
  function openComplete(id) {
    const l = lineById(id);
    if (!l) return;
    state.lineOpenId = String(id);
    $('#ln-c-line').value = String(id);
    $('#ln-c-note').value = '';
    $('#complete-form-error').hidden = true;
    $('#complete-form-title').textContent = `${l.owner_name || l.name || '회선'} 종료 처리`;
    openModal('#line-complete-modal');
  }

  async function submitComplete(e) {
    e.preventDefault();
    const id = $('#ln-c-line').value;
    const note = $('#ln-c-note').value.trim();
    const err = $('#complete-form-error');
    err.hidden = true;
    if (!id) return;
    const btn = $('#btn-complete-save');
    btn.disabled = true;
    try {
      const { error } = await db.from('lines').update({
        status: '완료',
        is_active: false,
        completed_at: new Date().toISOString(),
        result_note: note || null,
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      toast('종료 처리했습니다.');
      closeModal('#line-complete-modal');
      state.linesDirty = true;
      await loadLines(true);
      if (state.lineOpenId) { renderLineDetail(); openModal('#line-modal'); }
    } catch (ex) {
      err.textContent = lineDbError(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* --- 부가서비스 --- */
  function openAddonForm(lineId, addonId) {
    const l = lineById(lineId);
    if (!l) return;
    const a = addonId ? lineStore().addons.find((x) => String(x.id) === String(addonId)) : null;
    state.addonLineId = String(lineId);
    $('#ln-a-line').value = String(lineId);
    $('#ln-a-id').value = a ? String(a.id) : '';
    $('#addon-form-title').textContent = a ? '부가서비스 수정' : '부가서비스 추가';
    $('#addon-form-sub').textContent = `${l.owner_name || l.name || '회선'} · ${l.line_type}`;
    $('#ln-a-name').value = a ? (a.addon_name || '') : '';
    $('#ln-a-fee').value = a && a.monthly_fee != null ? Number(a.monthly_fee).toLocaleString('ko-KR') : '';
    $('#ln-a-joined').value = (a && a.joined_date) || '';
    $('#ln-a-removable').value = (a && a.removable_date) || '';
    $('#ln-a-memo').value = (a && a.memo) || '';
    $('#addon-form-error').hidden = true;
    openModal('#line-addon-modal');
  }

  async function submitAddon(e) {
    e.preventDefault();
    const errEl = $('#addon-form-error');
    errEl.hidden = true;
    const lineId = $('#ln-a-line').value;
    const addonId = $('#ln-a-id').value;
    const name = $('#ln-a-name').value.trim();
    if (!name) { errEl.textContent = '부가서비스명을 입력해 주세요.'; errEl.hidden = false; return; }
    const payload = {
      addon_name: name,
      monthly_fee: Number(digitsOnly($('#ln-a-fee').value)) || 0,
      joined_date: $('#ln-a-joined').value || null,
      removable_date: $('#ln-a-removable').value || null,
      memo: $('#ln-a-memo').value.trim() || null
    };
    const btn = $('#btn-addon-save');
    btn.disabled = true;
    try {
      if (addonId) {
        const { error } = await db.from('line_addons')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', addonId);
        if (error) throw error;
        toast('부가서비스를 수정했습니다.');
      } else {
        const { error } = await db.from('line_addons').insert({ ...payload, line_id: lineId });
        if (error) throw error;
        toast('부가서비스를 추가했습니다.');
      }
      closeModal('#line-addon-modal');
      state.linesDirty = true;
      await loadLines(true);
      renderLineDetail();
      openModal('#line-modal');
    } catch (err) {
      errEl.textContent = (err && err.code === '42501')
        ? '부가서비스 저장 권한이 없습니다(RLS). Supabase `line_addons`에 insert 정책을 추가하면 저장됩니다.'
        : lineDbError(err);
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function removeAddon(addonId) {
    try {
      const { error } = await db.from('line_addons').update({
        removed_at: todayYmd(),
        is_active: false,
        updated_at: new Date().toISOString()
      }).eq('id', addonId);
      if (error) throw error;
      toast('부가서비스를 삭제 완료로 표시했습니다.');
      state.linesDirty = true;
      await loadLines(true);
      renderLineDetail();
    } catch (err) {
      toast(lineDbError(err));
    }
  }

  /* --- 이벤트 --- */
  function bindLines() {
    const view = $('#view-lines');
    if (view) {
      view.addEventListener('click', (e) => {
        const f = e.target.closest('[data-ln-filter]');
        if (f) {
          state.linesFilter = f.dataset.lnFilter;
          renderLines();
          return;
        }
        if (e.target.closest('#btn-line-new')) { openLineForm(null); return; }
        const item = e.target.closest('[data-ln-open]');
        if (item) openLineDetail(item.dataset.lnOpen);
      });
      view.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('[data-ln-open]');
        if (!item) return;
        e.preventDefault();
        openLineDetail(item.dataset.lnOpen);
      });
    }

    const detail = $('#line-modal');
    if (detail) {
      detail.addEventListener('click', (e) => {
        if (e.target.closest('[data-ln-close]') || e.target === detail) { closeModal('#line-modal'); return; }
        const edit = e.target.closest('[data-ln-edit]');
        if (edit) { closeModal('#line-modal'); openLineForm(edit.dataset.lnEdit); return; }
        const plan = e.target.closest('[data-ln-plan-change]');
        if (plan) { markPlanChanged(plan.dataset.lnPlanChange); return; }
        const comp = e.target.closest('[data-ln-complete]');
        if (comp) { openComplete(comp.dataset.lnComplete); return; }
        const addNew = e.target.closest('[data-ln-addon-add]');
        if (addNew) { openAddonForm(addNew.dataset.lnAddonAdd, null); return; }
        const addEdit = e.target.closest('[data-ln-addon-edit]');
        if (addEdit) { openAddonForm(state.lineOpenId, addEdit.dataset.lnAddonEdit); return; }
        const addRm = e.target.closest('[data-ln-addon-remove]');
        if (addRm) { removeAddon(addRm.dataset.lnAddonRemove); return; }
      });
    }

    const formModal = $('#line-form-modal');
    if (formModal) {
      formModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-ln-close]') || e.target === formModal) { closeModal('#line-form-modal'); state.lineFormId = null; return; }
        const t = e.target.closest('[data-ln-type]');
        if (t) { applyLineFormType(t.dataset.lnType); return; }
        const g = e.target.closest('[data-ln-group]');
        if (g) {
          const f = $('#line-form');
          f.dataset.group = g.dataset.lnGroup;
          segSet('#ln-f-groups', g.dataset.lnGroup);
          $('#ln-f-net-wrap').hidden = g.dataset.lnGroup !== '알뜰';
          if (g.dataset.lnGroup !== '알뜰' && !$('#ln-f-provider').value.trim()) {
            $('#ln-f-provider').value = LINE_GROUP_LABEL[g.dataset.lnGroup] || '';
          } else if (g.dataset.lnGroup === '알뜰' && LINE_GROUPS.slice(0, 3).some((k) => LINE_GROUP_LABEL[k] === $('#ln-f-provider').value.trim())) {
            $('#ln-f-provider').value = '';
          }
          return;
        }
        const n = e.target.closest('[data-ln-net]');
        if (n) {
          $('#line-form').dataset.net = n.dataset.lnNet;
          segSet('#ln-f-nets', n.dataset.lnNet);
        }
      });
      const form = $('#line-form');
      if (form) form.addEventListener('submit', submitLineForm);
      const actEl = $('#ln-f-act');
      if (actEl) actEl.addEventListener('change', syncMaintenance);
      const daysEl = $('#ln-f-days');
      if (daysEl) daysEl.addEventListener('input', syncMaintenance);
      const phoneEl = $('#ln-f-phone');
      if (phoneEl) phoneEl.addEventListener('blur', () => { phoneEl.value = fmtPhone(phoneEl.value); });
    }

    const addonModal = $('#line-addon-modal');
    if (addonModal) {
      addonModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-ln-close]') || e.target === addonModal) closeModal('#line-addon-modal');
      });
      const af = $('#addon-form');
      if (af) af.addEventListener('submit', submitAddon);
    }

    const compModal = $('#line-complete-modal');
    if (compModal) {
      compModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-ln-close]') || e.target === compModal) closeModal('#line-complete-modal');
      });
      const cf = $('#complete-form');
      if (cf) cf.addEventListener('submit', submitComplete);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (anyModalOpen()) closeAllModals();
    });

    /* 숫자 입력 콤마 표시 */
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !t.dataset || !t.dataset.money) return;
      const d = digitsOnly(t.value);
      t.value = d ? Number(d).toLocaleString('ko-KR') : '';
    });
  }

  /* ---------- 일정 (#/issues) ----------
     러버를 yescom-game-hq /missions(진행 중) · /history(완료 기록)를 게시판 안으로 옮겼다.
     DB는 같은 Supabase 프로젝트(`mveldownctofvhwcgnzz`)의 `issues`를 그대로 쓴다 — 새 테이블·복제 없음.
     실측 스키마: id(identity) · title · category · status · priority · due_date(date) · scheduled_at(timestamptz)
       · next_action · amount(bigint) · result_note · is_active(bool) · created_at · updated_at · completed_at */
  const KST_YMD_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const KST_DT_FMT = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const KST_TIME_FMT = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  const KST_INPUT_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

  function kstParts(fmt, iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return null;
    const p = fmt.formatToParts(d);
    const out = {};
    p.forEach((x) => { if (x.type !== 'literal') out[x.type] = x.value; });
    if (out.hour === '24') out.hour = '00';
    return out;
  }
  function kstYmd(iso) {
    const p = kstParts(KST_YMD_FMT, iso);
    return p ? `${p.year}-${p.month}-${p.day}` : null;
  }
  function todayKstYmd() { return kstYmd(new Date().toISOString()); }
  function fmtKstDateTime(iso) {
    const p = kstParts(KST_DT_FMT, iso);
    return p ? `${p.month}.${p.day}(${p.weekday}) ${p.hour}:${p.minute}` : '';
  }
  function fmtKstTime(iso) {
    const p = kstParts(KST_TIME_FMT, iso);
    return p ? `${p.hour}:${p.minute}` : '';
  }
  function kstInputValue(iso) {
    const p = kstParts(KST_INPUT_FMT, iso);
    return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : '';
  }
  /* datetime-local 값은 KST로 보여 주므로 저장할 땐 KST(UTC+9) 기준으로 되돌린다 */
  function kstInputToIso(v) {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0)).toISOString();
  }
  function fmtMd(ymd) {
    const d = ymdDate(ymd);
    return d ? `${pad(d.getMonth() + 1)}.${pad(d.getDate())}` : '';
  }

  function issueStore() { return state.issues || { list: [], at: null }; }
  function issueById(id) { return issueStore().list.find((i) => String(i.id) === String(id)) || null; }
  function issueIsDone(i) { return i.status === ISSUE_DONE; }
  function issueDueYmd(i) { return i && i.due_date ? String(i.due_date).slice(0, 10) : null; }
  /* D-day 기준 날짜 — 예약일시가 있으면 그 날, 없으면 목표일 */
  function issueWhen(i) { return i.scheduled_at ? kstYmd(i.scheduled_at) : issueDueYmd(i); }
  function issueDaysLeft(i) {
    const d = ymdDate(issueWhen(i));
    const t = ymdDate(todayKstYmd());
    if (!d || !t) return null;
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }

  function issueStats() {
    const all = issueStore().list;
    const active = all.filter((i) => !issueIsDone(i));
    const soon = active.filter((i) => { const n = issueDaysLeft(i); return n != null && n >= 0 && n <= 7; });
    const over = active.filter((i) => { const n = issueDaysLeft(i); return n != null && n < 0; });
    return { total: all.length, active: active.length, done: all.length - active.length, soon: soon.length, over: over.length };
  }

  function issuesForFilter() {
    const active = issueStore().list.filter((i) => !issueIsDone(i));
    const f = state.issuesFilter || '전체';
    let list = active;
    if (f === '오늘') list = active.filter((i) => issueDaysLeft(i) === 0);
    else if (f === '7일 이내') list = active.filter((i) => { const n = issueDaysLeft(i); return n != null && n >= 0 && n <= 7; });
    else if (f !== '전체') list = active.filter((i) => i.category === f);
    const rank = (n) => (n == null ? 3 : n < 0 ? 0 : 1);
    const pr = (i) => { const k = ISSUE_PRIORITIES.indexOf(i.priority || '보통'); return k < 0 ? 1 : k; };
    return [...list].sort((a, b) => {
      const na = issueDaysLeft(a);
      const nb = issueDaysLeft(b);
      const ra = rank(na);
      const rb = rank(nb);
      if (ra !== rb) return ra - rb;
      if (na != null && nb != null && na !== nb) return na - nb;
      if (pr(a) !== pr(b)) return pr(a) - pr(b);
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  }

  function issueItemHtml(i) {
    const n = issueDaysLeft(i);
    const cls = n == null ? '' : ddayClass(n);
    const catCls = ISSUE_CAT_CLASS[i.category] || 'ic-etc';
    const stCls = i.status === '진행중' ? 'is-doing' : i.status === '확인필요' ? 'is-check' : i.status === ISSUE_DONE ? 'is-done' : '';
    const prCls = i.priority === '높음' ? 'is-high' : i.priority === '낮음' ? 'is-low' : '';
    const when = i.scheduled_at
      ? `예약 ${fmtKstDateTime(i.scheduled_at)}`
      : issueDueYmd(i) ? `목표 ${fmtMd(issueDueYmd(i))}` : '일정 없음';
    const badge = n == null ? '' : `<span class="ln-dday ${ddayClass(n)}">${esc(ddayText(n))}</span>`;
    return `<li class="ln-item ${cls}">
      <div class="ln-item-top">
        <span class="iss-chips">
          <span class="ic-chip ${catCls}">${esc(i.category || '기타')}</span>
          <span class="iss-st ${stCls}">${esc(i.status || '대기')}</span>
          <span class="iss-pr ${prCls}">${esc(i.priority || '보통')}</span>
        </span>
        ${badge}
      </div>
      <h3 class="iss-title">${esc(i.title || '(제목 없음)')}</h3>
      <div class="iss-when">
        <span class="iss-due">${esc(when)}</span>
        ${i.amount != null ? `<span class="iss-amount">${esc(won(i.amount))}</span>` : ''}
      </div>
      ${i.next_action ? `<div class="iss-next">${esc(i.next_action)}</div>` : ''}
      <div class="iss-actions">
        <button type="button" class="ln-btn ln-btn-xs" data-iss-edit="${esc(i.id)}">수정</button>
        <button type="button" class="ln-btn ln-btn-xs ok" data-iss-done="${esc(i.id)}">완료</button>
      </div>
    </li>`;
  }

  function issueHistItemHtml(i) {
    const catCls = ISSUE_CAT_CLASS[i.category] || 'ic-etc';
    const when = i.completed_at ? fmtKstTime(i.completed_at) : '';
    return `<li class="ln-item">
      <div class="ln-item-top">
        <span class="iss-chips">
          <span class="ic-chip ${catCls}">${esc(i.category || '기타')}</span>
          ${issueDueYmd(i) ? `<span class="iss-pr">목표 ${esc(fmtMd(issueDueYmd(i)))}</span>` : ''}
          ${i.amount != null ? `<span class="iss-pr">${esc(won(i.amount))}</span>` : ''}
        </span>
        ${when ? `<span class="iss-pr">${esc(when)} 완료</span>` : ''}
      </div>
      <h3 class="iss-title">${esc(i.title || '(제목 없음)')}</h3>
      ${i.next_action ? `<div class="iss-next">${esc(i.next_action)}</div>` : ''}
      ${i.result_note ? `<div class="iss-result"><span class="iss-result-k">처리결과</span>${esc(i.result_note)}</div>` : ''}
      <div class="iss-actions"><button type="button" class="ln-btn ln-btn-xs" data-iss-edit="${esc(i.id)}">수정</button></div>
    </li>`;
  }

  /* 완료 기록 — 결산·자료실 › 완료 기록 서브 탭 (2026-11-28 일정 탭에서 이동) */
  function renderIssueHistory() {
    const q = (state.archHistQ || '').trim().toLowerCase();
    const cat = state.archHistCat || '전체';
    const doneAll = issueStore().list.filter((i) => issueIsDone(i));
    let rows = doneAll;
    if (cat !== '전체') rows = rows.filter((i) => i.category === cat);
    if (q) {
      rows = rows.filter((i) => [i.title, i.next_action, i.result_note]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    const stamp = (i) => (i.completed_at ? new Date(i.completed_at).getTime()
      : issueDueYmd(i) ? new Date(issueDueYmd(i) + 'T00:00:00+09:00').getTime()
        : new Date(i.created_at || 0).getTime());
    rows.sort((a, b) => stamp(b) - stamp(a));
    const groups = new Map();
    rows.forEach((i) => {
      const key = (i.completed_at && kstYmd(i.completed_at)) || issueDueYmd(i) || kstYmd(i.created_at) || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const html = Array.from(groups.entries()).map(([key, items]) => {
      const d = ymdDate(key);
      const label = d ? `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일` : '날짜 없음';
      return `<div class="iss-hist-group">
        <h3 class="iss-hist-month">${esc(label)} <span class="iss-n">${items.length}건</span></h3>
        <ul class="ln-list">${items.map(issueHistItemHtml).join('')}</ul>
      </div>`;
    }).join('');
    const box = $('#arch-history-list');
    if (box) box.innerHTML = html;
    const empty = $('#arch-history-empty');
    if (empty) empty.hidden = rows.length > 0;
    const foot = $('#arch-history-foot');
    if (foot) foot.textContent = `완료 기록 ${rows.length}건${cat !== '전체' ? ` · ${cat}` : ''}${q ? ` · ‘${q}’ 검색` : ''}`;
    const n = $('#arch-mode-hist-n');
    if (n) n.textContent = String(doneAll.length);
    const in1 = $('#iss-hist-n');
    if (in1) in1.textContent = String(doneAll.length);
  }

  function renderIssues() {
    const s = issueStats();
    $('#iss-sum-soon').textContent = String(s.soon);
    $('#iss-sum-active').textContent = String(s.active);
    $('#iss-sum-over').textContent = String(s.over);
    $('#iss-hist-n').textContent = String(s.done);

    const active = issueStore().list.filter((i) => !issueIsDone(i));
    const counts = {
      '전체': active.length,
      '오늘': active.filter((i) => issueDaysLeft(i) === 0).length,
      '7일 이내': active.filter((i) => { const n = issueDaysLeft(i); return n != null && n >= 0 && n <= 7; }).length
    };
    ISSUE_CATEGORIES.forEach((c) => { counts[c] = active.filter((i) => i.category === c).length; });
    $$('#iss-filters .ln-filter').forEach((b) => {
      const key = b.dataset.issFilter;
      const on = key === (state.issuesFilter || '전체');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      const n = $('.ln-n', b);
      if (n) n.textContent = String(counts[key] || 0);
    });
    $$('#arch-hist-filters .ln-filter').forEach((b) => {
      const on = b.dataset.archHistFilter === (state.archHistCat || '전체');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });

    const list = issuesForFilter();
    const ul = $('#iss-list');
    ul.innerHTML = list.map(issueItemHtml).join('');
    ul.hidden = list.length === 0;
    $('#iss-empty').hidden = list.length > 0;
    const foot = $('#iss-foot');
    if (foot) {
      foot.textContent = state.issues && state.issues.at
        ? `기준 ${fmtFull(state.issues.at.toISOString())} · 진행 ${s.active}건 · 완료 ${s.done}건`
        : '';
    }
    renderIssueHistory();
  }

  async function loadIssues(force, keepView) {
    if (!keepView) showView('issues');
    if (state.issues && !force && !state.issuesDirty) { renderIssues(); return; }
    if (!state.issues) {
      $('#iss-list').innerHTML = '<li class="ln-loading">불러오는 중…</li>';
      $('#iss-list').hidden = false;
      $('#iss-empty').hidden = true;
    }
    const { data, error } = await db.from('issues').select('*').order('created_at', { ascending: false });
    if (error) {
      if (isAuthError(error)) return forceLogin();
      const msg = (error.code === '42501' || error.code === 'PGRST301')
        ? '일정 데이터에 접근할 권한이 없습니다. (Supabase RLS)'
        : (error.message || String(error));
      $('#iss-list').innerHTML = `<li class="ln-loading">일정을 불러오지 못했습니다: ${esc(msg)}</li>`;
      return;
    }
    state.issues = { list: data || [], at: new Date() };
    state.issuesDirty = false;
    renderIssues();
  }

  /* --- 폼 --- */
  function issueSegSet(sel, value, key) {
    $$(sel + ' button').forEach((b) => {
      const on = b.dataset[key] === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function issueFormState() {
    const f = $('#issue-form');
    return {
      cat: (f && f.dataset.cat) || '기타',
      status: (f && f.dataset.status) || '대기',
      priority: (f && f.dataset.priority) || '보통'
    };
  }
  function syncIssueFormUi() {
    const { status } = issueFormState();
    const hint = $('#iss-f-result-hint');
    if (hint) hint.textContent = status === ISSUE_DONE ? '(완료 기록에 같이 남습니다)' : '(완료일 때 적습니다)';
  }
  function showIssueFormError(msg) {
    const el = $('#iss-form-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  function openIssueForm(id, presetCat) {
    const i = id ? issueById(id) : null;
    state.issueFormId = i ? String(i.id) : null;
    $('#issue-form-title').textContent = i ? '일정 수정' : '새 일정';
    const cat = i ? i.category : (ISSUE_CATEGORIES.includes(presetCat) ? presetCat : '기타');
    const status = i ? (i.status || '대기') : '대기';
    const priority = i ? (i.priority || '보통') : '보통';
    const f = $('#issue-form');
    f.dataset.cat = cat;
    f.dataset.status = status;
    f.dataset.priority = priority;
    issueSegSet('#iss-f-cats', cat, 'issCat');
    issueSegSet('#iss-f-status', status, 'issStatus');
    issueSegSet('#iss-f-priority', priority, 'issPriority');
    $('#iss-f-title').value = (i && i.title) || '';
    $('#iss-f-due').value = issueDueYmd(i) || '';
    $('#iss-f-sched').value = i && i.scheduled_at ? kstInputValue(i.scheduled_at) : '';
    $('#iss-f-next').value = (i && i.next_action) || '';
    $('#iss-f-amount').value = i && i.amount != null ? Number(i.amount).toLocaleString('ko-KR') : '';
    $('#iss-f-result').value = (i && i.result_note) || '';
    showIssueFormError('');
    syncIssueFormUi();
    openModal('#issue-form-modal');
    setTimeout(() => { const el = $('#iss-f-title'); if (el) el.focus(); }, 80);
  }

  async function submitIssueForm(e) {
    e.preventDefault();
    showIssueFormError('');
    const v = issueFormState();
    const title = $('#iss-f-title').value.trim();
    if (!title) return showIssueFormError('제목을 입력해 주세요.');
    if (!ISSUE_CATEGORIES.includes(v.cat)) return showIssueFormError('분류를 골라 주세요.');
    if (!ISSUE_STATUSES.includes(v.status)) return showIssueFormError('상태를 골라 주세요.');
    const amountRaw = digitsOnly($('#iss-f-amount').value);
    const payload = {
      title,
      category: v.cat,
      status: v.status,
      priority: v.priority,
      due_date: $('#iss-f-due').value || null,
      scheduled_at: kstInputToIso($('#iss-f-sched').value),
      next_action: $('#iss-f-next').value.trim() || null,
      amount: amountRaw ? Number(amountRaw) : null,
      result_note: $('#iss-f-result').value.trim() || null
    };
    const cur = state.issueFormId ? issueById(state.issueFormId) : null;
    if (v.status === ISSUE_DONE) {
      payload.is_active = false;
      payload.completed_at = (cur && cur.completed_at) || new Date().toISOString();
    } else {
      payload.is_active = true;
      payload.completed_at = null;
    }

    const btn = $('#btn-issue-save');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '저장 중…';
    try {
      if (state.issueFormId) {
        const { error } = await db.from('issues').update(payload).eq('id', state.issueFormId);
        if (error) throw error;
        toast('일정을 수정했습니다.');
      } else {
        const { error } = await db.from('issues').insert(payload);
        if (error) throw error;
        toast('일정을 등록했습니다.');
      }
      closeModal('#issue-form-modal');
      state.issueFormId = null;
      state.issuesDirty = true;
      await loadIssues(true, true); /* 화면은 그대로 둔다 — 결산·자료실 › 완료 기록에서 수정할 수도 있다 (2026-11-28) */
    } catch (err) {
      showIssueFormError(lineDbError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* --- 완료 처리 --- */
  function openIssueComplete(id) {
    const i = issueById(id);
    if (!i) return;
    $('#iss-c-id').value = String(i.id);
    $('#iss-c-note').value = i.result_note || '';
    const short = String(i.title || '').length > 24 ? String(i.title).slice(0, 24) + '…' : String(i.title || '');
    $('#issue-complete-title').textContent = `${short} 완료`;
    $('#iss-complete-error').hidden = true;
    openModal('#issue-complete-modal');
  }

  async function submitIssueComplete(e) {
    e.preventDefault();
    const id = $('#iss-c-id').value;
    const note = $('#iss-c-note').value.trim();
    const errEl = $('#iss-complete-error');
    errEl.hidden = true;
    if (!id) return;
    const btn = $('#btn-issue-complete');
    btn.disabled = true;
    try {
      const { error } = await db.from('issues').update({
        status: ISSUE_DONE,
        is_active: false,
        completed_at: new Date().toISOString(),
        result_note: note || null
      }).eq('id', id);
      if (error) throw error;
      toast('완료 처리했습니다. 결산·자료실 › 완료 기록에서 다시 볼 수 있습니다.');
      closeModal('#issue-complete-modal');
      state.issuesDirty = true;
      await loadIssues(true, true);
    } catch (ex) {
      errEl.textContent = lineDbError(ex);
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function bindIssues() {
    const view = $('#view-issues');
    if (view) {
      view.addEventListener('click', (e) => {
        if (e.target.closest('#btn-issue-new')) { openIssueForm(null); return; }
        const quick = e.target.closest('[data-iss-quick]');
        if (quick) { openIssueForm(null, quick.dataset.issQuick); return; }
        const f = e.target.closest('[data-iss-filter]');
        if (f) { state.issuesFilter = f.dataset.issFilter; renderIssues(); return; }
        const ed = e.target.closest('[data-iss-edit]');
        if (ed) { openIssueForm(ed.dataset.issEdit); return; }
        const done = e.target.closest('[data-iss-done]');
        if (done) { openIssueComplete(done.dataset.issDone); }
      });
    }

    /* 결산·자료실 — 서브 탭 · 완료 기록 필터/검색/수정 (2026-11-28) */
    const archView = $('#view-archive');
    if (archView) {
      archView.addEventListener('click', (e) => {
        const mode = e.target.closest('[data-arch-mode]');
        if (mode) {
          const tab = mode.dataset.archMode === 'history' ? 'history' : 'data';
          if (tab === state.archTab) { renderArchive(); return; }
          state.archTab = tab;
          const target = `#/archive?tab=${tab}`;
          if (location.hash === target) renderArchive();
          else location.hash = target;
          return;
        }
        const hf = e.target.closest('[data-arch-hist-filter]');
        if (hf) { state.archHistCat = hf.dataset.archHistFilter; renderArchive(); return; }
        const ed = e.target.closest('[data-iss-edit]');
        if (ed) { openIssueForm(ed.dataset.issEdit); return; }
      });
    }

    const histSearch = $('#arch-hist-search');
    if (histSearch) {
      histSearch.addEventListener('input', () => {
        state.archHistQ = histSearch.value;
        renderIssueHistory();
      });
    }

    const formModal = $('#issue-form-modal');
    if (formModal) {
      formModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-iss-close]') || e.target === formModal) {
          closeModal('#issue-form-modal');
          state.issueFormId = null;
          return;
        }
        const c = e.target.closest('[data-iss-cat]');
        if (c) {
          $('#issue-form').dataset.cat = c.dataset.issCat;
          issueSegSet('#iss-f-cats', c.dataset.issCat, 'issCat');
          return;
        }
        const status = e.target.closest('[data-iss-status]');
        if (status) {
          $('#issue-form').dataset.status = status.dataset.issStatus;
          issueSegSet('#iss-f-status', status.dataset.issStatus, 'issStatus');
          syncIssueFormUi();
          return;
        }
        const priority = e.target.closest('[data-iss-priority]');
        if (priority) {
          $('#issue-form').dataset.priority = priority.dataset.issPriority;
          issueSegSet('#iss-f-priority', priority.dataset.issPriority, 'issPriority');
        }
      });
      const form = $('#issue-form');
      if (form) form.addEventListener('submit', submitIssueForm);
    }

    const compModal = $('#issue-complete-modal');
    if (compModal) {
      compModal.addEventListener('click', (e) => {
        if (e.target.closest('[data-iss-close]') || e.target === compModal) closeModal('#issue-complete-modal');
      });
      const cf = $('#issue-complete-form');
      if (cf) cf.addEventListener('submit', submitIssueComplete);
    }
  }

  /* ---------- 본문 ---------- */
  async function loadDetail(id, editMode) {
    showView('detail');
    state.postId = id;
    state.editing = !!editMode;
    $('#detail-title').textContent = '불러오는 중…';
    $('#detail-content').innerHTML = '';
    $('#detail-cat').innerHTML = '';
    $('#detail-author').innerHTML = '';
    $('#detail-date').textContent = '';
    $('#comment-list').innerHTML = '';
    $('#comment-count').textContent = '0';
    $('#btn-edit').hidden = true;
    $('#btn-delete').hidden = true;

    const { data, error } = await db.from('ai_board_posts').select('*').eq('id', id).maybeSingle();
    if (state.postId !== id) return; /* 다른 글로 넘어간 뒤 늦게 온 응답은 버린다 (2026-11-28) */
    if (error) {
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#setup-error-detail').textContent = errText(error);
        showScreen('#screen-setup');
        return;
      }
      $('#detail-title').textContent = '글을 불러오지 못했습니다';
      $('#detail-content').innerHTML = `<p class="muted">${esc(error.message || '')}</p>`;
      return;
    }
    if (!data) {
      $('#detail-title').textContent = '없는 글이거나 볼 권한이 없습니다';
      $('#detail-content').innerHTML = '<p class="muted">삭제됐거나 주소가 잘못됐을 수 있습니다.</p>';
      return;
    }

    state.post = data;
    const mine = !!(state.session && data.user_id === state.session.user.id);
    $('#detail-title').textContent = data.title;
    $('#detail-cat').innerHTML = catChip(data.category);
    $('#detail-pin').hidden = !data.is_pinned;
    $('#detail-author').innerHTML = badge(data.author);
    $('#detail-date').textContent = fmtFull(data.created_at);
    const flagsHtml = flagChips(data);
    $('#detail-flags').innerHTML = flagsHtml;
    $('#detail-flags').hidden = !flagsHtml;
    const edited = data.updated_at && new Date(data.updated_at) - new Date(data.created_at) > 60000;
    $('#detail-edited').hidden = !edited;
    $('#detail-edited-dot').hidden = !edited;
    if (edited) $('#detail-edited').textContent = '수정 ' + fmtFull(data.updated_at);
    $('#detail-content').innerHTML = renderBody(data.content);
    $('#btn-edit').hidden = !mine;
    $('#btn-delete').hidden = !mine;
    $('#comment-content').value = '';
    const savedAuthor = preferredAuthor();
    $('#comment-author').value = AUTHORS.includes(savedAuthor) ? savedAuthor : AUTHORS[0];

    await loadComments(id);
    if (state.postId !== id) return;
    if (editMode) openWriteForm(data);
  }

  async function loadComments(postId) {
    const { data, error } = await db.from('ai_board_comments')
      .select('*').eq('post_id', postId).order('created_at', { ascending: true });
    if (state.postId !== postId) return; /* 늦게 온 다른 글 댓글은 버린다 (2026-11-28) */
    if (error) {
      if (isAuthError(error)) return forceLogin();
      $('#comment-list').innerHTML = `<li class="comment-item muted">댓글을 불러오지 못했습니다.</li>`;
      return;
    }
    const list = data || [];
    state.comments = list;
    $('#comment-count').textContent = list.length;
    $('#comment-list').innerHTML = list.map((c) => {
      const mine = !!(state.session && c.user_id === state.session.user.id);
      return `<li class="comment-item" data-id="${c.id}">
        <div class="comment-head">
          ${badge(c.author)}
          <span class="comment-time">${fmtFull(c.created_at)}</span>
          ${mine ? `<span class="comment-acts">
            <button type="button" class="comment-act" data-edit="${c.id}">수정</button>
            <button type="button" class="comment-act comment-del" data-del="${c.id}">삭제</button>
          </span>` : ''}
        </div>
        <div class="comment-body" data-body="${c.id}">${renderBody(c.content)}</div>
        ${mine ? `<div class="comment-edit" data-edit-box="${c.id}" hidden>
          <textarea class="comment-edit-input" data-edit-input="${c.id}" rows="3" maxlength="4000"></textarea>
          <div class="comment-edit-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-edit-cancel="${c.id}">취소</button>
            <button type="button" class="btn btn-primary btn-sm" data-edit-save="${c.id}">저장</button>
          </div>
        </div>` : ''}
      </li>`;
    }).join('');
  }

  function openCommentEdit(id) {
    const box = $(`[data-edit-box="${id}"]`);
    const body = $(`[data-body="${id}"]`);
    const input = $(`[data-edit-input="${id}"]`);
    const c = (state.comments || []).find((x) => Number(x.id) === Number(id));
    if (!box || !input || !c) return;
    input.value = c.content || '';
    box.hidden = false;
    if (body) body.hidden = true;
    input.focus();
  }

  function closeCommentEdit(id) {
    const box = $(`[data-edit-box="${id}"]`);
    const body = $(`[data-body="${id}"]`);
    if (box) box.hidden = true;
    if (body) body.hidden = false;
  }

  async function saveCommentEdit(id, btn) {
    const input = $(`[data-edit-input="${id}"]`);
    const c = (state.comments || []).find((x) => Number(x.id) === Number(id));
    if (!input) return;
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    if (c && content === String(c.content || '').trim()) { closeCommentEdit(id); return; }
    if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
    const { error } = await db.from('ai_board_comments').update({ content }).eq('id', Number(id));
    if (btn) { btn.disabled = false; btn.textContent = '저장'; }
    if (error) {
      if (isAuthError(error)) return forceLogin();
      toast('댓글을 수정하지 못했습니다: ' + (error.message || ''));
      return;
    }
    await loadComments(state.postId);
    state.dashDirty = true;
    state.archDirty = true;
    toast('댓글을 수정했습니다.');
  }

  /* ---------- 글쓰기/수정 ---------- */
  /* 제목 태그 빠른 선택 — 누르면 제목 맨 앞에 넣거나 같은 태그면 벗긴다(오타·중복 방지) */
  function applyTitleTag(tag) {
    const inp = $('#write-post-title');
    const cur = titleTag(inp.value);
    const rest = stripTag(inp.value);
    if (cur === tag) inp.value = rest;
    else inp.value = tag + (rest ? ' ' + rest : ' ');
    refreshTagChips();
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* ignore */ }
    $('#write-error').hidden = true;
  }

  function refreshTagChips() {
    const cur = titleTag($('#write-post-title').value);
    $$('#write-tags .tag-chip').forEach((b) => {
      const on = b.dataset.tag === cur;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function openWriteForm(post, params) {
    const isEdit = !!post;
    showView('write');
    $('#write-title').textContent = isEdit ? '글 수정' : '글쓰기';
    $('#btn-write-submit').textContent = isEdit ? '수정 저장' : '저장';
    $('#write-error').hidden = true;
    $('#write-category').value = isEdit ? post.category : (state.category !== ALL ? state.category : CATEGORIES[0]);
    if (isEdit) { ensureAuthorOption(post.author); ensureAuthorOption(post.owner); }
    const savedAuthor = preferredAuthor();
    $('#write-author').value = isEdit
      ? post.author
      : (AUTHORS.includes(savedAuthor) ? savedAuthor : AUTHORS[0]);
    $('#write-post-title').value = isEdit ? post.title : '';
    $('#write-content').value = isEdit ? post.content : '';
    $('#write-pinned').checked = isEdit ? !!post.is_pinned : false;
    $('#write-status').value = isEdit && post.status ? post.status : '';
    $('#write-priority').value = isEdit && post.priority ? String(post.priority) : '';
    $('#write-owner').value = isEdit && post.owner ? post.owner : '';
    $('#write-due').value = isEdit && post.due_date ? String(post.due_date).slice(0, 10) : '';

    // 딥링크 파라미터 (#/write?author=Vooy&category=업무&title=...&pin=1)
    if (!isEdit && params) {
      const a = canonicalAuthor(params.get('author'));
      if (a && AUTHORS.includes(a)) {
        $('#write-author').value = a;
        localStorage.setItem('yes_ai_board_author', a);
      }
      const c = params.get('category');
      if (c && CATEGORIES.includes(c)) $('#write-category').value = c;
      const t = params.get('title');
      if (t) $('#write-post-title').value = t.slice(0, 200);
      if (params.get('pin') === '1') $('#write-pinned').checked = true;
      const st = params.get('status');
      if (st && STATUSES.includes(st)) $('#write-status').value = st;
      const pr = params.get('priority');
      if (pr && ['1', '2', '3'].includes(pr)) $('#write-priority').value = pr;
      const ow = params.get('owner');
      if (ow && isKnownAuthor(ow)) $('#write-owner').value = ow;
      const du = params.get('due');
      if (du && /^\d{4}-\d{2}-\d{2}$/.test(du)) $('#write-due').value = du;
    }

    state.editing = isEdit;
    if (isEdit && post.id) state.postId = post.id;
    refreshTagChips();
    setTimeout(() => $('#write-post-title').focus(), 50);
  }

  async function submitWrite(e) {
    e.preventDefault();
    const btn = $('#btn-write-submit');
    const category = $('#write-category').value;
    const author = $('#write-author').value;
    const title = $('#write-post-title').value.trim();
    const content = $('#write-content').value;
    const isPinned = $('#write-pinned').checked;

    if (!title) return showWriteError('제목을 적어 주세요.');
    if (!category) return showWriteError('말머리를 골라 주세요.');

    localStorage.setItem('yes_ai_board_author', author);
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '저장 중…';

    const status = $('#write-status').value;
    const priority = $('#write-priority').value;
    const owner = $('#write-owner').value;
    const dueDate = $('#write-due').value;
    const payload = {
      category, author, title, content, is_pinned: isPinned,
      status: STATUSES.includes(status) ? status : null,
      priority: ['1', '2', '3'].includes(priority) ? Number(priority) : null,
      owner: owner && isKnownAuthor(owner) ? owner : null,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null
    };
    let res;
    if (state.editing && state.postId) {
      res = await db.from('ai_board_posts')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', state.postId).select('id').single();
    } else {
      res = await db.from('ai_board_posts').insert(payload).select('id').single();
    }

    btn.disabled = false;
    btn.textContent = label;

    if (res.error) {
      if (isAuthError(res.error)) return forceLogin();
      if (isSetupError(res.error)) {
        $('#setup-error-detail').textContent = errText(res.error);
        showScreen('#screen-setup');
        return;
      }
      if ((res.error.code || '') === '42501') {
        return showWriteError('저장 권한이 없습니다. 허용된 계정인지 확인해 주세요.');
      }
      return showWriteError('저장하지 못했습니다: ' + (res.error.message || ''));
    }

    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    const id = (row && row.id) || state.postId;
    state.dirty = true;
    state.loaded = false;
    state.dashDirty = true;
    state.archDirty = true;
    toast(state.editing ? '수정했습니다.' : '저장했습니다.');
    if (!id) { location.hash = '#/list'; return; }
    const target = `#/p/${id}`;
    if (location.hash === target) await loadDetail(id, false);
    else location.hash = target;
  }

  function showWriteError(msg) {
    const el = $('#write-error');
    el.textContent = msg;
    el.hidden = false;
  }

  /* ---------- 라우팅 ----------
     #/list · #/p/{id} · #/p/{id}/edit · #/write · #/archive(결산·자료실)
     · #/c/{말머리}                        → 해당 말머리 목록 (예: #/c/업무, #/c/개발%C2%B7%EC%95%B1)
     · #/write?author=Vooy&category=업무  → 작성자·말머리·제목·고정을 미리 체운 글쓰기 폼  */
  function parseHash() {
    const raw = String(location.hash || '').replace(/^#/, '');
    const qi = raw.indexOf('?');
    const pathPart = qi < 0 ? raw : raw.slice(0, qi);
    const params = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    // 브라우저·붙여넣기 경로에 따라 한 번 더 인코딩될 수 있어 두 번까지 풀어 본다.
    let path = pathPart;
    for (let k = 0; k < 2; k++) {
      try {
        const next = decodeURIComponent(path);
        if (next === path) break;
        path = next;
      } catch (e) { break; }
    }
    return { path: path, params: params };
  }

  /* 상단 통합검색 — 어느 화면에서든 제목·내용으로 전체 글 검색 (#/list?q=) */
  function runSearch(raw) {
    const term = sanitizeTerm(raw);
    const target = term ? `#/list?q=${encodeURIComponent(term)}` : '#/list';
    state.category = ALL;
    state.q = term;
    state.page = 1;
    buildTabs();
    if (location.hash === target) {
      showView('list');
      loadPosts();
      return;
    }
    state.dirty = true; /* 목록 화면에서 검색해도 route가 '같은 화면'으로 보고 건너뛰지 않게 (2026-11-28) */
    location.hash = target;
  }

  function setCategory(cat) {
    state.category = CATEGORIES.includes(cat) ? cat : ALL;
    state.page = 1;
    state.q = '';
    buildTabs();
    if (state.view !== 'list') showView('list');
    syncTopSearch();
    loadPosts();
  }

  async function route() {
    if (!state.member) return;
    const { path, params } = parseHash();

    const pm = path.match(/^\/p\/(\d+)(\/edit)?$/);
    if (pm) {
      const id = Number(pm[1]);
      if (state.view === 'detail' && state.postId === id && !pm[2] && state.post) return;
      await loadDetail(id, !!pm[2]);
      return;
    }

    if (path === '/write') {
      const hasParams = ['author', 'category', 'title', 'pin'].some((k) => params.has(k));
      if (state.view !== 'write' || hasParams) openWriteForm(null, params);
      return;
    }

    const cm = path.match(/^\/c\/(.+)$/);
    if (cm) {
      const cat = CATEGORIES.includes(cm[1]) ? cm[1] : ALL;
      const already = state.view === 'list' && state.category === cat && !state.q && state.page === 1;
      if (already && state.loaded && !state.dirty) return;
      setCategory(cat);
      return;
    }

    /* #/archive = 결산·자료실 — 자료·결산 글 + 완료 기록(issues 완료) */
    if (path === '/archive' || path === '/archive/') {
      state.archTab = params.get('tab') === 'history' ? 'history' : 'data';
      await loadArchive();
      return;
    }

    /* #/history = 러버블 완료 기록 주소 — 결산·자료실 › 완료 기록으로 연결 (2026-11-28) */
    if (path === '/history' || path === '/history/') {
      state.archTab = 'history';
      await loadArchive();
      return;
    }

    /* #/lines = 회선 관리 — 러버블 yescom-game-hq /lines 의 lines·line_addons 를 그대로 쓴다 */
    if (path === '/lines' || path === '/lines/') {
      await loadLines();
      return;
    }

    /* #/issues = 일정 — 러버블 yescom-game-hq /missions·/history 의 issues 를 그대로 쓴다 */
    if (path === '/issues' || path === '/issues/') {
      await loadIssues();
      return;
    }

    /* #/list?q=검색어 = 상단 통합검색 결과 (제목·내용) */
    if (path === '/list' || path === '/list/') {
      const q = sanitizeTerm(params.get('q') || '');
      const same = state.view === 'list' && state.category === ALL && state.q === q && state.page === 1;
      if (same && state.loaded && !state.dirty) return;
      state.category = ALL;
      state.q = q;
      state.page = 1;
      buildTabs();
      showView('list');
      await loadPosts();
      return;
    }

    /* #/ (기본) = 대시보드, #/list = 시간순 전체 글 */
    if (path === '' || path === '/' || path === '/dashboard') {
      await loadDashboard();
      return;
    }

    if (state.category !== ALL || state.q || state.page !== 1) {
      state.category = ALL;
      state.q = '';
      state.page = 1;
    }
    if (state.view !== 'list') showView('list');
    if (state.dirty || !state.loaded) await loadPosts();
  }

  function forceLogin() {
    toast('로그인이 만료됐습니다. 다시 로그인해 주세요.');
    db.auth.signOut().catch(() => {});
    state.session = null;
    state.member = false;
    state.loaded = false;
    state.dash = null;
    state.dashDirty = true;
    state.arch = null;
    state.archDirty = true;
    state.lines = null;
    state.linesDirty = true;
    state.issues = null;
    state.issuesDirty = true;
    showScreen('#screen-login');
  }

  /* ---------- 이벤트 ---------- */
  function bind() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#btn-login');
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      const err = $('#login-error');
      err.hidden = true;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '로그인 중…';
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      btn.textContent = label;
      if (error) {
        err.textContent = mapAuthError(error);
        err.hidden = false;
        return;
      }
      $('#login-password').value = '';
      await enter(data.session);
    });

    $('#btn-logout').addEventListener('click', doLogout);
    $('#btn-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      syncMenu();
      setMenu($('#top-menu').hidden);
    });
    document.addEventListener('click', (e) => {
      const panel = $('#top-menu');
      if (!panel || panel.hidden) return;
      if (panel.contains(e.target) || (e.target.closest && e.target.closest('#btn-menu'))) return;
      setMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setMenu(false);
    });
    $('#default-author').addEventListener('change', (e) => {
      const v = canonicalAuthor(e.target.value);
      if (v && AUTHORS.includes(v)) {
        localStorage.setItem(DEFAULT_AUTHOR_KEY, v);
        if (!state.editing) $('#write-author').value = v; /* 수정 중인 글의 작성자는 그대로 둔다 (2026-11-28) */
        $('#comment-author').value = v;
        toast(`기본 작성자를 '${v}'${josaRo(v)} 정했습니다.`);
      } else {
        localStorage.removeItem(DEFAULT_AUTHOR_KEY);
        toast('기본 작성자를 정하지 않았습니다. 최근에 쓴 이름을 씁니다.');
      }
    });
    $('#btn-setup-logout').addEventListener('click', doLogout);
    $('#btn-denied-logout').addEventListener('click', doLogout);

    $('#btn-setup-retry').addEventListener('click', async () => { await enter(state.session || (await db.auth.getSession()).data.session); });
    $('#btn-denied-retry').addEventListener('click', async () => { await enter(state.session || (await db.auth.getSession()).data.session); });

    $('#btn-copy-sql').addEventListener('click', async () => {
      const text = $('#denied-sql').textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('SQL을 복사했습니다.');
      } catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('#denied-sql'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        toast('SQL을 선택했습니다. 복사해 주세요.');
      }
    });

    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const nav = btn.dataset.nav;
      const before = location.hash;
      if (nav === 'archive') {
        state.archTab = 'data';
        if (location.hash !== '#/archive') { location.hash = '#/archive'; return; }
        loadArchive(true);
        return;
      }
      if (nav === 'lines') {
        if (state.view === 'lines') { loadLines(true); return; }
        location.hash = '#/lines';
        if (location.hash === before) loadLines();
        return;
      }
      if (nav === 'issues') {
        if (state.view === 'issues') { loadIssues(true); return; }
        location.hash = '#/issues';
        if (location.hash === before) loadIssues();
        return;
      }
      if (nav === 'all') {
        if (state.view === 'list' && state.category === ALL && !state.q) return;
        location.hash = '#/list';
        if (location.hash === before) setCategory(ALL);
        return;
      }
      if (nav === state.category && state.view === 'list') return;
      // 말머리도 주소로 남긴다 → #/c/업무 로 바로 열 수 있음
      location.hash = '#/c/' + encodeURIComponent(nav);
      if (location.hash === before) setCategory(nav);
    });

    /* 결산·자료실 소분류 필터 */
    $('#arch-filters').addEventListener('click', (e) => {
      const btn = e.target.closest('.arch-filter');
      if (!btn) return;
      const key = btn.dataset.arch || 'all';
      if (key === state.archFilter) return;
      state.archFilter = key;
      renderArchive();
    });

    /* 대시보드 토글 · 새로고침 */
    $('#dash-personal-toggle').addEventListener('click', () => {
      state.personalOpen = !state.personalOpen;
      renderDashboard();
    });

    $('#dash-refresh').addEventListener('click', () => { loadDashboard(true); });

    $('#top-search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch($('#top-search-input').value);
    });

    $('#top-search-input').addEventListener('search', () => {
      const val = $('#top-search-input').value;
      if (val.trim() === '' && state.q) runSearch('');
    });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      const p = Number(btn.dataset.page);
      if (!p || p === state.page) return;
      state.page = p;
      loadPosts().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    });

    $('#btn-write').addEventListener('click', () => { location.hash = '#/write'; });
    $('#write-tags').addEventListener('click', (e) => {
      const b = e.target.closest('.tag-chip');
      if (!b) return;
      e.preventDefault();
      applyTitleTag(b.dataset.tag);
    });
    $('#write-post-title').addEventListener('input', refreshTagChips);
    $('#btn-write-cancel').addEventListener('click', () => {
      if (state.editing && state.postId) location.hash = `#/p/${state.postId}`;
      else history.length > 1 ? history.back() : (location.hash = '#/list');
    });
    $('#write-form').addEventListener('submit', submitWrite);

    $('#btn-list').addEventListener('click', () => { location.hash = '#/list'; });
    $('#btn-copy-link').addEventListener('click', copyLink);

    $('#btn-edit').addEventListener('click', () => {
      if (!state.post) return;
      location.hash = `#/p/${state.post.id}/edit`;
    });

    $('#btn-delete').addEventListener('click', async () => {
      if (!state.post) return;
      if (!confirm('이 글을 삭제할까요? 댓글도 함께 지워집니다.')) return;
      const { error } = await db.from('ai_board_posts').delete().eq('id', state.post.id);
      if (error) {
        if (isAuthError(error)) return forceLogin();
        toast('삭제하지 못했습니다: ' + (error.message || ''));
        return;
      }
      state.dirty = true;
      state.dashDirty = true;
      state.archDirty = true;
      state.post = null;
      toast('삭제했습니다.');
      location.hash = '#/list';
      if (state.view === 'list') loadPosts();
    });

    $('#comment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = $('#comment-content');
      const content = el.value.trim();
      const author = $('#comment-author').value;
      if (!content) { el.focus(); return; }
      const btn = $('#btn-comment-submit');
      btn.disabled = true;
      localStorage.setItem('yes_ai_board_author', author);
      const { error } = await db.from('ai_board_comments').insert({ post_id: state.postId, author, content });
      btn.disabled = false;
      if (error) {
        if (isAuthError(error)) return forceLogin();
        toast('댓글을 저장하지 못했습니다: ' + (error.message || ''));
        return;
      }
      el.value = '';
      await loadComments(state.postId);
      state.dirty = true;
      state.dashDirty = true;
      state.archDirty = true;
      toast('댓글을 남겼습니다.');
    });

    $('#comment-content').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#comment-form').requestSubmit();
      }
    });

    $('#comment-list').addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) { openCommentEdit(editBtn.dataset.edit); return; }
      const cancelBtn = e.target.closest('[data-edit-cancel]');
      if (cancelBtn) { closeCommentEdit(cancelBtn.dataset.editCancel); return; }
      const saveBtn = e.target.closest('[data-edit-save]');
      if (saveBtn) { await saveCommentEdit(saveBtn.dataset.editSave, saveBtn); return; }

      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      if (!confirm('이 댓글을 삭제할까요?')) return;
      const id = Number(btn.dataset.del);
      const { error } = await db.from('ai_board_comments').delete().eq('id', id);
      if (error) { toast('삭제하지 못했습니다: ' + (error.message || '')); return; }
      await loadComments(state.postId);
      state.dirty = true;
      state.dashDirty = true;
      state.archDirty = true;
      toast('댓글을 삭제했습니다.');
    });

    $('#comment-list').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.closest('[data-edit-input]')) {
        closeCommentEdit(e.target.dataset.editInput);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.closest('[data-edit-input]')) {
        e.preventDefault();
        const id = e.target.dataset.editInput;
        const btn = $(`[data-edit-save="${id}"]`);
        saveCommentEdit(id, btn);
      }
    });

    $('#btn-copy-md').addEventListener('click', copyPostMd);

    window.addEventListener('hashchange', route);
  }

  async function doLogout() {
    await db.auth.signOut().catch(() => {});
    state.session = null;
    state.member = false;
    state.loaded = false;
    state.dash = null;
    state.dashDirty = true;
    state.arch = null;
    state.archDirty = true;
    state.post = null;
    state.posts = [];
    state.lines = null;
    state.linesDirty = true;
    state.lineOpenId = null;
    state.lineFormId = null;
    state.issues = null;
    state.issuesDirty = true;
    state.issueFormId = null;
    history.replaceState(null, '', location.pathname);
    showScreen('#screen-login');
  }

  async function copyLink() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast('링크를 복사했습니다.');
    } catch (e) {
      prompt('아래 주소를 복사하세요', url);
    }
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    bind();
    bindLines();
    bindIssues();

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showScreen('#screen-login');
      const err = $('#login-error');
      err.textContent = 'Supabase 라이브러리를 불러오지 못했습니다. 광고 차단·네트워크를 확인하고 새로고침해 주세요.';
      err.hidden = false;
      return;
    }

    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'yes-ai-board-auth' }
    });

    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        state.session = null;
        state.member = false;
        state.loaded = false;
        showScreen('#screen-login');
      }
    });

    const { data } = await db.auth.getSession();
    await enter(data.session);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
