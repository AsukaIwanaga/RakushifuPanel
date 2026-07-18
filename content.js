// らくしふ 客数予測パネル
// - シート「時間帯別客数予測 v2」の日付シート (例: "0718 (土)") から LE / REQ / LABOR% を取得して表示
// - シフト確定 未処理日を今日〜月末で監視

(() => {
  'use strict';

  // ===== 設定 =====
  const SHEET_ID = '1nP4a6MdEbGJAxvUfYZHtfXn-1EAA7oIwSvFdFa0GMXE';
  const TASK_SHEET_ID = '1Np93smWUpSheCj1aKu9ZGmoOLQRJ1XALy02YxfGp9lw'; // 月次タスク一覧
  const TASK_SHEET_GID = 0;
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6:00 - 23:00

  // シート側の行ラベル (G列) → パネルの列。表示したい項目はここを編集
  const HOURLY_COLS = [
    { rowLabel: 'LE',        head: 'LE',     cls: 'le' },
    { rowLabel: 'REQ（F）',   head: 'REQ F',  cls: '' },
    { rowLabel: 'REQ（K）',   head: 'REQ K',  cls: '' },
    { rowLabel: 'REQ（FK）',  head: 'REQ FK', cls: '' },
    { rowLabel: 'REQ（SUM）', head: 'REQ計',  cls: 'sum' },
  ];
  // らくしふ実シフトの genre_id → F/K 分類（GT吉祥寺元町通: 2=フロア, 3=キッチン。
  // 17=社員(REGULAR)・4=未使用 はクルーREQの比較対象外）
  const GENRES_F = [2];
  const GENRES_K = [3];
  // 正社員（この人のMGT/TRer/TRee時間は MGT H、その他の人のは CREW MGT H に計上）
  const REGULAR_STAFF = ['岩永飛鳥'];
  // 過剰人員の警告しきい値（これ以上のプラスは人件費浪費としてオレンジ表示）
  const SURPLUS_WARN = 2;
  // 業務割振タスク名 → カウント先。F/K/FK=振替、BU系=キッチン扱い、
  // MGT/TRer/TRee=OP Hに数えず MGT系へ（正社員→MGT、その他→cMGT）
  const moveGroup = (name, isRegular) => {
    if (name === 'F' || name === 'K' || name === 'FK') return name;
    if (/^BU/.test(name || '')) return 'K';
    if (['MGT', 'TRer', 'TRee'].includes(name)) return isRegular ? 'MGT' : 'cMGT';
    return null;
  };
  // ヘッダー統計 (シート上部: ラベルG列 / 値J列)
  const HEADER_LABELS = ['LABOR%', 'LABOR H', 'SALES', 'SBP'];

  // シートのCSVでの列位置: G列=index6 がラベル、6:00の値=index7 … 23:00=index24、合計=index26、ヘッダー値=index9
  const COL_LABEL = 6, COL_HOUR0 = 7, COL_TOTAL = 26, COL_HEADER_VAL = 9;

  const CONFIRM_POLL_MS = 5 * 60 * 1000; // 未確定チェックの間隔
  const URL_WATCH_MS = 1500;

  // ===== ユーティリティ =====
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseYmd = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const sheetNameFor = (d) => `${pad2(d.getMonth() + 1)}${pad2(d.getDate())} (${WEEKDAYS[d.getDay()]})`;

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function urlParams() {
    const p = new URLSearchParams(location.search);
    return { storeId: p.get('s'), from: p.get('from'), to: p.get('to') };
  }

  // ===== データ取得 =====
  // 拡張の再読込後は、開きっぱなしのタブに残った旧content scriptから見ると
  // chrome.runtime が失効する (Extension context invalidated)。以降は静かに停止する。
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const timers = [];
  let lostNotified = false;
  function contextLost() {
    timers.forEach(clearInterval);
    if (lostNotified) return;
    lostNotified = true;
    $('#stats').innerHTML =
      '<span class="err">拡張機能が更新されました。ページを再読み込みしてください</span>';
    $('#tableWrap').innerHTML = '';
    $('#tasks').innerHTML = '';
    $('#unconfirmed').innerHTML = '';
  }

  function fetchSheet(date) {
    const sheetName = sheetNameFor(date);
    return new Promise((resolve) => {
      if (!alive()) return resolve({ error: '拡張更新済み・要ページ再読込', sheetName });
      try {
        chrome.runtime.sendMessage({ type: 'fetchSheetCsv', sheetId: SHEET_ID, sheetName }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ error: chrome.runtime.lastError?.message || '応答なし', sheetName });
          } else if (!res.ok || !res.text || res.text.trim().startsWith('<')) {
            // ログイン切れ or シートなし → HTMLが返る
            resolve({ error: `シート取得失敗 (${res.status ?? res.error})`, sheetName });
          } else {
            resolve({ rows: parseCSV(res.text), sheetName });
          }
        });
      } catch {
        resolve({ error: '拡張更新済み・要ページ再読込', sheetName });
      }
    });
  }

  function extractSheetData(rows) {
    const header = {};
    for (const r of rows.slice(0, 6)) {
      const label = (r[COL_LABEL] || '').trim();
      if (HEADER_LABELS.includes(label)) header[label] = (r[COL_HEADER_VAL] || '').trim();
    }
    const hourly = {};
    for (const col of HOURLY_COLS) {
      const r = rows.find((row) => (row[COL_LABEL] || '').trim() === col.rowLabel);
      hourly[col.rowLabel] = r
        ? { hours: HOURS.map((h) => (r[COL_HOUR0 + (h - 6)] || '').trim()), total: (r[COL_TOTAL] || '').trim() }
        : null;
    }
    return { header, hourly };
  }

  // ===== らくしふ実シフト → 時間帯別実人数 =====
  // 業務割振タスクの id→名前 対応表（F/K/FK 振替の判定に使用）
  let storeTaskMapCache = null;
  async function fetchStoreTaskMap(storeId) {
    if (storeTaskMapCache) return storeTaskMapCache;
    const r = await fetch(`/ajax/admin/store_tasks?store_id=${storeId}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`store_tasks HTTP ${r.status}`);
    const j = await r.json();
    storeTaskMapCache = Object.fromEntries((j.store_tasks || []).map((t) => [t.id, t.name]));
    return storeTaskMapCache;
  }

  // /ajax/admin/v2/schedules を対象日1日分fetchし、休憩(rest_times)控除済みの
  // 人時カバレッジを時間帯別に集計。業務割振が F/K/FK のタスク時間帯は所属genreに
  // かかわらずそのグループへ振替（例: フロア所属者のKタスク中はKにカウント）。
  async function fetchActual(date) {
    const p = new URLSearchParams(location.search);
    const storeId = p.get('s');
    const genreIds = p.getAll('g');
    if (!storeId) return null;
    const q = new URLSearchParams();
    q.set('page_ctx_name', 'admin');
    q.set('store_id', storeId);
    for (const g of (genreIds.length ? genreIds : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
    q.set('start_date', ymd(date));
    q.set('end_date', ymd(date));
    q.set('is_staff_print_page', 'false');
    const [r, taskMap] = await Promise.all([
      fetch('/ajax/admin/v2/schedules?' + q, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      }),
      fetchStoreTaskMap(storeId).catch(() => ({})), // 対応表が取れなくても素の集計は続行
    ]);
    if (!r.ok) throw new Error(`シフトAPI HTTP ${r.status}`);
    const j = await r.json();

    const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(b1, a1));
    // 区間[a1,a2)のうち時間帯hに掛かる正味分数（休憩控除後）
    const net = (sh, a1, a2, h) => {
      const s = Math.max(a1, h * 60), e = Math.min(a2, h * 60 + 60);
      let m = Math.max(0, e - s);
      if (m === 0) return 0;
      for (const rt of sh.rest_times || []) {
        m -= overlap(rt.start_hour * 60 + rt.start_minute, rt.end_hour * 60 + rt.end_minute, s, e);
      }
      return Math.max(0, m) / 60;
    };

    const zero = () => HOURS.map(() => 0);
    const act = { F: zero(), K: zero(), FK: zero(), MGT: zero(), cMGT: zero(), total: zero() };
    // 正社員判定（MGT/TRer/TRee の計上先の振り分けに使用）
    const regularIds = new Set((j.users || [])
      .filter((u) => REGULAR_STAFF.includes((u.name || '').replace(/\s+/g, '')))
      .map((u) => u.id));
    const dateStr = ymd(date);
    // 重複対策: APIは前後日のシフトも返すため対象日でフィルタ（必須）。
    // 万一の真の重複登録にも、同一人物1時間=最大1.0人の上限で保険。
    const userHour = {}; // user_id -> 時間帯ごとの計上済み人時
    const shifts = (j.instructed || [])
      .filter((sh) => sh.date === dateStr && !sh.off && !sh.is_deleted &&
                      String(sh.attending_store_id) === String(storeId))
      .sort((a, b) => a.user_id - b.user_id || a.id - b.id);
    for (const sh of shifts) {
      const g = sh.attending_genre_id;
      const grp = GENRES_F.includes(g) ? 'F' : GENRES_K.includes(g) ? 'K' : null;
      if (!grp) continue; // 社員(REGULAR)のgenre等はクルーREQ比較の対象外

      // 振替タスク区間（シフト範囲にクリップ・開始順で先勝ち）
      const isReg = regularIds.has(sh.user_id);
      const moves = (sh.instructed_schedule_store_tasks || [])
        .map((t) => ({ grp: moveGroup(taskMap[t.store_task_id], isReg), id: t.id,
                       s: Math.max(t.start_time_as_min, sh.start_as_min),
                       e: Math.min(t.end_time_as_min, sh.end_as_min) }))
        .filter((t) => t.grp && t.e > t.s)
        .sort((a, b) => a.s - b.s || a.id - b.id);

      const uh = (userHour[sh.user_id] ||= HOURS.map(() => 0));
      HOURS.forEach((h, i) => {
        let total = net(sh, sh.start_as_min, sh.end_as_min, h);
        total = Math.min(total, Math.max(0, 1 - uh[i])); // 重複登録時: 1人1時間まで
        if (total === 0) return;
        uh[i] += total;
        let alloc = 0, mgt = 0;
        for (const mv of moves) {
          const m = Math.min(net(sh, mv.s, mv.e, h), total - alloc); // タスク重複: 先勝ち
          if (m <= 0) continue;
          act[mv.grp][i] += m;
          alloc += m;
          if (mv.grp === 'MGT' || mv.grp === 'cMGT') mgt += m;
        }
        act[grp][i] += Math.max(0, total - alloc); // 振替以外は所属グループ
        act.total[i] += total - mgt;               // 実計(OP H)はMGT系を除く
      });
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    act.sum = {};
    for (const k of ['F', 'K', 'FK', 'MGT', 'cMGT', 'total']) {
      act.sum[k] = r1(act[k].reduce((a, b) => a + b, 0));
      act[k] = act[k].map(r1);
    }
    return act;
  }

  // ===== 月次タスク（月次タスク一覧シート） =====
  let taskRowsCache = null;
  const fetchCsv = (msg) => new Promise((resolve) => {
    if (!alive()) return resolve(null);
    try {
      chrome.runtime.sendMessage({ type: 'fetchSheetCsv', sheetId: TASK_SHEET_ID, ...msg }, resolve);
    } catch { resolve(null); }
  });

  async function fetchTaskRows() {
    if (taskRowsCache) return taskRowsCache;
    const [def, reqs] = await Promise.all([
      fetchCsv({ gid: TASK_SHEET_GID }),          // 定義タブ (月次M + 週次W)
      fetchCsv({ sheetName: '要請' }),            // 要請タブ (vaultから定期書き出し・無ければ無視)
    ]);
    if (!def || !def.ok || !def.text || def.text.trim().startsWith('<')) {
      throw new Error('タスクシート取得失敗');
    }
    const parseTab = (text) => {
      const rows = parseCSV(text);
      const head = rows.findIndex((r) => (r[0] || '').trim() === 'ID');
      return head < 0 ? [] : rows.slice(head + 1).filter((r) => (r[0] || '').trim());
    };
    const defRows = parseTab(def.text).map((r) => ({
      id: r[0].trim(), task: (r[1] || '').trim(),
      from: parseInt(r[2], 10), to: parseInt(r[3], 10),
      rule: (r[4] || '').trim(), note: (r[5] || '').trim(),
    }));
    // 要請タブ: ID / タスク / 期限(YYYY-MM-DD) / source / 起票日 — 未完了のみが書き出されている前提
    const reqRows = (reqs && reqs.ok && reqs.text && !reqs.text.trim().startsWith('<'))
      ? parseTab(reqs.text).map((r) => ({
          id: r[0].trim(), task: (r[1] || '').trim(), due: (r[2] || '').trim(),
          source: (r[3] || '').trim(), request: true,
        }))
      : [];
    taskRowsCache = { defRows, reqRows };
    return taskRowsCache;
  }

  const isThirdTuesday = (d) => d.getDay() === 2 && d.getDate() >= 15 && d.getDate() <= 21;
  const lastDay = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const WD_TOKENS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

  function taskMatches(t, d) {
    if (t.rule === '3TUE') return isThirdTuesday(d);
    if (t.rule === 'EOM') return d.getDate() === lastDay(d);
    // 週次: 曜日トークン (例 "MON" / "MON,THU")
    if (/^(SUN|MON|TUE|WED|THU|FRI|SAT)(,(SUN|MON|TUE|WED|THU|FRI|SAT))*$/.test(t.rule)) {
      return t.rule.split(',').some((tok) => WD_TOKENS[tok.trim()] === d.getDay());
    }
    return Number.isFinite(t.from) && Number.isFinite(t.to) &&
      d.getDate() >= t.from && d.getDate() <= t.to;
  }

  // 未確定日: シフト確定ダイアログ用の候補APIをそのまま利用。
  // レスポンス形式は環境依存の可能性があるため防御的にパースし、生JSONはconsoleに出す。
  async function fetchUnconfirmed(storeId) {
    const today = new Date();
    const eom = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const url = `/ajax/admin/v2/schedules/shift_confirm_target_candidates?store_id=${storeId}` +
      `&start_date=${ymd(today)}&end_date=${ymd(eom)}`;
    const r = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    // 実形式 (2026-07-18検証済み):
    // {shift_confirm_target_candidates: [{genre_id, dates: [{date, need_to_confirm}]}]}
    // need_to_confirm === true の日が「シフト確定が必要＝未確定」
    const days = new Set();
    for (const g of json.shift_confirm_target_candidates || []) {
      for (const d of g.dates || []) {
        if (d.need_to_confirm === true) days.add(d.date);
      }
    }
    return [...days].sort();
  }

  // ===== UI =====
  const host = document.createElement('div');
  host.id = 'rakushifu-forecast-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Hiragino Sans", sans-serif; }
      #toggle {
        position: fixed; right: 12px; top: 12px; z-index: 2147483646;
        width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
        background: #2c6e49; color: #fff; font-size: 18px; box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      #toggle .badge {
        position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
        border-radius: 9px; background: #d64545; color: #fff; font-size: 11px;
        line-height: 18px; padding: 0 4px; display: none;
      }
      #panel {
        position: fixed; right: 12px; top: 64px; z-index: 2147483646;
        width: 680px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 80px); overflow-y: auto;
        background: #fff; border: 1px solid #ccc; border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,.25); padding: 10px; display: none;
        font-size: 13px; color: #222;
      }
      #tableWrap { overflow-x: auto; }
      #panel.open { display: block; }
      .nav { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .nav b { flex: 1; text-align: center; font-size: 14px; }
      .nav button {
        border: 1px solid #ccc; background: #f5f5f5; border-radius: 5px;
        cursor: pointer; padding: 3px 10px; font-size: 13px;
      }
      .nav button.accent { background: #2c6e49; color: #fff; border-color: #2c6e49; font-weight: 700; }
      .stats { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .chip { background: #eef4f0; border-radius: 5px; padding: 2px 7px; }
      .chip b { color: #2c6e49; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 2px 5px; text-align: center; font-size: 12px; white-space: nowrap; }
      th { background: #f0f0f0; color: #555; }
      th.row-head, td.row-head { text-align: left; color: #333; font-weight: 600; }
      td.now, th.now { background: #fff7d6; }
      tr.le td { color: #1a5fb4; font-weight: 600; }
      tr.sum td { font-weight: 600; }
      td.total, th.total { border-left: 2px solid #999; font-weight: 700; background: #fafafa; }
      tr.act-first td { border-top: 2px solid #999; }
      tr.act td { color: #6b21a8; }
      tr.act td.row-head { color: #6b21a8; }
      tr.act td.short { background: #fdecec; color: #b02a2a; font-weight: 700; }
      tr.mgt td, tr.mgt td.row-head { color: #999; font-weight: 400; }
      tr.diff td { border-top: 2px solid #999; color: #999; }
      tr.diff td.short { background: #fdecec; color: #b02a2a; font-weight: 700; }
      tr.diff td.over { background: #e8f5ec; color: #1e7a44; font-weight: 700; }
      tr.diff td.short-lite { color: #b02a2a; font-weight: 700; } /* |不足|<1: 白地に赤字 */
      tr.diff td.over-lite { color: #1e7a44; font-weight: 700; }  /* 0<余剰<1: 白地に緑字 */
      th.short-mark { background: #d64545; color: #fff; }
      .section-title { font-weight: 700; margin: 8px 0 4px; font-size: 13px; }
      .section-title.fold { cursor: pointer; user-select: none; }
      .unconfirmed { display: flex; flex-wrap: wrap; gap: 4px; }
      .unconfirmed .day {
        background: #fdecec; color: #b02a2a; border: 1px solid #e8b4b4;
        border-radius: 5px; padding: 2px 7px;
      }
      .allok { color: #2c6e49; font-weight: 600; }
      .err { color: #b02a2a; }
      .muted { color: #888; font-size: 12px; }
      .tasks .task { display: flex; gap: 6px; padding: 2px 0; border-bottom: 1px dotted #eee; align-items: flex-start; }
      .tasks .task .tid {
        flex: 0 0 auto; font-weight: 700; color: #2c6e49; font-size: 12px;
        background: #eef4f0; border-radius: 4px; padding: 0 5px; align-self: center;
      }
      .tasks .task.ext .tid { color: #a15c00; background: #fdf3e3; }
      .tasks .task .tnote { color: #888; font-size: 11px; }
    </style>
    <button id="toggle" title="客数予測パネル">📊<span class="badge" id="badge"></span></button>
    <div id="panel">
      <div class="nav">
        <button id="prev">◀</button>
        <b id="dateLabel">-</b>
        <button id="next">▶</button>
        <button id="reload" class="accent">更新</button>
      </div>
      <div id="stats" class="stats"></div>
      <div id="tableWrap"></div>
      <div class="section-title fold" id="tasksTitle"><span id="taskFold">▾</span> タスク 月次/週次/要請（<span id="taskDate">-</span>）</div>
      <div id="tasks" class="tasks muted">読込中…</div>
      <div class="section-title">シフト確定 未処理日（今日〜月末）</div>
      <div id="unconfirmed" class="unconfirmed muted">確認中…</div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('#panel'), badge = $('#badge');

  let targetDate = parseYmd(urlParams().from || '') || new Date();
  let lastHref = location.href;

  $('#toggle').addEventListener('click', () => {
    panel.classList.toggle('open');
    localStorage.setItem('rfPanelOpen', panel.classList.contains('open') ? '1' : '0');
  });
  if (localStorage.getItem('rfPanelOpen') === '1') panel.classList.add('open');

  $('#prev').addEventListener('click', () => { targetDate.setDate(targetDate.getDate() - 1); renderSheet(); });
  $('#next').addEventListener('click', () => { targetDate.setDate(targetDate.getDate() + 1); renderSheet(); });
  $('#reload').addEventListener('click', () => {
    taskRowsCache = null; // タスクシートも再取得
    renderSheet();
    renderUnconfirmed();
  });

  // タスクセクションの折りたたみ（タイトルクリックで開閉・状態は記憶）
  function applyTasksFold() {
    const hidden = localStorage.getItem('rfTasksHidden') === '1';
    $('#tasks').style.display = hidden ? 'none' : '';
    $('#taskFold').textContent = hidden ? '▸' : '▾';
  }
  $('#tasksTitle').addEventListener('click', () => {
    const hidden = localStorage.getItem('rfTasksHidden') === '1';
    localStorage.setItem('rfTasksHidden', hidden ? '0' : '1');
    applyTasksFold();
  });
  applyTasksFold();

  // ===== 週間アサイン（人別: 週N日/Nh を名前横にバッジ表示） =====
  let lastWeekStats = null;
  async function fetchWeekStats(date) {
    const p = new URLSearchParams(location.search);
    const storeId = p.get('s');
    if (!storeId) return null;
    const d = new Date(date), dow = (d.getDay() + 6) % 7; // 月曜始まり
    const mon = new Date(d); mon.setDate(d.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const q = new URLSearchParams();
    q.set('page_ctx_name', 'admin');
    q.set('store_id', storeId);
    for (const g of (p.getAll('g').length ? p.getAll('g') : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
    q.set('start_date', ymd(mon));
    q.set('end_date', ymd(sun));
    q.set('is_staff_print_page', 'false');
    const r = await fetch('/ajax/admin/v2/schedules?' + q, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const um = Object.fromEntries((j.users || []).map((u) => [u.id, (u.name || '').replace(/\s+/g, '')]));
    const per = {}; // 名前 -> {days:Set, mins}
    for (const sh of j.instructed || []) {
      if (sh.off || sh.is_deleted) continue;
      if (sh.date < ymd(mon) || sh.date > ymd(sun)) continue; // APIの前後日パディング除去
      const nm = um[sh.user_id];
      if (!nm) continue;
      let mins = sh.end_as_min - sh.start_as_min;
      for (const rt of sh.rest_times || []) {
        mins -= Math.max(0, (rt.end_hour * 60 + rt.end_minute) - (rt.start_hour * 60 + rt.start_minute));
      }
      const st = (per[nm] ||= { days: new Set(), mins: 0 });
      st.days.add(sh.date);
      st.mins += Math.max(0, mins);
    }
    return per;
  }

  function updateWeekBadges(per) {
    if (!per) return;
    for (const nameEl of document.querySelectorAll('.user-cell .name')) {
      const nm = (nameEl.textContent || '').replace(/\s+/g, '');
      const st = per[nm];
      let b = nameEl.parentElement?.querySelector('.rf-week-badge');
      if (!st) { b?.remove(); continue; }
      if (!b) {
        b = document.createElement('span');
        b.className = 'rf-week-badge';
        b.style.cssText = 'margin-left:4px;font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#2c6e49;background:#eef4f0;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;';
        nameEl.after(b);
      }
      b.textContent = `週${st.days.size}日/${Math.round(st.mins / 6) / 10}h`;
      b.title = `この週(月〜日)のアサイン合計（休憩控除後・ヘルプ含む）`;
    }
  }

  // ===== らくしふ画面上の不足ヒートバー（フロア/キッチン別） =====
  // 各セクションの時間軸ヘッダー(.time-header)直下に、そのセクションの 実−REQ を行として差し込む。
  // フロアセクション=F、キッチンセクション=K。不足=赤、SURPLUS_WARN以上のプラス=オレンジ(浪費警告)。
  // 表示中の日とパネルの対象日が一致するOneDayのときだけ出す。
  let lastStrip = null; // {catDiffs, tip} Vue再描画後の張り直し用
  let lastLE = null;
  const onOneDayTarget = () => {
    const p = new URLSearchParams(location.search);
    const fromD = parseYmd(p.get('from') || '');
    return p.get('u') === 'OneDay' && fromD && ymd(fromD) === ymd(targetDate);
  };

  function updateStrips(catDiffs, tipFor) {
    document.querySelectorAll('.rf-heat-strip').forEach((e) => e.remove());
    lastStrip = catDiffs ? { catDiffs, tip: tipFor } : null;
    if (!catDiffs || !onOneDayTarget()) return;
    // セクション見出し(フロア/キッチン)→ 直後の time-header を対応付け
    const titles = [...document.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /^(フロア|キッチン)$/.test((e.textContent || '').trim()));
    const headers = [...document.querySelectorAll('.time-header')];
    const used = new Set();
    for (const t of titles) {
      const cat = t.textContent.trim() === 'フロア' ? 'F' : 'K';
      const header = headers.find((hd) => !used.has(hd) &&
        (t.compareDocumentPosition(hd) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!header || !catDiffs[cat]) continue;
      used.add(header);
      const strip = document.createElement('div');
      strip.className = 'rf-heat-strip';
      strip.style.cssText =
        'display:flex;height:16px;font:700 10px/16px -apple-system,"Hiragino Sans",sans-serif;text-align:center;';
      for (const c of header.children) {
        const txt = (c.textContent || '').trim();
        const h = /^\d{1,2}$/.test(txt) ? +txt : null;
        const i = h !== null ? HOURS.indexOf(h) : -1;
        const cell = document.createElement('div');
        cell.style.cssText = `width:${c.getBoundingClientRect().width}px;flex:none;`;
        const d = i >= 0 ? catDiffs[cat][i] : undefined;
        if (d !== undefined && d !== null) {
          // |差分|<1 は軽微 → 塗りつぶさず白地に色文字。±1以上のみ塗りつぶしで強調
          if (d < 0) {
            cell.textContent = d;
            cell.style.cssText += d > -1
              ? 'color:#d64545;'
              : 'background:#d64545;color:#fff;border-radius:3px;';
          } else if (d >= SURPLUS_WARN) {
            cell.textContent = `+${d}`;
            cell.style.cssText += 'background:#2e9e5b;color:#fff;border-radius:3px;';
          } else if (d > 0 && d < 1) {
            cell.textContent = `+${d}`;
            cell.style.cssText += 'color:#2e9e5b;';
          } else {
            cell.textContent = d > 0 ? `+${d}` : '0';
            cell.style.cssText += 'color:#9aa8b5;';
          }
          if (tipFor) cell.title = tipFor(i);
        }
        strip.appendChild(cell);
      }
      header.after(strip);
    }
  }

  // ===== 前年客数・修正客数の下に LE客数 行と 必要人数(REQ計) 行を注入 =====
  function updateLERows(le, reqPack) {
    document.querySelectorAll('.rf-le-row, .rf-req-row').forEach((e) => e.remove());
    lastLE = le ? { le, reqPack } : null;
    if (!le || !onOneDayTarget()) return;
    const labels = [...document.querySelectorAll('th.metrics-row-header')]
      .filter((th) => (th.textContent || '').includes('修正客数'));
    for (const th of labels) {
      const tr = th.closest('tr');
      if (!tr) continue;
      // 修正客数行のクローンにラベルと値を差し替えた行を作る
      const mkRow = (cls, labelHtml, vals, color, tipFn) => {
        const clone = tr.cloneNode(true);
        clone.classList.add(cls);
        const cth = clone.querySelector('th.metrics-row-header');
        if (cth) cth.innerHTML = labelHtml;
        // 時刻6..24の19セルが並ぶコンテナを探して値を差し替え
        const rowCells = [...clone.querySelectorAll('*')].find((e) => e.children.length === 19);
        if (rowCells) {
          [...rowCells.children].forEach((cell, idx) => {
            cell.textContent = idx < HOURS.length ? (vals[idx] || '') : '';
            cell.style.color = color;
            cell.style.fontWeight = '700';
            if (tipFn && idx < HOURS.length) cell.title = tipFn(idx);
          });
        }
        return clone;
      };
      const leRow = mkRow('rf-le-row',
        `<span style="font-weight:700;color:#1a5fb4;">LE客数 (合計: ${le.total || '-'})</span>`,
        le.hours, '#1a5fb4');
      tr.after(leRow);

      // 必要人数はセクション別: フロア=F+FK / キッチン=K+FK（FKは両方に重複表示）
      const sec = sectionOf(tr);
      let anchor = leRow;
      const tipSum = reqPack?.sum ? (i) => `REQ計 ${reqPack.sum.hours[i] || '0'}` : null;
      const addReq = (label, row, color) => {
        if (!row) return;
        const r = mkRow('rf-req-row',
          `<span style="font-weight:700;color:${color};">${label} (合計: ${row.total || '-'})</span>`,
          row.hours, color, tipSum);
        anchor.after(r);
        anchor = r;
      };
      if (sec === 'キッチン') {
        addReq('必要K', reqPack?.k, '#2c6e49');
        addReq('必要FK', reqPack?.fk, '#0e7490');
      } else if (sec === 'フロア') {
        addReq('必要F', reqPack?.f, '#2c6e49');
        addReq('必要FK', reqPack?.fk, '#0e7490');
      } else {
        addReq('必要人数', reqPack?.sum, '#2c6e49'); // セクション判別不能時は計を出す
      }
    }
  }

  // 行の属するセクション見出し(フロア/キッチン)を特定
  function sectionOf(el) {
    const titles = [...document.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /^(フロア|キッチン)$/.test((e.textContent || '').trim()));
    let best = null;
    for (const t of titles) {
      if (t.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = t;
    }
    return best ? best.textContent.trim() : null;
  }

  // ページ本体のシフト保存(page_hook.jsが検知)→少し待って再計算
  let editRefreshTimer = null;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.__rfPanel !== 'dataChanged') return;
    clearTimeout(editRefreshTimer);
    editRefreshTimer = setTimeout(() => {
      if (!alive()) return contextLost();
      renderSheet();
    }, 800);
  });

  async function renderSheet() {
    $('#dateLabel').textContent =
      `${targetDate.getMonth() + 1}/${targetDate.getDate()} (${WEEKDAYS[targetDate.getDay()]})`;
    $('#stats').innerHTML = '<span class="muted">読込中…</span>';
    $('#tableWrap').innerHTML = '';

    const [res, actual] = await Promise.all([
      fetchSheet(targetDate),
      fetchActual(targetDate).catch((e) => ({ error: e.message })),
    ]);
    if (res.error) {
      $('#stats').innerHTML = `<span class="err">${res.error}: ${res.sheetName}</span>`;
      renderTasks(); // 日付シートが無い日でもタスク欄は独立して更新する
      updateStrips(null);
      updateLERows(null);
      return;
    }
    const { header, hourly } = extractSheetData(res.rows);

    $('#stats').innerHTML = HEADER_LABELS
      .map((l) => `<span class="chip">${l} <b>${header[l] || '-'}</b></span>`)
      .join('');

    // 時間を横軸に: 列 = 6:00〜23:00 + 計、行 = LE / REQ F / REQ K / REQ計
    const nowHour = new Date().getHours();
    const isToday = ymd(targetDate) === ymd(new Date());
    const nowCls = (h) => (isToday && h === nowHour ? ' now' : '');

    // 実人数 (らくしふ現シフト・休憩控除済) と REQ の比較。マイナス＝不足
    const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
    const req = hourly['REQ（SUM）'];
    const reqF = hourly['REQ（F）'], reqK = hourly['REQ（K）'];
    const hasActual = actual && !actual.error;
    const diffs = (hasActual && req)
      ? HOURS.map((h, i) => {
          if (!req.hours[i] && !actual.total[i]) return null; // REQも実人数も無い時間帯は営業時間外
          return Math.round((actual.total[i] - num(req.hours[i])) * 10) / 10;
        })
      : null;
    // 時刻ヘッダーの赤塗りは不足1人以上のみ（軽微な不足では騒がない）
    const shortAt = (i) => diffs && diffs[i] !== null && diffs[i] <= -1;

    const headRow =
      `<tr><th class="row-head"></th>` +
      HOURS.map((h, i) =>
        `<th class="${nowCls(h)}${shortAt(i) ? ' short-mark' : ''}">${h}</th>`).join('') +
      `<th class="total">計</th></tr>`;

    const bodyRows = HOURLY_COLS.map((c) => {
      const data = hourly[c.rowLabel];
      const cells = HOURS.map((h, i) =>
        `<td class="${nowCls(h)}">${data ? (data.hours[i] || '') : '?'}</td>`).join('');
      return `<tr class="${c.cls}"><td class="row-head">${c.head}</td>${cells}` +
        `<td class="total">${data?.total ?? '?'}</td></tr>`;
    }).join('');

    let actualRows = '', diffRow = '';
    if (hasActual) {
      const fmt = (v) => (v === 0 ? '' : String(v));
      // 実F/実K: 対応するREQ(F/K)を下回る時間帯は赤
      const actRow = (arr, reqRow, label, sumV, extra = '') => {
        const cells = HOURS.map((h, i) => {
          const short = reqRow && num(reqRow.hours[i]) > arr[i] + 1e-9;
          return `<td class="${nowCls(h)}${short ? ' short' : ''}">${fmt(arr[i])}</td>`;
        }).join('');
        return `<tr class="act${extra}"><td class="row-head">${label}</td>${cells}` +
          `<td class="total">${sumV}</td></tr>`;
      };
      actualRows =
        actRow(actual.F, reqF, '実F', actual.sum.F, ' act-first') +
        actRow(actual.K, reqK, '実K', actual.sum.K) +
        actRow(actual.FK, hourly['REQ（FK）'], '実FK', actual.sum.FK) +
        actRow(actual.total, req, '実計', actual.sum.total) +
        // MGT系はOP H外の参考表示（実計・不足には入らない）
        (actual.sum.MGT > 0 ? actRow(actual.MGT, null, 'MGT', actual.sum.MGT, ' mgt') : '') +
        (actual.sum.cMGT > 0 ? actRow(actual.cMGT, null, 'cMGT', actual.sum.cMGT, ' mgt') : '');

      if (diffs) {
        const cells = HOURS.map((h, i) => {
          const d = diffs[i];
          if (d === null) return `<td class="${nowCls(h)}"></td>`;
          const txt = d < 0 ? d : (d > 0 ? `+${d}` : '±0');
          const cls = d < 0
            ? (d > -1 ? ' short-lite' : ' short')
            : d >= SURPLUS_WARN ? ' over'
            : (d > 0 && d < 1) ? ' over-lite' : '';
          return `<td class="${nowCls(h)}${cls}">${txt}</td>`;
        }).join('');
        const totalD = Math.round((actual.sum.total - num(req?.total)) * 10) / 10;
        diffRow = `<tr class="diff"><td class="row-head">不足</td>${cells}` +
          `<td class="total${totalD < 0 ? ' short' : ''}">${totalD < 0 ? totalD : `+${totalD}`}</td></tr>`;
      }
    }

    $('#tableWrap').innerHTML = `<table>${headRow}${bodyRows}${actualRows}${diffRow}</table>` +
      (actual?.error ? `<div class="err">実人数取得失敗: ${actual.error}</div>` : '');
    // 画面上のヒートバー: F/K別の差分（FKと計はツールチップで見せる）
    const reqFK = hourly['REQ（FK）'];
    const mkDiff = (arr, reqRow) => (hasActual && arr) ? HOURS.map((h, i) => {
      if (!reqRow?.hours?.[i] && !arr[i]) return null;
      return Math.round((arr[i] - num(reqRow?.hours?.[i])) * 10) / 10;
    }) : null;
    const catDiffs = hasActual ? {
      F: mkDiff(actual.F, reqF), K: mkDiff(actual.K, reqK), FK: mkDiff(actual.FK, reqFK),
    } : null;
    const tip = (i) =>
      `${HOURS[i]}時  F ${actual?.F?.[i] ?? '-'}/${reqF?.hours?.[i] || '0'}` +
      ` ・ K ${actual?.K?.[i] ?? '-'}/${reqK?.hours?.[i] || '0'}` +
      ` ・ FK ${actual?.FK?.[i] ?? '-'}/${reqFK?.hours?.[i] || '0'}` +
      ` ・ 計 ${actual?.total?.[i] ?? '-'}/${req?.hours?.[i] || '0'} (実/REQ)`;
    updateStrips(catDiffs, tip);
    updateLERows(hourly['LE'], { sum: req, f: reqF, k: reqK, fk: reqFK });
    // 週間アサインバッジ（非同期・失敗しても本体表示に影響させない）
    fetchWeekStats(targetDate)
      .then((per) => { lastWeekStats = per; updateWeekBadges(per); })
      .catch(() => {});
    renderTasks();
  }

  async function renderTasks() {
    const el = $('#tasks');
    $('#taskDate').textContent = `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;
    try {
      const { defRows, reqRows } = await fetchTaskRows();
      const hits = defRows.filter((t) => taskMatches(t, targetDate));
      const today = ymd(new Date());
      const chip = (t) => {
        if (t.request) {
          const overdue = t.due && t.due < today;
          return `<div class="task req${overdue ? ' ext' : ''}">` +
            `<span class="tid">要請</span>` +
            `<span class="ttext">${t.task}` +
            `<div class="tnote">${overdue ? '⚠期限超過 ' : ''}${t.due ? `期限 ${t.due}` : ''}` +
            `${t.source ? ` / ${t.source}` : ''}</div></span></div>`;
        }
        return `<div class="task${t.rule === '外部' ? ' ext' : ''}">` +
          `<span class="tid">${t.id}</span>` +
          `<span class="ttext">${t.task}${t.rule === '外部' ? '（外部日程・行動計画参照）' : ''}` +
          (t.note ? `<div class="tnote">${t.note}</div>` : '') +
          `</span></div>`;
      };
      const html = hits.map(chip).join('') + reqRows.map(chip).join('');
      el.innerHTML = html || '<span class="muted">該当なし</span>';
    } catch (e) {
      el.innerHTML = `<span class="err">${e.message}</span>`;
    }
  }

  async function renderUnconfirmed() {
    const { storeId } = urlParams();
    const el = $('#unconfirmed');
    if (!storeId) { el.innerHTML = '<span class="muted">store_id 不明</span>'; return; }
    try {
      const days = await fetchUnconfirmed(storeId);
      if (days.length === 0) {
        el.innerHTML = '<span class="allok">✓ すべて確定済み</span>';
        badge.style.display = 'none';
      } else {
        el.innerHTML = days.map((d) => {
          const dt = parseYmd(d);
          return `<span class="day">${dt.getMonth() + 1}/${dt.getDate()} (${WEEKDAYS[dt.getDay()]})</span>`;
        }).join('');
        badge.textContent = days.length;
        badge.style.display = 'block';
      }
    } catch (e) {
      el.innerHTML = `<span class="err">取得失敗: ${e.message}</span>`;
    }
  }

  // URL変化 (日付移動・ビュー切替) を監視してパネルの対象日を追従
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    // Vueの再描画でバッジ/バー/LE行が消えた場合の張り直し（軽量）
    if (lastWeekStats) updateWeekBadges(lastWeekStats);
    if (lastStrip && !document.querySelector('.rf-heat-strip')) updateStrips(lastStrip.catDiffs, lastStrip.tip);
    if (lastLE && !document.querySelector('.rf-le-row')) updateLERows(lastLE.le, lastLE.reqPack);
    if (location.href === lastHref) return;
    lastHref = location.href;
    const d = parseYmd(urlParams().from || '');
    if (d && ymd(d) !== ymd(targetDate)) { targetDate = d; renderSheet(); }
  }, URL_WATCH_MS));

  // 過去のチェック機能(v1.5.x)が残したlocalStorageキーを掃除
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('rfDone:')) localStorage.removeItem(k);
  }
  renderSheet();
  renderUnconfirmed();
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    renderUnconfirmed();
  }, CONFIRM_POLL_MS));
  // 定期更新（画面上のヒートバーはパネルの開閉に関係なく維持する）
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    renderSheet();
  }, 2 * 60 * 1000));
})();
