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
  function fetchSheet(date) {
    const sheetName = sheetNameFor(date);
    return new Promise((resolve) => {
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
  // /ajax/admin/v2/schedules を対象日1日分fetchし、休憩控除済みの人時カバレッジを時間帯別に集計
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
    const r = await fetch('/ajax/admin/v2/schedules?' + q, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`シフトAPI HTTP ${r.status}`);
    const j = await r.json();

    const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(b1, a1));
    const cov = (sh, h) => {
      let m = overlap(sh.start_as_min, sh.end_as_min, h * 60, h * 60 + 60);
      for (const rt of sh.rest_times || []) {
        m -= overlap(rt.start_hour * 60 + rt.start_minute, rt.end_hour * 60 + rt.end_minute, h * 60, h * 60 + 60);
      }
      return Math.max(0, m) / 60;
    };

    const zero = () => HOURS.map(() => 0);
    const act = { F: zero(), K: zero(), total: zero() };
    for (const sh of j.instructed || []) {
      if (sh.off || sh.is_deleted) continue;
      if (String(sh.attending_store_id) !== String(storeId)) continue; // 他店ヘルプ出勤は除外
      const g = sh.attending_genre_id;
      const grp = GENRES_F.includes(g) ? 'F' : GENRES_K.includes(g) ? 'K' : null;
      if (!grp) continue; // 社員(REGULAR)等はクルーREQ比較の対象外
      HOURS.forEach((h, i) => {
        const c = cov(sh, h);
        act[grp][i] += c;
        act.total[i] += c;
      });
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    for (const k of ['F', 'K', 'total']) act[k] = act[k].map(r1);
    act.sum = { F: r1(act.F.reduce((a, b) => a + b, 0)), K: r1(act.K.reduce((a, b) => a + b, 0)),
                total: r1(act.total.reduce((a, b) => a + b, 0)) };
    return act;
  }

  // ===== 月次タスク（月次タスク一覧シート） =====
  let taskRowsCache = null;
  async function fetchTaskRows() {
    if (taskRowsCache) return taskRowsCache;
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'fetchSheetCsv', sheetId: TASK_SHEET_ID, gid: TASK_SHEET_GID }, resolve);
    });
    if (!res || !res.ok || !res.text || res.text.trim().startsWith('<')) {
      throw new Error('タスクシート取得失敗');
    }
    const rows = parseCSV(res.text);
    const head = rows.findIndex((r) => (r[0] || '').trim() === 'ID');
    taskRowsCache = rows.slice(head + 1)
      .filter((r) => (r[0] || '').trim())
      .map((r) => ({
        id: r[0].trim(), task: (r[1] || '').trim(),
        from: parseInt(r[2], 10), to: parseInt(r[3], 10),
        rule: (r[4] || '').trim(), note: (r[5] || '').trim(),
      }));
    return taskRowsCache;
  }

  const isThirdTuesday = (d) => d.getDay() === 2 && d.getDate() >= 15 && d.getDate() <= 21;
  const lastDay = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  function taskMatches(t, d) {
    if (t.rule === '3TUE') return isThirdTuesday(d);
    if (t.rule === 'EOM') return d.getDate() === lastDay(d);
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
    console.debug('[客数予測パネル] shift_confirm_target_candidates raw:', json);

    // 日付らしき文字列を再帰的に収集。confirm/fix系のbooleanフラグがあれば true=確定済み として除外
    const byDate = new Map();
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        const dates = [];
        let flag = null;
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) dates.push(v.slice(0, 10));
          if (typeof v === 'boolean' && /confirm|fix|kakutei/i.test(k)) flag = v;
        }
        for (const d of dates) {
          const prev = byDate.get(d);
          if (prev === undefined || prev === null) byDate.set(d, flag);
        }
        Object.values(node).forEach(walk);
        return;
      }
      if (typeof node === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node) && !byDate.has(node)) byDate.set(node, null);
    };
    walk(json);

    return [...byDate.entries()]
      .filter(([, flag]) => flag !== true) // 確定済みフラグが立っているものは除外
      .map(([d]) => d)
      .sort();
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
        font-size: 12px; color: #222;
      }
      #tableWrap { overflow-x: auto; }
      #panel.open { display: block; }
      .nav { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .nav b { flex: 1; text-align: center; font-size: 13px; }
      .nav button {
        border: 1px solid #ccc; background: #f5f5f5; border-radius: 5px;
        cursor: pointer; padding: 2px 8px; font-size: 12px;
      }
      .stats { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .chip { background: #eef4f0; border-radius: 5px; padding: 2px 7px; }
      .chip b { color: #2c6e49; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 1px 4px; text-align: center; font-size: 11px; white-space: nowrap; }
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
      tr.diff td { border-top: 2px solid #999; color: #999; }
      tr.diff td.short { background: #fdecec; color: #b02a2a; font-weight: 700; }
      th.short-mark { background: #d64545; color: #fff; }
      .section-title { font-weight: 700; margin: 8px 0 4px; font-size: 12px; }
      .unconfirmed { display: flex; flex-wrap: wrap; gap: 4px; }
      .unconfirmed .day {
        background: #fdecec; color: #b02a2a; border: 1px solid #e8b4b4;
        border-radius: 5px; padding: 2px 7px;
      }
      .allok { color: #2c6e49; font-weight: 600; }
      .err { color: #b02a2a; }
      .muted { color: #888; font-size: 11px; }
      .tasks .task { display: flex; gap: 6px; padding: 2px 0; border-bottom: 1px dotted #eee; }
      .tasks .task .tid {
        flex: 0 0 auto; font-weight: 700; color: #2c6e49; font-size: 11px;
        background: #eef4f0; border-radius: 4px; padding: 0 5px; align-self: center;
      }
      .tasks .task.ext .tid { color: #a15c00; background: #fdf3e3; }
      .tasks .task .tnote { color: #888; font-size: 10px; }
    </style>
    <button id="toggle" title="客数予測パネル">📊<span class="badge" id="badge"></span></button>
    <div id="panel">
      <div class="nav">
        <button id="prev">◀</button>
        <b id="dateLabel">-</b>
        <button id="next">▶</button>
        <button id="reload" title="再読込">⟳</button>
      </div>
      <div id="stats" class="stats"></div>
      <div id="tableWrap"></div>
      <div class="section-title">月次タスク（<span id="taskDate">-</span>）</div>
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
    const shortAt = (i) => diffs && diffs[i] !== null && diffs[i] < 0;

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
        actRow(actual.total, req, '実計', actual.sum.total);

      if (diffs) {
        const cells = HOURS.map((h, i) => {
          const d = diffs[i];
          if (d === null) return `<td class="${nowCls(h)}"></td>`;
          const txt = d < 0 ? d : (d > 0 ? `+${d}` : '±0');
          return `<td class="${nowCls(h)}${d < 0 ? ' short' : ''}">${txt}</td>`;
        }).join('');
        const totalD = Math.round((actual.sum.total - num(req?.total)) * 10) / 10;
        diffRow = `<tr class="diff"><td class="row-head">不足</td>${cells}` +
          `<td class="total${totalD < 0 ? ' short' : ''}">${totalD < 0 ? totalD : `+${totalD}`}</td></tr>`;
      }
    }

    $('#tableWrap').innerHTML = `<table>${headRow}${bodyRows}${actualRows}${diffRow}</table>` +
      (actual?.error ? `<div class="err">実人数取得失敗: ${actual.error}</div>` : '');
    renderTasks();
  }

  async function renderTasks() {
    const el = $('#tasks');
    $('#taskDate').textContent = `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;
    try {
      const all = await fetchTaskRows();
      const hits = all.filter((t) => taskMatches(t, targetDate));
      if (!hits.length) { el.innerHTML = '<span class="muted">該当なし</span>'; return; }
      el.innerHTML = hits.map((t) =>
        `<div class="task${t.rule === '外部' ? ' ext' : ''}">` +
        `<span class="tid">${t.id}</span>` +
        `<span>${t.task}${t.rule === '外部' ? '（外部日程・行動計画参照）' : ''}` +
        (t.note ? `<div class="tnote">${t.note}</div>` : '') +
        `</span></div>`).join('');
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
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const d = parseYmd(urlParams().from || '');
    if (d && ymd(d) !== ymd(targetDate)) { targetDate = d; renderSheet(); }
  }, URL_WATCH_MS);

  renderSheet();
  renderUnconfirmed();
  setInterval(renderUnconfirmed, CONFIRM_POLL_MS);
  // シフト編集の反映を追うため、パネルが開いている間は実人数込みで定期更新
  setInterval(() => { if (panel.classList.contains('open')) renderSheet(); }, 2 * 60 * 1000);
})();
