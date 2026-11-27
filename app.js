/* 예스AI 공용 게시판 — app.js
   Supabase(이메일 로그인 + RLS) 기반 정적 게시판. 빌드 없음. */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://mveldownctofvhwcgnzz.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_FLXtDN6cTA-blmsQU78B-Q_YbEYapeO';

  const CATEGORIES = ['업무', '고객예약', '개발·앱', '세무·정산', '개인'];
  const AUTHORS = ['이지실버', '예스통신', 'ChatGPT', 'Claude', '제미나이', 'Vooy', '종훈'];
  const PAGE_SIZE = 15;
  const ALL = '전체';

  /* 대시보드(#/) 설정 — DB 변경 없이 제목 태그·`완료:` 댓글만으로 계산한다.
     2026-11-27 Claude 보완: 개발·앱 칸 앱별 최신 배포, ③과 중복 제외, 빈 칸 한 줄 접기, 모바일 영역 칸 가로 넘김.
     2026-11-27 Claude 2단계: 상태·중요도·담당·기한 칸(DB) 연결. 칸이 비어 있으면 1단계 규칙 그대로. */
  const TODO_TAGS = ['[결정필요]', '[긴급]', '[오류]', '[일정]'];
  const TODO_RANK = { '[결정필요]': 0, '[긴급]': 1, '[오류]': 1, '[일정]': 2 };
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
  const TODO_BASE_MOBILE = 6;
  const TODO_BASE_DESKTOP = 10;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CAT_CLASS = {
    '업무': 'cat-work',
    '고객예약': 'cat-reserve',
    '개발·앱': 'cat-dev',
    '세무·정산': 'cat-tax',
    '개인': 'cat-personal'
  };
  const AUTHOR_CLASS = {
    '이지실버': 'badge-jisilver',
    '예스통신': 'badge-yes',
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
    todoOpen: false,
    personalOpen: false
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

  /* 댓글 첫 비공백 줄이 `완료:`로 시작하면 그 글은 완료 (본문 중간의 '완료:' 문장은 세지 않음) */
  function firstLine(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') return lines[i];
    }
    return '';
  }

  function isDonePost(comments) {
    return (comments || []).some((c) => /^\s*완료\s*:/.test(firstLine(c.content)));
  }

  /* 미리보기 한 줄 — 마크다운 기호를 띄고 길이를 줄인다. */
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

  async function copyRecent() {
    const btn = $('#btn-copy-recent');
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '불러오는 중…';
    try {
      const pinnedRes = await db.from('ai_board_posts')
        .select('*').eq('is_pinned', true).order('created_at', { ascending: false }).limit(3);
      const latestRes = await db.from('ai_board_posts')
        .select('*').order('created_at', { ascending: false }).limit(5);
      const err = pinnedRes.error || latestRes.error;
      if (err) {
        if (isAuthError(err)) return forceLogin();
        toast('글을 불러오지 못했습니다: ' + (err.message || ''));
        return;
      }
      const seen = new Set();
      const posts = [];
      [...(pinnedRes.data || []), ...(latestRes.data || [])].forEach((p) => {
        if (seen.has(p.id)) return;
        seen.add(p.id);
        posts.push(p);
      });
      if (!posts.length) { toast('복사할 글이 없습니다.'); return; }

      const ids = posts.map((p) => p.id);
      const cmtRes = await db.from('ai_board_comments')
        .select('*').in('post_id', ids).order('created_at', { ascending: true });
      if (cmtRes.error) {
        if (isAuthError(cmtRes.error)) return forceLogin();
      }
      const byPost = new Map();
      (cmtRes.error ? [] : (cmtRes.data || [])).forEach((c) => {
        if (!byPost.has(c.post_id)) byPost.set(c.post_id, []);
        byPost.get(c.post_id).push(c);
      });

      const head = [
        '# 예스AI 공용 게시판 — 최근 글 요약',
        `기준 시각: ${fmtFull(new Date().toISOString())}`,
        `게시판: ${boardUrl()}#/list`,
        '아래는 게시판에서 뽑은 고정 글 + 최근 글과 댓글입니다. 이 맥락을 읽고 답해 주세요.',
        ''
      ].join('\n');
      const body = posts.map((p) => buildPostMd(p, byPost.get(p.id) || [], { heading: true })).join('\n\n');
      await copyText(head + '\n' + body + '\n', `최근 글 ${posts.length}건(고정 포함)을 복사했습니다.`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function showScreen(id) {
    ['#screen-login', '#screen-setup', '#screen-denied', '#screen-board'].forEach((s) => {
      $(s).hidden = s !== id;
    });
    $('#topbar-user').hidden = !state.session;
  }

  function showView(v) {
    state.view = v;
    $('#view-dashboard').hidden = v !== 'dashboard';
    $('#view-list').hidden = v !== 'list';
    $('#view-detail').hidden = v !== 'detail';
    $('#view-write').hidden = v !== 'write';
    const bar = $('.board-toolbar');
    if (bar) bar.hidden = !(v === 'list' || v === 'dashboard');
    $('#search-form').hidden = v !== 'list';
    $('#tabs').hidden = v === 'write';
    if (v === 'dashboard') {
      $('#board-title').innerHTML = `대시보드 <span class="muted">${esc(fmtDay(new Date()))} 기준</span>`;
    } else if (v === 'list' && state.loaded) {
      renderBoardTitle();
    }
    buildTabs();
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
    const ok = await checkMembership();
    if (!ok) return;
    showScreen('#screen-board');
    buildTabs();
    fillSelects();
    route();
  }

  /* ---------- 목록 ---------- */
  function buildTabs() {
    const tabs = $('#tabs');
    const dashOn = state.view === 'dashboard';
    const listOn = state.view === 'list' && state.category === ALL;
    const parts = [
      `<button type="button" class="tab tab-dash${dashOn ? ' active' : ''}" role="tab" data-nav="dash" aria-selected="${dashOn}">대시보드</button>`,
      `<button type="button" class="tab${listOn ? ' active' : ''}" role="tab" data-nav="all" aria-selected="${listOn}">전체 글</button>`
    ];
    CATEGORIES.forEach((c) => {
      const on = state.view === 'list' && state.category === c;
      parts.push(`<button type="button" class="tab${on ? ' active' : ''}" role="tab" data-nav="${esc(c)}" aria-selected="${on}">${esc(c)}</button>`);
    });
    tabs.innerHTML = parts.join('');
  }

  function fillSelects() {
    const catOpts = CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const authorOpts = AUTHORS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('#write-category').innerHTML = catOpts;
    $('#write-author').innerHTML = authorOpts;
    $('#comment-author').innerHTML = authorOpts;
    $('#write-owner').innerHTML = '<option value="">없음</option>' + authorOpts;
    const saved = localStorage.getItem('yes_ai_board_author');
    if (saved && AUTHORS.includes(saved)) {
      $('#write-author').value = saved;
      $('#comment-author').value = saved;
    }
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

    const rows = state.posts.map((p) => {
      const cmt = counts.get(p.id) || 0;
      return `<tr>
        <td class="col-no"><span class="cell-no">${p.is_pinned ? '📌 ' : ''}${p.id}</span></td>
        <td class="col-cat">${catChip(p.category)}</td>
        <td class="col-title">
          <a class="cell-title" href="#/p/${p.id}">${esc(p.title)}${cmt ? `<span class="cmt">(${cmt})</span>` : ''}</a>${(p.status || p.due_date) ? `<span class="row-flags">${flagChips(p, { noPriority: true })}</span>` : ''}
          <span class="m-meta">${p.is_pinned ? '<span class="pinmark">📌</span>' : ''}${catChip(p.category)}${badge(p.author)}<span class="dot"></span><span>${fmtShort(p.created_at)}</span></span>
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
      .select('id,category,author,title,content,is_pinned,created_at,status,priority,owner,due_date')
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

  function renderDashboard() {
    const d = state.dash;
    if (!d) return;
    const posts = d.posts || [];
    const byPost = postCommentsMap();

    /* ① 지금 처리할 일
       - 상태 칸이 있으면 상태로 판정: 결정필요는 항상, 진행은 중요도 1이거나 기한 7일 이내(지난 것 포함). 보류·완료는 제외.
       - 상태 칸이 비어 있으면 1단계 규칙: 제목 태그([결정필요]·[긴급]·[오류]·[일정]) 또는 기한 7일 이내.
       - 어느 쪽이든 완료: 댓글이 달리면 빠진다. */
    const todo = [];
    posts.forEach((p) => {
      if (p.status === '완료' || p.status === '보류') return;
      if (isDonePost(byPost.get(p.id))) return;
      const n = dueDays(p.due_date);
      const soon = n !== null && n <= DUE_SOON_DAYS;
      let label = '';
      let rank = 9;
      if (p.status === '결정필요') { label = '결정필요'; rank = 0; }
      else if (p.status === '진행') {
        if (Number(p.priority) === 1) { label = '진행'; rank = 1; }
        else if (soon) { label = '진행'; rank = 2; }
        else return;
      } else {
        const tag = titleTag(p.title);
        if (TODO_TAGS.includes(tag)) { label = tag.slice(1, -1); rank = TODO_RANK[tag]; }
        else if (soon) { label = '기한'; rank = 2; }
        else return;
      }
      todo.push({ p, label, rank, n });
    });
    todo.sort((a, b) => (a.rank - b.rank)
      || ((a.n === null ? 99999 : a.n) - (b.n === null ? 99999 : b.n))
      || ((Number(a.p.priority) || 9) - (Number(b.p.priority) || 9))
      || (new Date(b.p.created_at) - new Date(a.p.created_at)));

    $('#dash-todo-count').textContent = String(todo.length);
    const isMobile = window.matchMedia('(max-width:720px)').matches;
    const baseLimit = isMobile ? TODO_BASE_MOBILE : TODO_BASE_DESKTOP;
    const limit = state.todoOpen ? todo.length : Math.min(todo.length, baseLimit);
    const shown = todo.slice(0, limit);

    $('#dash-todo-list').innerHTML = shown.map(({ p, label }) => {
      const cc = (byPost.get(p.id) || []).length;
      const tagCls = (label === '일정' || label === '기한') ? 'tag-sched' : (label === '결정필요' ? 'tag-decide' : (label === '진행' ? 'tag-doing' : 'tag-urgent'));
      return `<li class="todo-item">
        <a class="todo-link" href="#/p/${p.id}">
          <span class="tag-pill ${tagCls}">${esc(label)}</span>
          <span class="todo-title">${esc(dashTitle(p))}</span>
          <span class="todo-meta">${badge(p.author)}<span class="dot"></span><span>${fmtShort(p.created_at)}</span>${cc ? `<span class="dot"></span><span>댓글 ${cc}</span>` : ''}${flagChips(p, { noStatus: true, noPriority: p.status === '결정필요' })}</span>
        </a>
      </li>`;
    }).join('');
    $('#dash-todo-list').hidden = shown.length === 0;
    $('#dash-todo-empty').hidden = todo.length > 0;
    $('#dash-todo-empty').textContent = '지금 처리할 일이 없습니다.';

    const moreWrap = $('#dash-todo-more-wrap');
    const moreBtn = $('#dash-todo-more');
    if (!state.todoOpen && todo.length > baseLimit) {
      moreWrap.hidden = false;
      moreBtn.textContent = `더 보기 (${todo.length - baseLimit}건)`;
      moreBtn.dataset.mode = 'more';
    } else if (state.todoOpen && todo.length > baseLimit) {
      moreWrap.hidden = false;
      moreBtn.textContent = '접기';
      moreBtn.dataset.mode = 'less';
    } else {
      moreWrap.hidden = true;
    }

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

    /* ④ 최근 활동 — 새 글 + 새 댓글 (개인 말머리는 접힘) */
    const acts = [];
    posts.forEach((p) => acts.push({ kind: 'post', at: p.created_at, p, personal: p.category === '개인' }));
    ((d.cmts) || []).forEach((c) => {
      const p = posts.find((x) => x.id === c.post_id);
      if (!p) return;
      acts.push({ kind: 'comment', at: c.created_at, p, c, personal: p.category === '개인' });
    });
    acts.sort((a, b) => new Date(b.at) - new Date(a.at));
    const main = acts.filter((a) => !a.personal).slice(0, 10);
    const personal = acts.filter((a) => a.personal).slice(0, 5);

    const actHtml = (a) => {
      const masked = a.p.category === '고객예약';
      const linked = `#/p/${a.p.id}`;
      const postLabel = esc(snippet(dashTitle(a.p), 40));
      if (a.kind === 'post') {
        return `<li class="act-item">
          <span class="act-kind act-post">새 글</span>
          <a class="act-text" href="${linked}">${esc(dashTitle(a.p))}
            <span class="act-sub">${badge(a.p.author)}<span class="act-time">${fmtShort(a.at)}</span></span>
          </a>
        </li>`;
      }
      return `<li class="act-item">
        <span class="act-kind act-cmt">댓글</span>
        <a class="act-text" href="${linked}">${esc(masked ? maskPII(snippet(firstLine(a.c.content), 60)) : snippet(firstLine(a.c.content), 60))}
          <span class="act-sub">${badge(a.c.author || '?')}<span class="act-on">↳ ${postLabel}</span><span class="act-time">${fmtShort(a.at)}</span></span>
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
    const savedAuthor = localStorage.getItem('yes_ai_board_author');
    $('#comment-author').value = AUTHORS.includes(savedAuthor) ? savedAuthor : AUTHORS[0];

    await loadComments(id);
    if (editMode) openWriteForm(data);
  }

  async function loadComments(postId) {
    const { data, error } = await db.from('ai_board_comments')
      .select('*').eq('post_id', postId).order('created_at', { ascending: true });
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
    const savedAuthor = localStorage.getItem('yes_ai_board_author');
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
      const a = params.get('author');
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
      if (ow && AUTHORS.includes(ow)) $('#write-owner').value = ow;
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
      owner: owner && AUTHORS.includes(owner) ? owner : null,
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
     #/list · #/p/{id} · #/p/{id}/edit · #/write
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

  function setCategory(cat) {
    state.category = CATEGORIES.includes(cat) ? cat : ALL;
    state.page = 1;
    state.q = '';
    const si = $('#search-input');
    if (si) si.value = '';
    buildTabs();
    if (state.view !== 'list') showView('list');
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

    /* #/ (기본) = 대시보드, #/list = 시간순 전체 글 */
    if (path === '' || path === '/' || path === '/dashboard') {
      await loadDashboard();
      return;
    }

    if (state.category !== ALL || state.q || state.page !== 1) {
      state.category = ALL;
      state.q = '';
      state.page = 1;
      const si = $('#search-input');
      if (si) si.value = '';
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
      if (nav === 'dash') {
        if (state.view === 'dashboard') { loadDashboard(true); return; }
        location.hash = '#/';
        if (location.hash === before) loadDashboard();
        return;
      }
      if (nav === 'all') {
        if (state.view === 'list' && state.category === ALL) return;
        location.hash = '#/list';
        if (location.hash === before) setCategory(ALL);
        return;
      }
      if (nav === state.category && state.view === 'list') return;
      // 말머리도 주소로 남긴다 → #/c/업무 로 바로 열 수 있음
      location.hash = '#/c/' + encodeURIComponent(nav);
      if (location.hash === before) setCategory(nav);
    });

    /* 대시보드 토글 · 새로고침 */
    $('#dash-todo-more').addEventListener('click', () => {
      state.todoOpen = !state.todoOpen;
      renderDashboard();
    });

    $('#dash-personal-toggle').addEventListener('click', () => {
      state.personalOpen = !state.personalOpen;
      renderDashboard();
    });

    $('#dash-refresh').addEventListener('click', () => { loadDashboard(true); });

    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.q = $('#search-input').value;
      state.page = 1;
      showView('list');
      loadPosts();
    });

    $('#search-input').addEventListener('search', () => {
      if ($('#search-input').value.trim() === '' && state.q) {
        state.q = '';
        state.page = 1;
        if (state.view === 'list') loadPosts();
      }
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
    $('#btn-copy-recent').addEventListener('click', copyRecent);

    window.addEventListener('hashchange', route);
  }

  async function doLogout() {
    await db.auth.signOut().catch(() => {});
    state.session = null;
    state.member = false;
    state.loaded = false;
    state.dash = null;
    state.dashDirty = true;
    state.post = null;
    state.posts = [];
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
