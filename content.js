// らくしふ 客数予測パネル
// - シート「時間帯別客数予測 v2」の日付シート (例: "0718 (土)") から LE / REQ / LABOR% を取得して表示
// - シフト確定 未処理日を今日〜月末で監視

(() => {
  'use strict';

  // ===== 設定 =====
  // LE/REQ のデータ元 = SLS/LBR LE Maker (apps/KyakusuYosoku)。data.json+params.jsonを
  // 取得し engine.js の computeDay で計算する（旧: スプシ「時間帯別客数予測 v2」）
  const TASK_SHEET_ID = '1Np93smWUpSheCj1aKu9ZGmoOLQRJ1XALy02YxfGp9lw'; // 月次タスク一覧
  const TASK_SHEET_GID = 0;
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6:00 - 23:00

  // パネルの時間帯行（keyはcomputeDay出力の行ラベル）
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
  // MGT/cMGTタスクがシフトのこの割合以上を占めたら、そのシフトは丸ごとMGT扱いにする
  // （＝実F/実K/実計から全部抜く）。これ未満なら、そのタスク区間だけ抜いて残りはF/K。
  const MGT_WHOLE_RATIO = 0.8;
  // 業務割振タスク名 → カウント先。F/K/FK=振替、BU系=キッチン扱い、
  // MGT/TRer/TRee=OP Hに数えず MGT系へ（正社員→MGT、その他→cMGT）
  const moveGroup = (name, isRegular) => {
    if (name === 'F' || name === 'K' || name === 'FK') return name;
    if (/^BU/.test(name || '')) return 'K';
    if (['MGT', 'TRer', 'TRee'].includes(name)) return isRegular ? 'MGT' : 'cMGT';
    return null;
  };
  // パネル上部の統計チップ
  const HEADER_LABELS = ['LABOR%', 'LABOR H', 'SALES', 'SBP'];

  const CONFIRM_POLL_MS = 5 * 60 * 1000; // 未確定チェックの間隔
  const URL_WATCH_MS = 1500;
  const DRAFT_POLL_MS = 10000;   // 海賊版原案の自動追従ポーリング間隔（Tailscaleローカルなので軽い）
  // 必要人数(REQ)の基準: 'le'=客数から算出 / 'ws'=モデルWSの計画人数。パネルのボタンで切替・記憶。
  const reqBasis = () => (localStorage.getItem('rfReqBasis') === 'ws' ? 'ws' : 'le');
  const isPrintPage = location.pathname.includes('/schedules/print');

  // ===== ユーティリティ =====
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseYmd = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };

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

  // SLS/LBR LE Maker から data.json / params.json を取得（セッション内キャッシュ）
  let leMakerCache = null;
  const leMakerGet = (path) => new Promise((resolve) => {
    if (!alive()) return resolve(null);
    try {
      chrome.runtime.sendMessage({ type: 'leMaker', path }, (r) => resolve(r || null));
    } catch { resolve(null); }
  });
  async function loadLEMaker() {
    if (leMakerCache) return leMakerCache;
    const [d, p] = await Promise.all([leMakerGet('/data.json'), leMakerGet('/params.json')]);
    if (!d || !d.ok || !d.text) throw new Error(d?.error || 'LE Makerに接続不可');
    leMakerCache = { data: JSON.parse(d.text), params: p && p.ok && p.text ? JSON.parse(p.text) : {} };
    return leMakerCache;
  }

  // 合計保存の整数丸め（最大剰余法）: 計=round(実数和)を先に確定し、各セルは切捨て→小数部の大きい順に+1。
  // 時間帯別の表示値の和が合計表示と必ず一致する（LEの表示専用。REQ等の計算は実数のまま）
  function apportionInt(arr) {
    const v = arr.map((x) => Math.max(0, Number(x) || 0));
    const total = Math.round(v.reduce((a, b) => a + b, 0));
    const fl = v.map(Math.floor);
    let rem = total - fl.reduce((a, b) => a + b, 0);
    v.map((x, i) => ({ i, f: x - fl[i] })).sort((a, b) => b.f - a.f)
      .forEach((o) => { if (rem > 0) { fl[o.i]++; rem--; } });
    return fl;
  }

  // ===== モデルWS（基本WS＝曜日テンプレの人員ライン）=====
  // LE Maker の params.ws から、その日に適用される型の時間帯別人員(F/K/FK)を出す。
  // index.html の wsPickTpl/wsTplFor/wsHoursOf を移植（同じ結果になるよう仕様を合わせる）:
  //  - byDate[iso].wsTpl があれば最優先
  //  - なければ曜日割当 assign[getDay()]。値が文字列=型id固定、
  //    {by:"le",cuts:[{ge,tpl}]} ならLE計(leSum)で分岐（ge以上で最も高い段が勝つ）
  //  - counts[sec] は18枠(6..23時)。HOURS と同じ並び。
  function wsPickTplId(av, leSum) {
    if (!av) return null;
    if (typeof av === 'string') return av;
    const cuts = (av.cuts || []).filter((c) => c && c.tpl).slice()
      .sort((a, b) => Number(a.ge) - Number(b.ge));
    let pick = null;
    for (const c of cuts) if ((leSum || 0) >= Number(c.ge)) pick = c.tpl;
    return pick || (cuts[0] && cuts[0].tpl) || null;
  }
  // 曜日割当だけで決まる型（日別上書きを見ない）。パネルの「自動」表示用にも使う。
  function wsAutoTpl(params, iso, leSum) {
    const w = params && params.ws;
    if (!w || !Array.isArray(w.templates)) return null;
    // 月別割当(assignM[YYYY-MM]) > 既定(assign)。月別に無い曜日は既定へフォールバック
    // （海賊版らくしふの月別モデルWSと同一仕様・2026-07-22）
    const wd = String(new Date(`${iso}T00:00:00`).getDay());
    const mAv = ((w.assignM || {})[iso.slice(0, 7)] || {})[wd];
    const id = wsPickTplId(mAv !== undefined ? mAv : (w.assign || {})[wd], leSum);
    return w.templates.find((t) => t.id === id) || null;
  }
  // その日に適用される型。日別上書き(byDate[iso].wsTpl) > 曜日割当
  function wsTplFor(params, iso, leSum) {
    const w = params && params.ws;
    if (!w || !Array.isArray(w.templates) || !w.templates.length) return null;
    const ovr = ((params.byDate || {})[iso] || {}).wsTpl;
    if (ovr) return w.templates.find((t) => t.id === ovr) || null;
    return wsAutoTpl(params, iso, leSum);
  }
  function computeWS(params, iso, leSum) {
    const tpl = wsTplFor(params, iso, leSum);
    if (!tpl) return null;
    const pick = (sec) => {
      const a = (tpl.counts || {})[sec] || [];
      return HOURS.map((h, i) => Number(a[i]) || 0);
    };
    return { F: pick('F'), K: pick('K'), FK: pick('FK') };
  }

  // computeDay の出力を、旧extractSheetData互換の {header, hourly} に変換
  function fetchSheet(date) {
    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    return loadLEMaker().then(({ data, params }) => {
      const eng = globalThis.__leEngine;
      if (!eng) return { error: 'engine未読込・要ページ再読込', sheetName: label };
      const iso = ymd(date);
      const serial = String(eng.isoToSerial(iso));
      if (!data.dates || !(serial in data.dates)) {
        return { error: 'LE Maker範囲外の日付', sheetName: label };
      }
      const r = eng.computeDay(data, params, iso);
      const R = r.rows, S = r.summary;
      // LE: 0も「0」表示（最大剰余法＝時間帯の和がLE計と一致）。REQ: 0は空欄（旧シート挙動）
      const leArr = apportionInt(HOURS.map((h, i) => R.le[i] || 0)).map((v) => String(v));
      const reqArr = (a) => HOURS.map((h, i) => (a[i] ? String(Math.round(a[i] * 10) / 10) : ''));
      const sumStr = (a) => String(Math.round(a.reduce((x, y) => x + y, 0)));
      const hourly = {
        'LE': { hours: leArr, total: String(Math.round(S.leSum)) },
        'REQ（F）': { hours: reqArr(R.reqF), total: sumStr(R.reqF) },
        'REQ（K）': { hours: reqArr(R.reqK), total: sumStr(R.reqK) },
        'REQ（FK）': { hours: reqArr(R.reqFK), total: sumStr(R.reqFK) },
        'REQ（SUM）': { hours: reqArr(R.reqSum), total: sumStr(R.reqSum) },
      };
      // モデルWS（曜日テンプレ）。必要行に「必要/WS」の2段で併記するため持たせる。
      const ws = computeWS(params, iso, S.leSum);
      const wsPack = ws ? {
        f: { hours: ws.F, total: ws.F.reduce((a, b) => a + b, 0) },
        k: { hours: ws.K, total: ws.K.reduce((a, b) => a + b, 0) },
        fk: { hours: ws.FK, total: ws.FK.reduce((a, b) => a + b, 0) },
      } : null;
      const header = {
        'LABOR%': `${(S.laborPct * 100).toFixed(1)}%`,
        'LABOR H': String(Math.round(S.totalH)),
        'SALES': String(Math.round(S.salesSum)),
        'SBP': String(Math.round(S.sbp)),
      };
      return { header, hourly, wsPack, sheetName: label, isAct: r.act };
    }).catch((e) => ({ error: String(e.message || e), sheetName: label }));
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
    // TR は「いま何人が研修中か」を見るための**参考枠**。MGT/cMGT に含まれたまま
    // 二重に数える（MGT/cMGTはOP H外という計上ルールに直結しており、そこから
    // 抜くと人時の数字が変わってしまうため）。実計・不足には一切影響しない。
    const act = { F: zero(), K: zero(), FK: zero(), MGT: zero(), cMGT: zero(),
                  TR: zero(), total: zero() };
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
                       tr: ['TRer', 'TRee'].includes(taskMap[t.store_task_id]),
                       s: Math.max(t.start_time_as_min, sh.start_as_min),
                       e: Math.min(t.end_time_as_min, sh.end_as_min) }))
        .filter((t) => t.grp && t.e > t.s)
        .sort((a, b) => a.s - b.s || a.id - b.id);

      // MGT / TRer / TRee は、オペレーションの頭数ではないので実F/実K/実計から抜く。
      // ただし抜くのは「そのタスクが入っている区間」だけ。ラインの一部にMGTを入れた
      // だけでライン全体が消えるのは行き過ぎ（本人指摘 2026-07-23）。
      // シフトのほぼ全域(MGT_WHOLE_RATIO以上)がMGT/cMGTのときだけ、まるごとMGT扱いにする。
      const mgtSpans = moves.filter((mv) => mv.grp === 'MGT' || mv.grp === 'cMGT');
      const mgtMin = mgtSpans.reduce((acc, mv) => {           // 区間の重なりを除いた合計分
        const s = Math.max(mv.s, acc.end);
        return { min: acc.min + Math.max(0, mv.e - s), end: Math.max(acc.end, mv.e) };
      }, { min: 0, end: -Infinity }).min;
      const shiftMin = Math.max(1, sh.end_as_min - sh.start_as_min);
      const mgtWhole = (mgtMin / shiftMin) >= MGT_WHOLE_RATIO ? (isReg ? 'MGT' : 'cMGT') : null;

      const uh = (userHour[sh.user_id] ||= HOURS.map(() => 0));
      HOURS.forEach((h, i) => {
        let total = net(sh, sh.start_as_min, sh.end_as_min, h);
        total = Math.min(total, Math.max(0, 1 - uh[i])); // 重複登録時: 1人1時間まで
        if (total === 0) return;
        uh[i] += total;
        if (mgtWhole) {
          act[mgtWhole][i] += total;                 // シフト全体をMGT/cMGTへ
          for (const mv of moves) {                  // TR参考枠はタスク区間ぶんだけ
            if (!mv.tr) continue;
            const m = Math.min(net(sh, mv.s, mv.e, h), total);
            if (m > 0) act.TR[i] += m;
          }
          return;                                    // F/K・実計には入れない
        }
        let alloc = 0, mgt = 0;
        for (const mv of moves) {
          const m = Math.min(net(sh, mv.s, mv.e, h), total - alloc); // タスク重複: 先勝ち
          if (m <= 0) continue;
          act[mv.grp][i] += m;
          alloc += m;
          if (mv.tr) act.TR[i] += m; // 参考枠（MGT/cMGTと二重計上・実計には不算入）
          if (mv.grp === 'MGT' || mv.grp === 'cMGT') mgt += m;
        }
        act[grp][i] += Math.max(0, total - alloc); // 振替以外は所属グループ
        act.total[i] += total - mgt;               // 実計(OP H)はMGT系を除く
      });
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    act.sum = {};
    for (const k of ['F', 'K', 'FK', 'MGT', 'cMGT', 'TR', 'total']) {
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
      /* 印刷時はパネルとボタンを紙に出さない（注入した行だけ印刷される） */
      @media print { #toggle, #panel { display: none !important; } }
      #toggle {
        position: fixed; right: 12px; top: 12px; z-index: 2147483646;
        width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
        background: #2c6e49; color: #fff; font-size: 18px; box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      #toggle .badge, #shiftToggle .badge {
        position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
        border-radius: 9px; background: #d64545; color: #fff; font-size: 11px;
        line-height: 18px; padding: 0 4px; display: none;
      }
      #shiftToggle {
        position: fixed; right: 62px; top: 12px; z-index: 2147483646;
        width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
        background: #6b46a8; color: #fff; font-size: 18px; box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      #shiftPanel {
        position: fixed; right: 62px; top: 64px; z-index: 2147483647;
        width: 490px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 80px); overflow-y: auto;
        background: #fff; border: 1px solid #ccc; border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,.25); padding: 12px; display: none;
        font-size: 15px; color: #222;
      }
      #shiftPanel.open { display: block; }
      .sc-head { display: flex; gap: 5px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .sc-head b { flex: 1; font-size: 16px; }
      .sc-head button {
        border: 1px solid #ccc; background: #f5f5f5; border-radius: 5px;
        cursor: pointer; padding: 4px 10px; font-size: 14px;
      }
      .sc-head button.on { background: #6b46a8; color: #fff; border-color: #6b46a8; }
      .sc-card { border: 1px solid #e2e2e2; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
      .sc-card.done { opacity: .55; }
      .sc-title { font-weight: 700; font-size: 15px; }
      .sc-title .undone { color: #b02a2a; }
      .sc-meta { color: #888; font-size: 13px; font-weight: 400; }
      .sc-checks { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0; }
      .sc-checks label { font-size: 14px; display: flex; gap: 5px; align-items: center; cursor: pointer; }
      .sc-checks input { width: 15px; height: 15px; }
      .sc-notes { color: #777; font-size: 13px; margin: 3px 0; }
      .sc-note-input { display: flex; gap: 4px; margin-top: 4px; }
      .sc-note-input input { flex: 1; border: 1px solid #ccc; border-radius: 4px; padding: 4px 8px; font-size: 14px; }
      .sc-note-input button, #scNewForm button {
        border: 1px solid #ccc; background: #f5f5f5; border-radius: 4px; cursor: pointer;
        padding: 3px 10px; font-size: 14px;
      }
      .sc-del-btn { float: right; border: none; background: none; cursor: pointer; font-size: 13px; opacity: .5; padding: 0 2px; }
      .sc-del-btn:hover { opacity: 1; }
      .sc-rej-btn { float: right; border: none; background: none; cursor: pointer; font-size: 13px; opacity: .5; padding: 0 2px; }
      .sc-rej-btn:hover { opacity: 1; }
      .sc-edit-btn { float: right; border: none; background: none; cursor: pointer; font-size: 12px; opacity: .5; padding: 0 2px; }
      .sc-edit-btn:hover { opacity: 1; }
      .sc-edit-form { border: 1px dashed #b9a3dd; border-radius: 8px; padding: 6px; margin: 4px 0; }
      .sc-edit-form input { width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px 8px; font-size: 14px; margin-bottom: 4px; box-sizing: border-box; }
      .sc-edit-form .sc-edit-do { border: 1px solid #6b46a8; background: #6b46a8; color: #fff; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      .sc-edit-form .sc-edit-cancel { border: 1px solid #ccc; background: #f5f5f5; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      .sc-reqtime { font-size: 13px; color: #444; margin-bottom: 4px; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
      #scNewForm select.rf-tsel, .sc-edit-form select.rf-tsel { width: auto !important; min-width: 44px; padding: 3px 4px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; margin: 0; background: #fff; }
      .sc-unrej-btn { float: right; border: 1px solid #ccc; background: #f5f5f5; border-radius: 4px; cursor: pointer; font-size: 11px; padding: 1px 6px; }
      .sc-title .rejected { color: #6b7280; }
      .sc-title .sc-nodate { font-size: 10px; font-weight: 700; color: #b45309; background: #fdf3e3;
        border: 1px solid #e8cfa4; border-radius: 4px; padding: 1px 4px; white-space: nowrap; }
      .sc-rej-form { display: flex; gap: 4px; margin-top: 4px; }
      .sc-rej-form input { flex: 1; border: 1px solid #ccc; border-radius: 4px; padding: 4px 8px; font-size: 14px; }
      .sc-rej-form .sc-rej-do { border: 1px solid #6b7280; background: #6b7280; color: #fff; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      .sc-rej-form .sc-rej-cancel { border: 1px solid #ccc; background: #f5f5f5; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      .sc-del-form { display: flex; gap: 4px; margin-top: 4px; }
      .sc-del-form input { flex: 1; border: 1px solid #d99; border-radius: 4px; padding: 4px 8px; font-size: 14px; }
      .sc-del-form .sc-del-do { border: 1px solid #c0392b; background: #c0392b; color: #fff; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      .sc-del-form .sc-del-cancel { border: 1px solid #ccc; background: #f5f5f5; border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 14px; }
      #scNewForm { border: 1px dashed #b9a3dd; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
      #scNewForm input, #scNewForm select {
        width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 4px 8px;
        font-size: 14px; margin-bottom: 4px; background: #fff;
      }
      @media print { #shiftToggle, #shiftPanel { display: none !important; } }
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
      tr.act td.short-lite { color: #b02a2a; font-weight: 700; } /* 不足1人未満: 白地に赤字 */
      tr.mgt td, tr.mgt td.row-head { color: #999; font-weight: 400; }
      tr.diff td { border-top: 2px solid #999; color: #999; }
      tr.diff td.short { background: #fdecec; color: #b02a2a; font-weight: 700; }
      tr.diff td.over { background: #e8f5ec; color: #1e7a44; font-weight: 700; }
      tr.diff td.short-lite { color: #b02a2a; font-weight: 700; } /* |不足|<1: 白地に赤字 */
      tr.diff td.over-lite { color: #1e7a44; font-weight: 700; }  /* 0<余剰<1: 白地に緑字 */
      th.short-mark { background: #d64545; color: #fff; }
      .section-title { font-weight: 700; margin: 8px 0 4px; font-size: 13px; }
      .section-title #draftSend { margin-left: 4px; font-size: 11px; padding: 0 8px; border-radius: 5px;
        border: 1px solid #ccc; background: #fff; cursor: pointer; }
      .section-title #reflectPlan, .section-title #ckPlan { margin-left: 4px; font-size: 11px;
        padding: 0 8px; border-radius: 5px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
      #ckAll { font-size: 11px; padding: 1px 10px; border-radius: 5px;
        border: 1px solid #16a34a; background: #16a34a; color: #fff; cursor: pointer; }
      #ckAll[disabled] { border-color: #ccc; background: #eee; color: #999; }
      .reflect .ckap { flex: 0 0 auto; font-size: 11px; padding: 1px 8px; border-radius: 5px;
        border: 1px solid #16a34a; background: #16a34a; color: #fff; cursor: pointer; }
      .reflect .ckap[disabled] { border-color: #ccc; background: #eee; color: #999; cursor: default; }
      #reflectAll { font-size: 11px; padding: 1px 10px; border-radius: 5px;
        border: 1px solid #16a34a; background: #16a34a; color: #fff; cursor: pointer; }
      #reflectAll[disabled] { border-color: #ccc; background: #eee; color: #999; }
      .section-title #draftMonth { margin-left: 6px; font-size: 11px; font-weight: 400; padding: 0 2px;
        border: 1px solid #ccc; border-radius: 5px; background: #fff; }
      .section-title #draftOpen { font-weight: 400; font-size: 11px; margin-left: 4px; color: #2c6e49; }
      .nav #ver { font-size: 10px; font-weight: 400; margin-left: 4px; }
      .draft .dli { padding: 1px 0; font-size: 12px; }
      .draft .dtag { display: inline-block; width: 24px; text-align: center; border-radius: 4px;
        color: #fff; font-size: 10px; font-weight: 700; margin-right: 5px; }
      .draft .dtag.F { background: #2563eb; } .draft .dtag.K { background: #d97706; }
      .draft .dtag.FK { background: #0e7490; }
      .reflect { font-size: 12px; }
      .reflect .rf-warn { color: #92400e; background: #fef3c7; border: 1px solid #fcd34d;
        border-radius: 5px; padding: 4px 7px; margin-bottom: 5px; }
      .reflect .rrow { display: flex; align-items: center; gap: 6px; padding: 3px 0;
        border-bottom: 1px dotted #eee; }
      .reflect .rrow .rwho { flex: 0 0 auto; font-weight: 700; min-width: 72px; }
      .reflect .rrow .rwhat { flex: 1 1 auto; color: #444; }
      .reflect .rrow.create .rwhat { color: #1e7a44; }
      .reflect .rrow.retime .rwhat { color: #b45309; }
      .reflect .rrow.manual { opacity: .8; }
      .reflect .rrow.manual .rwhat { color: #6b7280; }
      .reflect .rrow.done { background: #f0faf3; }
      .reflect .rrow.err .rwhat { color: #b02a2a; }
      .reflect .rap { flex: 0 0 auto; font-size: 11px; padding: 1px 8px; border-radius: 5px;
        border: 1px solid #16a34a; background: #16a34a; color: #fff; cursor: pointer; }
      .reflect .rap[disabled] { border-color: #ccc; background: #eee; color: #999; cursor: default; }
      .reflect .rsum { margin: 4px 0; font-weight: 700; }
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
    <button id="shiftToggle" title="シフト変更依頼">🔁<span class="badge" id="shiftBadge"></span></button>
    <div id="shiftPanel">
      <div class="sc-head">
        <b>シフト変更依頼</b>
        <button id="scFilterOpen" class="on">未完了</button>
        <button id="scFilterDay">この日</button>
        <button id="scFilterAll">すべて</button>
        <button id="scNewBtn">＋新規</button>
        <button id="scReload">更新</button>
      </div>
      <div id="scNewForm" style="display:none"></div>
      <div id="scList" class="muted">読込中…</div>
    </div>
    <div id="panel">
      <div class="nav">
        <b id="dateLabel">-</b>
        <button id="reqBasis" title="必要人数(REQ)の基準を切り替え。LE=客数から算出 / モデルWS=モデルWSの計画人数">基準: LE</button>
        <select id="wsTplSel" title="この日に適用するモデルWS型。自動=曜日割当に従う（変更はLE Makerのparams.jsonに保存＝海賊版と共通）"></select>
        <button id="rfUpdate" style="display:none"></button>
        <button id="reload" class="accent">更新</button>
        <span id="ver" class="muted"></span>
      </div>
      <div id="stats" class="stats"></div>
      <div id="tableWrap"></div>
      <div class="section-title fold" id="tasksTitle"><span id="taskFold">▾</span> タスク 月次/週次/要請（<span id="taskDate">-</span>）</div>
      <div id="tasks" class="tasks muted">読込中…</div>
      <div class="section-title">シフト確定 未処理日（今日〜月末）</div>
      <div id="unconfirmed" class="unconfirmed muted">確認中…</div>
      <div class="section-title fold" id="draftTitle"><span id="draftFold">▾</span> 海賊版らくしふ
        <select id="draftMonth" title="送信する月（らくしふの表示月とは無関係に選べます）"></select>
        <button id="draftSend" title="選択した月の希望シフトをShiftDraftへ送る">希望送信</button>
        <a id="draftOpen" href="http://mac-mini.tail1f88ff.ts.net:8790/" target="_blank" rel="noopener">開く↗</a>
      </div>
      <div id="draft" class="draft muted">-</div>
      <div class="section-title" style="margin-top:6px">この日を らくしふへ反映
        <button id="reflectPlan" title="海賊版の原案と今のらくしふを突き合わせ、差分を出す（送信はしません）">差分を出す</button>
        <button id="ckPlan" title="温度・日付・廃棄のCKを、この日の勤務者に自動で割り付ける（シフト全域タグ。時間は変えません）">🌡 CK割付</button>
        <span class="muted" style="font-weight:400;font-size:10px">※確定送信はしません／反映は1件ずつ手押し</span>
      </div>
      <div id="reflect" class="reflect muted">-</div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('#panel'), badge = $('#badge');

  let targetDate = parseYmd(urlParams().from || '') || new Date();
  let lastHref = location.href;

  // 📊パネルと🔁ダイアログが同時に開いても被らないよう、🔁側を左に避ける
  function repositionShiftPanel() {
    const sp = $('#shiftPanel');
    sp.style.right = panel.classList.contains('open')
      ? `${12 + panel.offsetWidth + 8}px`
      : '62px';
  }

  $('#toggle').addEventListener('click', () => {
    panel.classList.toggle('open');
    localStorage.setItem('rfPanelOpen', panel.classList.contains('open') ? '1' : '0');
    repositionShiftPanel();
  });
  if (localStorage.getItem('rfPanelOpen') === '1') panel.classList.add('open');

  // 対象日はらくしふ画面(URLのfrom=)に完全追従（独自の日付移動は廃止）
  $('#reload').addEventListener('click', () => {
    taskRowsCache = null;   // タスクシートも再取得
    leMakerCache = null;    // LE Maker のdata/paramsも取り直す
    storeTaskMapCache = null;
    lastDraftDay = null;    // ShiftDraft原案も取り直す
    renderSheet();
  });
  // REQの基準を LE ⇔ モデルWS で切り替える（記憶して次回も同じ基準で開く）
  $('#reqBasis').addEventListener('click', () => {
    localStorage.setItem('rfReqBasis', reqBasis() === 'ws' ? 'le' : 'ws');
    renderSheet();
  });
  // この日に適用するモデルWS型を選ぶ＝params.byDate[iso].wsTpl の日別上書き。
  // 保存はShiftDraftの POST /le/ws（SoTはLE Makerのparams.json・_rev楽観ロック）。
  // ws本体は触らず byDateWsTpl だけ渡す（空文字=自動に戻す＝上書き解除）。
  $('#wsTplSel').addEventListener('change', async (ev) => {
    const sel = ev.target;
    const params = (leMakerCache && leMakerCache.params) || {};
    if (!params.ws) { alert('モデルWSが読めていません。更新を押して再取得してください'); return; }
    const iso = ymd(targetDate);
    sel.disabled = true;
    const r = await draftApi('/le/ws', {
      ws: params.ws, _rev: params._rev || 0, byDateWsTpl: { [iso]: sel.value || null },
    });
    sel.disabled = false;
    if (!r || !r.ok) {
      const msg = (r && r.data && r.data.msg) || (r && r.error) || '保存できませんでした';
      alert(`モデルWSの割当保存に失敗: ${msg}`);
      return;
    }
    leMakerCache = null;   // params が変わったので取り直してから再計算
    renderSheet();
  });

  // ===== 拡張の自己更新（MacBook運用: launchdがgit pull → ここで気付いて反映） =====
  // ディスク上のmanifestが実行中の版と違えば、pull済みの新版がまだ有効になっていない。
  // ボタンは拡張とページの両方を再読込するため、シフト編集中に不意に走らないよう
  // 自動では絶対に実行せず、押した時だけ動かす（ラベルにも再読込することを明記）。
  const rfUpdate = $('#rfUpdate');
  async function checkExtUpdate() {
    const r = await new Promise((res) => {
      try { chrome.runtime.sendMessage({ type: 'extVersion' }, (x) => res(x || null)); }
      catch { res(null); } // 拡張リロード直後などcontextが無効な場合
    });
    if (!r || !r.ok || !r.disk) return;
    const stale = r.disk !== r.running;
    rfUpdate.style.display = stale ? '' : 'none';
    if (stale) {
      rfUpdate.textContent = `⬆ v${r.disk} に更新`;
      rfUpdate.title = `実行中 v${r.running} → ディスク上 v${r.disk}。`
        + '押すと拡張とこのページを再読込します（編集中の内容は失われます）';
    }
  }
  rfUpdate.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'extReload' });
    location.reload(); // 拡張を入れ替えただけでは、このページの旧content scriptは死んだまま
  });
  checkExtUpdate();
  setInterval(checkExtUpdate, 10 * 60 * 1000);

  // ===== シフト変更依頼ダイアログ（WorkLogWebサーバ = ShiftChangeアプリと同一データ） =====
  const SC_CHECKS = [
    ['requested_done', '依頼済み'], ['accepted_done', '承諾'], ['rakushifu_done', 'らくしふ反映'],
    ['pre_sh_done', '確定前SH連絡'], ['confirmed_done', 'らくしふ確定完了'], ['sh_done', 'SH連絡'],
  ];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shiftApi = (path, payload) => new Promise((resolve) => {
    if (!alive()) return resolve({ ok: false, error: '拡張更新済み・要ページ再読込' });
    try {
      chrome.runtime.sendMessage({ type: 'shiftApi', path, payload }, (r) => resolve(r || { ok: false, error: '応答なし' }));
    } catch { resolve({ ok: false, error: '拡張更新済み・要ページ再読込' }); }
  });

  const shiftPanel = $('#shiftPanel');
  let scFilter = 'open'; // 'open' | 'day' | 'all'
  let scState = null;

  // 対象日の文字列から {mo,da} を全部拾う（例 "7/23" / "07-23" / "7/26〜7/30"）
  const scDateTokens = (v) => {
    const out = [];
    const re = /(\d{1,2})\s*[\/月\-]\s*(\d{1,2})/g;
    let m;
    while ((m = re.exec(String(v || '')))) out.push({ mo: +m[1], da: +m[2] });
    return out;
  };
  // 対象日(単日 or 期間 "7/26〜7/30")が指定日を含むか。
  // 期間は年跨ぎ(12/28〜1/3)も通るよう、月日を通し番号(月*100+日)にして判定する。
  const scMatchesDay = (c, d) => {
    const t = scDateTokens(c.target_date);
    if (!t.length) return false;
    const key = (mo, da) => mo * 100 + da;
    const target = key(d.getMonth() + 1, d.getDate());
    if (t.length === 1) return target === key(t[0].mo, t[0].da);
    const a = key(t[0].mo, t[0].da), b = key(t[1].mo, t[1].da);
    return a <= b ? (target >= a && target <= b) : (target >= a || target <= b);
  };
  // target_date 文字列を入力欄2つ（開始/終了）へ分解する（"7/26〜7/30" → {from,to}）
  const scSplitDate = (v) => {
    const parts = String(v || '').split(/\s*[〜~～]\s*/);
    return { from: (parts[0] || '').trim(), to: (parts[1] || '').trim() };
  };
  // 入力欄2つ（開始/終了）から target_date 文字列を作る。終了が空/同じなら単日。
  const scJoinDate = (from, to) => {
    const f = String(from || '').trim(), t = String(to || '').trim();
    return (!t || t === f) ? f : `${f}〜${t}`;
  };
  // 名前の正規化（空白と敬称を除いて突き合わせ）
  const normName = (s) => String(s || '').replace(/\s+/g, '').replace(/(さん|くん|ちゃん)$/, '');
  // 「閉じた」案件＝完了 or 拒否。保留(未完了)判定・黄色線・バッジはこれで外す。
  const scClosed = (c) => c.is_done || c.is_rejected;

  // ===== 対象時間の入力ウィジェット（時・分プルダウン・分は既定00）=====
  // 手打ちが面倒なので、開始/終了を「時」「分」のselectで選ぶ。空欄なら変更内容から自動。
  const reqHourSel = (cls, sel) => `<select class="rf-tsel ${cls}"><option value="">–</option>` +
    Array.from({ length: 19 }, (_, i) => i + 6)
      .map((h) => `<option${String(sel) === String(h) ? ' selected' : ''}>${h}</option>`).join('') +
    '</select>';
  const reqMinSel = (cls, sel) => `<select class="rf-tsel ${cls}">` +
    ['00', '15', '30', '45']
      .map((m) => `<option${(sel || '00') === m ? ' selected' : ''}>${m}</option>`).join('') +
    '</select>';
  // "HH:MM-HH:MM" / "1500-2000" などを {sh,sm,eh,em} に。無ければnull。
  const reqTimeToHM = (value) => {
    const m = /(\d{1,2})[:：]?(\d{2})?\s*[-〜～~]\s*(\d{1,2})[:：]?(\d{2})?/.exec(String(value || ''));
    return m ? { sh: m[1], sm: m[2] || '00', eh: m[3], em: m[4] || '00' } : null;
  };
  // 「対象時間 [時]:[分] 〜 [時]:[分]」のHTML。prefixで開始/終了selectのクラスを分ける。
  function reqTimeWidget(prefix, value) {
    const p = reqTimeToHM(value);
    return '<div class="sc-reqtime">対象時間 ' +
      reqHourSel(`${prefix}-sh`, p ? p.sh : '') + ':' + reqMinSel(`${prefix}-sm`, p ? p.sm : '00') +
      ' 〜 ' +
      reqHourSel(`${prefix}-eh`, p ? p.eh : '') + ':' + reqMinSel(`${prefix}-em`, p ? p.em : '00') +
      ' <span class="muted" style="font-size:11px">(任意・空=変更内容から自動)</span></div>';
  }
  // ウィジェットから "HH:MM-HH:MM" を読む。開始/終了の「時」が両方選ばれていなければ空。
  function readReqTime(root, prefix) {
    const v = (cls) => (root.querySelector(`.${prefix}-${cls}`) || {}).value || '';
    const sh = v('sh'), eh = v('eh');
    if (!sh || !eh) return '';
    return `${sh}:${v('sm') || '00'}-${eh}:${v('em') || '00'}`;
  }

  function scCard(c) {
    const checks = SC_CHECKS.map(([k, lbl]) =>
      `<label><input type="checkbox" data-p="${esc(c.path)}" data-k="${k}" ${c[k] ? 'checked' : ''}>${lbl}</label>`
    ).join('');
    const notes = (c.notes || []).slice(0, 2)
      .map((n) => `<div>${esc(typeof n === 'string' ? n : (n.text || ''))}</div>`).join('');
    // 状態の頭記号: 拒否=🚫 / 完了=✅ / それ以外=未了
    const head = c.is_rejected ? '<span class="rejected">🚫拒否</span>'
      : c.is_done ? '✅' : '<span class="undone">未了</span>';
    const rejBtn = c.is_rejected
      ? `<button class="sc-unrej-btn" data-p="${esc(c.path)}" title="拒否を取り消して未完了に戻す">↩ 拒否解除</button>`
      : `<button class="sc-rej-btn" data-p="${esc(c.path)}" title="この依頼を拒否で閉じる（本人が断った）">🚫</button>`;
    const rejReason = c.is_rejected && c.reject_reason
      ? `<div class="sc-meta">拒否理由: ${esc(c.reject_reason)}</div>` : '';
    // 対象日が空だとバッジ・黄色ラインが毎日出る。気づけるよう印を出す（✏️で日付を入れる）
    const noDate = !scClosed(c) && !(c.target_date || '').trim()
      ? '<span class="sc-nodate" title="対象日が未記入です。毎日バッジ・ラインが出ます。✏️で対象日を入れてください">📅未記入</span>' : '';
    return `<div class="sc-card${scClosed(c) ? ' done' : ''}">
      <div class="sc-title">${head} ${esc(c.title)} ${noDate}
        <span class="sc-meta">${c.checked_count}/6</span>
        ${rejBtn}
        <button class="sc-edit-btn" data-p="${esc(c.path)}" title="この依頼を編集（対象者/日/変更内容/対象時間）">✏️</button>
        <button class="sc-del-btn" data-p="${esc(c.path)}" title="この依頼を削除（理由必須・archivedへ退避）">🗑</button></div>
      <div class="sc-meta">${esc(c.source)}・${esc(c.requester)}　${esc(c.received_at)}</div>
      ${rejReason}
      <div class="sc-edit-form" style="display:none">
        <input class="sc-edit-target" value="${esc(c.target || '')}" placeholder="対象者">
        <div style="display:flex;gap:4px;align-items:center">
          <input class="sc-edit-date" value="${esc(scSplitDate(c.target_date).from)}" placeholder="対象日 (例 7/26)">〜
          <input class="sc-edit-date-end" value="${esc(scSplitDate(c.target_date).to)}" placeholder="終了日 (期間なら/空欄可)">
        </div>
        <input class="sc-edit-change" value="${esc(c.change || '')}" placeholder="変更内容">
        ${reqTimeWidget('sce', c.req_time)}
        <div style="display:flex;gap:4px;margin-top:4px">
          <button class="sc-edit-do" data-p="${esc(c.path)}">保存</button>
          <button class="sc-edit-cancel">やめる</button>
        </div>
      </div>
      <div class="sc-checks">${checks}</div>
      <div class="sc-notes">${notes}</div>
      <div class="sc-note-input">
        <input placeholder="後追いの記録を追記…" data-p="${esc(c.path)}">
        <button data-p="${esc(c.path)}">追記</button>
      </div>
      <div class="sc-rej-form" style="display:none">
        <input class="sc-rej-reason" placeholder="拒否理由（任意）" data-p="${esc(c.path)}">
        <button class="sc-rej-do" data-p="${esc(c.path)}">拒否で閉じる</button>
        <button class="sc-rej-cancel">やめる</button>
      </div>
      <div class="sc-del-form" style="display:none">
        <input class="sc-del-reason" placeholder="削除理由（必須）" data-p="${esc(c.path)}">
        <button class="sc-del-do" data-p="${esc(c.path)}">削除</button>
        <button class="sc-del-cancel">やめる</button>
      </div>
    </div>`;
  }

  function scRenderList() {
    const el = $('#scList');
    if (!scState) return;
    const cases = scState.cases || [];
    const open = cases.filter((c) => !scClosed(c));
    $('#scFilterDay').textContent = `この日(${targetDate.getMonth() + 1}/${targetDate.getDate()})`;
    // 「この日」は名前バッジ・黄色ラインと同じ条件にする。
    // 日付未記入の未完了案件はバッジ/ラインが全日に出るので、ここでも出さないと
    // 「名前は依頼中なのにリストは"依頼なし"」という食い違いになる（2026-07-22修正）。
    const list = scFilter === 'all' ? cases
      : scFilter === 'day'
        ? cases.filter((c) => scMatchesDay(c, targetDate)
            || (!scClosed(c) && !(c.target_date || '').trim()))
      : open;
    el.innerHTML = list.map(scCard).join('') ||
      `<span class="muted">${scFilter === 'day' ? 'この日の依頼なし' : '未完了なし 🎉'}</span>`;
    // 🔁バッジの数はフィルタに追従する（「この日」なら当日分の未完了だけ・本人指定2026-07-23）
    const n = scFilter === 'day' ? list.filter((c) => !scClosed(c)).length : open.length;
    const bd = $('#shiftBadge');
    bd.textContent = n;
    bd.style.display = n ? 'block' : 'none';
    $('#shiftToggle').title = scFilter === 'day'
      ? `シフト変更依頼（この日の未完了 ${n}件）` : `シフト変更依頼（未完了 ${n}件）`;
  }

  async function scRefresh() {
    const r = await shiftApi('/api/shift/state');
    if (!r.ok) {
      $('#scList').innerHTML =
        `<span class="err">サーバに繋がりません（${esc(r.error || r.data?.error || '')}）。` +
        'Tailscale と WorkLogWeb の起動を確認</span>';
      return;
    }
    scState = r.data;
    scRenderList();
    updateShiftMarks();
    updateReqLines();
  }

  // 6チェックの最初の未完了工程を「今の状態」として言葉で返す（依頼中→承諾待ち→…）
  const SC_STATUS = [
    ['requested_done', '依頼中'], ['accepted_done', '承諾待ち'], ['rakushifu_done', '反映待ち'],
    ['pre_sh_done', '確定前連絡待ち'], ['confirmed_done', '確定待ち'], ['sh_done', '周知待ち'],
  ];
  const scStatusLabel = (c) => {
    const stage = SC_STATUS.find(([k]) => !c[k]);
    return stage ? stage[1] : '完了';
  };

  // ===== シフト表の名前横に変更依頼マーク（状態語=赤 / 変更済=緑）。印刷画面には出さない =====
  function updateShiftMarks() {
    if (isPrintPage || !scState) return;
    document.querySelectorAll('.rf-sc-mark').forEach((e) => e.remove());
    const cases = scState.cases || [];
    for (const nameEl of document.querySelectorAll('.user-cell .name')) {
      const nm = normName(nameEl.textContent);
      if (!nm) continue;
      // この人の案件: 表示日一致、または日付未記入の未完了(オープン)案件。
      // target='全員'(休み募集)は名前バッジは発信者(休みたい人=requester)にだけ出す
      // （ラインは全行に出すが、バッジ40個は煩いので発信者に集約）。
      const keyOf = (c) => c.target === '全員' ? normName(c.requester) : normName(c.target);
      const rel = cases.filter((c) => keyOf(c) === nm &&
        (scMatchesDay(c, targetDate) || (!scClosed(c) && !(c.target_date || '').trim())));
      if (!rel.length) continue;
      const pending = rel.filter((c) => !scClosed(c));
      const box = badgeBox(nameEl);
      if (!box) continue;
      const mark = document.createElement('span');
      mark.className = 'rf-sc-mark';
      if (pending.length) {
        // 進捗段階を状態語で表示（最初の未チェック工程＝今の状態）
        const label = pending.length === 1 ? scStatusLabel(pending[0]) : `依頼${pending.length}件`;
        mark.textContent = `🔄${label}`;
        mark.style.cssText = 'font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#b02a2a;background:#fdecec;border:1px solid #e8b4b4;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;';
      } else if (rel.some((c) => c.is_done)) {
        mark.textContent = '✔変更済';
        mark.style.cssText = 'font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#1e7a44;background:#e8f5ec;border:1px solid #b5d9c3;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;';
      } else {
        // 拒否のみ（完了なし）: 断られた依頼として灰色で示す
        mark.textContent = '🚫拒否';
        mark.style.cssText = 'font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#6b7280;background:#f1f2f4;border:1px solid #d3d6db;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;';
      }
      mark.title = rel.map((c) =>
        `${c.is_rejected ? '🚫拒否' : c.is_done ? '✅' : `【${scStatusLabel(c)}】`} ${c.title}`).join('\n');
      box.appendChild(mark);
    }
  }

  // ===== 変更依頼の対象者の行に、対象区間だけ目立つ依頼ラインを引く =====
  // 区間は「①明示の対象時間(c.req_time) → ②変更内容の時刻からの範囲 → ③全幅」の順で決める。
  // 保留=黄ライン / 拒否=同じ位置に赤ライン＋✕（分かりやすく）/ 完了=出さない。
  // ホバーで依頼内容がツールチップに出る。Vue再描画で消えるので監視ループで張り直す。
  const hmToMin = (tok) => {
    const t = String(tok).trim();
    const c = /^(\d{1,2})[:：](\d{2})$/.exec(t);
    if (c) return +c[1] * 60 + +c[2];
    const d = t.replace(/[^\d]/g, '');
    if (/^\d{3,4}$/.test(d)) return +(d.length === 3 ? d.slice(0, 1) : d.slice(0, 2)) * 60 + +d.slice(-2);
    if (/^\d{1,2}$/.test(d)) return +d * 60;
    return null;
  };
  const parseReqSpan = (s) => {
    const parts = String(s || '').split(/\s*[-〜～~]\s*/);
    if (parts.length !== 2) return null;
    const a = hmToMin(parts[0]), b = hmToMin(parts[1]);
    return (a != null && b != null && b > a) ? [a, b] : null;
  };
  // 依頼の対象区間。無ければnull(=全幅扱い)
  function reqSpanOf(c) {
    const ex = parseReqSpan(c.req_time);
    if (ex) return ex;
    const toks = String(c.change || '').match(/\d{1,2}[:：]\d{2}|\d{3,4}/g) || [];
    const mins = toks.map(hmToMin).filter((v) => v != null);
    return mins.length >= 2 ? [Math.min(...mins), Math.max(...mins)] : null;
  }
  function updateReqLines() {
    document.querySelectorAll('.rf-req-line, .rf-req-x').forEach((e) => e.remove());
    if (isPrintPage || !scState) return;
    const cases = scState.cases || [];
    const FULL = [6 * 60, 24 * 60];  // 6:00〜24:00（1px=1分）
    for (const tr of document.querySelectorAll('tr.user-cell-container.table-body-row')) {
      const nameEl = tr.querySelector('.user-cell .name');
      if (!nameEl) continue;
      const nm = normName(nameEl.textContent);
      if (!nm) continue;
      // 対象=この人・当日一致 or 日付未記入のオープン。状態は完了以外（保留=黄 / 拒否=赤×）
      // target='全員'（休み募集）は全行に出す（本人指定）。
      const rel = cases.filter((c) => (c.target === '全員' || normName(c.target) === nm) && !c.is_done &&
        (scMatchesDay(c, targetDate) || (!scClosed(c) && !(c.target_date || '').trim())));
      if (!rel.length) continue;
      const track = tr.querySelector('.schedule-row');
      if (!track) continue;
      rel.forEach((c, idx) => {
        const [s, e] = reqSpanOf(c) || FULL;
        const top = idx * 6;   // 同じ人に複数依頼があれば縦にずらす
        const rejected = c.is_rejected;
        const zenin = c.target === '全員';
        // ホバーで状態が分かるように、状態語(依頼中→承諾待ち→反映待ち…)を先頭に出す
        const title = rejected
          ? `🚫 拒否: ${c.title}` + (c.reject_reason ? `（理由: ${c.reject_reason}）` : '')
          : zenin
            ? `🙋 休み募集(${scStatusLabel(c)}): ${c.requester || ''}さんの代わり ${c.change || ''}`.trim()
            : `🔄 ${scStatusLabel(c)}: ${c.title}`;
        // 当たり判定を稼ぐため要素は少し高め(10px)にし、色帯は上4pxだけ描く(背景グラデ)。
        // ホバーは自前ツールチップ(即時表示)。ネイティブtitleの「?」カーソル＋遅延はやめる。
        const bg = rejected ? '#dc2626' : '#f5c518';
        const line = document.createElement('div');
        line.className = 'rf-req-line';
        line.dataset.tip = title;
        line.style.cssText = `position:absolute;left:${s - 360}px;width:${e - s}px;top:${top}px;` +
          'height:8px;z-index:4;cursor:default;' +
          `background:linear-gradient(${bg},${bg}) top left/100% 4px no-repeat;`;
        track.appendChild(line);
        if (rejected) {
          const x = document.createElement('div');
          x.className = 'rf-req-x';
          x.textContent = '✕';
          x.style.cssText = `position:absolute;left:${(s - 360) + (e - s) / 2 - 6}px;top:${top - 6}px;` +
            'font:900 13px/1 sans-serif;color:#dc2626;z-index:5;pointer-events:none;' +
            'text-shadow:0 0 2px #fff,0 0 2px #fff;';
          track.appendChild(x);
        }
      });
    }
  }

  // 依頼ライン用の即時ツールチップ（ネイティブtitleの「?」カーソル＋表示遅延をやめる）。
  // .rf-req-line の data-tip をカーソル脇に即座に出す。リスナーは1回だけ張る。
  let rfTip = null;
  const ensureRfTip = () => {
    if (rfTip) return rfTip;
    rfTip = document.createElement('div');
    rfTip.className = 'rf-line-tip';
    rfTip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'background:#1f2937;color:#fff;font:600 12px/1.45 -apple-system,"Hiragino Sans",sans-serif;' +
      'padding:5px 9px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:340px;white-space:pre-line;';
    document.body.appendChild(rfTip);
    return rfTip;
  };
  document.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest && ev.target.closest('.rf-req-line');
    if (!el || !el.dataset.tip) return;
    const tip = ensureRfTip();
    tip.textContent = el.dataset.tip;
    tip.style.display = 'block';
  });
  document.addEventListener('mousemove', (ev) => {
    if (!rfTip || rfTip.style.display === 'none') return;
    let x = ev.clientX + 12, y = ev.clientY + 14;
    if (x + rfTip.offsetWidth > innerWidth) x = ev.clientX - rfTip.offsetWidth - 12;
    if (y + rfTip.offsetHeight > innerHeight) y = ev.clientY - rfTip.offsetHeight - 12;
    rfTip.style.left = `${Math.max(0, x)}px`;
    rfTip.style.top = `${Math.max(0, y)}px`;
  });
  document.addEventListener('mouseout', (ev) => {
    if (rfTip && ev.target.closest && ev.target.closest('.rf-req-line')) rfTip.style.display = 'none';
  });

  // 表示中の日を対象日欄の既定値に使う（"7/21" 形式）
  const scDateStr = () => `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;

  // 新規フォームを閉じる。入力は破棄し、次回は白紙＋当日プリセットで開き直す
  const scCloseNewForm = () => {
    const f = $('#scNewForm');
    f.style.display = 'none';
    f.innerHTML = '';
  };

  function scBuildNewForm() {
    const srcs = [...(scState?.sources || ['WowTalk', '口頭', '電話', 'その他'])];
    if (!srcs.includes('店舗判断')) srcs.push('店舗判断'); // 店舗発パターン用
    $('#scNewForm').innerHTML =
      `<select id="scNewKind">` +
      `<option value="crew">クルー発（休み・時間変更の希望）</option>` +
      `<option value="store">店舗発（LE・作成方針による打診）</option>` +
      `</select>` +
      '<label style="display:flex;align-items:center;gap:5px;font-size:13px;margin-bottom:4px">' +
      '<input type="checkbox" id="scNewZenin" style="width:auto">全員宛（休み募集：代われる人を募集）</label>' +
      `<input id="scNewTarget" placeholder="対象者 (例: 高橋心さん)">` +
      '<div style="display:flex;gap:4px;align-items:center">' +
      `<input id="scNewDate" placeholder="対象日 (例: 7/26)">〜` +
      `<input id="scNewDateEnd" placeholder="終了日 (期間なら/空欄可)">` +
      '</div>' +
      `<input id="scNewChange" placeholder="変更内容">` +
      reqTimeWidget('scn', '') +
      `<input id="scNewRequester" placeholder="依頼者 (空欄可)">` +
      `<select id="scNewSource">${srcs.map((s) => `<option>${esc(s)}</option>`).join('')}</select>` +
      `<input id="scNewMemo" placeholder="メモ (空欄可)">` +
      `<button id="scNewCreate">作成</button>` +
      `<button id="scNewCancel">キャンセル</button>`;
    $('#scNewDate').value = scDateStr(); // 対象日は表示中の日を既定に（編集可）
    $('#scNewDateEnd').value = '';        // 期間にしたいときだけ終了日を入れる
    // 区分に応じて依頼者・sourceを自動補完（クルー発=対象者本人 / 店舗発=自分）
    const applyKind = () => {
      const store = $('#scNewKind').value === 'store';
      if (store) {
        $('#scNewRequester').value = REGULAR_STAFF[0] || '';
        $('#scNewSource').value = '店舗判断';
      } else {
        $('#scNewRequester').value = ($('#scNewTarget').value || '').replace(/\s+/g, '');
        const sel = $('#scNewSource');
        if ([...sel.options].some((o) => o.value === 'WowTalk')) sel.value = 'WowTalk';
      }
    };
    $('#scNewKind').addEventListener('change', applyKind);
    $('#scNewTarget').addEventListener('input', () => {
      if ($('#scNewKind').value === 'crew') {
        $('#scNewRequester').value = ($('#scNewTarget').value || '').replace(/\s+/g, '');
      }
    });
    // 全員宛（休み募集）: 対象者欄を「休みにしたい人」に読み替える。
    // 送信時は target='全員'・requester=この人 にする（scNewCreateで処理）。
    $('#scNewZenin').addEventListener('change', () => {
      const on = $('#scNewZenin').checked;
      $('#scNewTarget').placeholder = on ? '休みにしたい人（発信者）' : '対象者 (例: 高橋心さん)';
      $('#scNewChange').placeholder = on ? '内容 (例: 終日休み希望 / 早上がり)' : '変更内容';
      $('#scNewRequester').style.display = on ? 'none' : '';
    });
    applyKind();
  }

  // 名前右の「＋」ボタンから、対象者・対象日プリセットで新規起票フォームを開く
  // ===== WowTalk用の依頼文言（コピペ用）=====
  // 既定フォーマット（本人指定）:
  //   「お疲れ様です。{急遽?}M月d日(曜)のシフトについて、現在HH:mm-HH:mmのところ、
  //    {変更後}に変更願えませんでしょうか。」
  //   ・対象日が直近1週間以内なら頭に「急遽の変更で恐れ入りますが、」を付ける
  //   ・変更内容が "A => B" 形式なら A=現在/B=変更後。そうでなければ全文を変更後として使う
  // ※文言をHaikuで生成する構想があるが、実行時にLLMを呼ぶ経路(APIキー/ローカルendpoint)が
  //   未整備のため、まずは決定的テンプレートで出す。生成文はtextareaで手直し・コピー可。
  const fmtTimeToken = (tok) => {
    const one = (x) => {
      const digits = String(x).replace(/[^\d]/g, '');
      if (/^\d{3,4}$/.test(digits)) {
        const hh = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
        return `${+hh}:${digits.slice(-2)}`;
      }
      return String(x).trim();
    };
    const parts = String(tok).split('-');
    return parts.length === 2 ? `${one(parts[0])}-${one(parts[1])}` : one(tok);
  };
  // 対象日→ {label:"M月d日(曜)"（期間なら "…〜M月d日(曜)"）, urgent:"急遽…"|""}
  // urgent は開始日が直近1週間以内かどうかで判断する。
  const dateLabelOf = (targetDateStr) => {
    const toks = scDateTokens(targetDateStr);
    if (!toks.length) return { label: (targetDateStr || '').trim(), urgent: '' };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const one = (t) => {
      let d = new Date(today.getFullYear(), t.mo - 1, t.da);
      if ((d - today) / 86400000 < -180) d = new Date(today.getFullYear() + 1, t.mo - 1, t.da);
      return d;
    };
    const ds = toks.slice(0, 2).map(one);
    const fmt = (d) => `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
    const diff = (ds[0] - today) / 86400000;
    return { label: ds.map(fmt).join('〜'),
             urgent: (diff >= 0 && diff <= 7) ? '急遽の変更で恐れ入りますが、' : '' };
  };
  // 対象時間 "HH:MM-HH:MM" → 「17:00〜22:00」。未設定なら空文字。
  const reqTimeLabel = (reqTime) => {
    const p = reqTimeToHM(reqTime);
    return p ? `${p.sh}:${p.sm}〜${p.eh}:${p.em}` : '';
  };
  // ①送信用（依頼/募集）文言
  function wowtalkMessage(target, targetDateStr, change, requester, reqTime) {
    const { label: dateLabel, urgent } = dateLabelOf(targetDateStr);
    const span = reqTimeLabel(reqTime);
    // 全員宛（休み募集）は「代われる人いませんか」の募集メッセージにする
    if (target === '全員') {
      const who = (requester || '').trim();
      return `お疲れ様です。${urgent}${dateLabel}${span ? ` ${span}` : ''}` +
        `${who ? `の${who}さんのシフト` : 'のシフト'}について、` +
        `${change ? `${String(change).trim()}の` : ''}お休み希望が出ています。`
        + 'どなたか代わっていただける方はいらっしゃいませんでしょうか。';
    }
    const parts = String(change || '').split(/\s*(?:=>|→|->|⇒)\s*/);
    let body;
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      body = `現在${fmtTimeToken(parts[0])}のところ、${fmtTimeToken(parts[1])}に変更願えませんでしょうか。`;
    } else {
      // freeformは末尾の「に変更/へ変更」を落として二重表現を防ぐ（例「14時入りに変更」→「14時入り」）
      const after = String(change || '').trim().replace(/[にへ]変更$/, '').trim() || String(change || '').trim();
      // 変更内容が空なら「〜に変更」だけが残って文が壊れるので、汎用文にする
      body = after ? `${after}に変更願えませんでしょうか。` : '変更をお願いできませんでしょうか。';
    }
    return `お疲れ様です。${urgent}${dateLabel}${span ? ` ${span}` : ''}のシフトについて、${body}`;
  }
  // ②本人向け（反映完了）文言。person=本人（通常は対象者/全員なら発信者）
  function wowtalkDoneMessage(person, targetDateStr, reqTime) {
    const { label: dateLabel } = dateLabelOf(targetDateStr);
    const span = reqTimeLabel(reqTime);
    const who = (person || '').trim();
    return `お疲れ様です。${who ? `${who}さん、` : ''}${dateLabel}${span ? ` ${span}` : ''}のシフトの件、`
      + '反映しました！ご対応ありがとうございます。';
  }
  // 起票/編集直後に、コピペ用の文言（①送信用 ②反映完了）を #scNewForm 内に2枚出す
  function scShowWowtalk(target, targetDateStr, change, requester, reqTime) {
    const person = (target && target !== '全員') ? target : (requester || '');
    const sendMsg = wowtalkMessage(target, targetDateStr, change, requester, reqTime);
    const doneMsg = wowtalkDoneMessage(person, targetDateStr, reqTime);
    const label = target === '全員' ? `全員宛・休み募集（${esc(requester || '')}）`
      : (target ? esc(target) : '対象者なし');
    const block = (head, msg) =>
      `<div style="font-weight:700;margin:6px 0 3px">${head}</div>` +
      `<textarea class="sc-wt-text" style="width:100%;height:76px;border:1px solid #ccc;border-radius:4px;` +
      `padding:6px 8px;font-size:14px;resize:vertical;box-sizing:border-box">${esc(msg)}</textarea>` +
      '<div style="margin-top:3px"><button class="sc-wt-copy">📋 コピー</button></div>';
    const f = $('#scNewForm');
    f.innerHTML =
      `<div style="font-weight:700;margin-bottom:2px">📋 WowTalk用の文言（${label}）</div>` +
      block(`① 全体/相手に送信（${target === '全員' ? '休み募集' : '依頼'}）`, sendMsg) +
      block('② 本人へ（反映できたら送る）', doneMsg) +
      '<div style="margin-top:6px"><button id="scWtClose">閉じる</button></div>';
    f.style.display = '';
  }

  function scOpenNewFor(name) {
    shiftPanel.classList.add('open');
    localStorage.setItem('rfShiftOpen', '1');
    repositionShiftPanel();
    if (!$('#scNewForm').innerHTML) scBuildNewForm();
    $('#scNewForm').style.display = '';
    $('#scNewTarget').value = name.replace(/\s+/g, '');
    $('#scNewDate').value = `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;
    $('#scNewDateEnd').value = '';
    if ($('#scNewKind').value === 'crew') {
      $('#scNewRequester').value = name.replace(/\s+/g, '');
    }
    $('#scNewChange').focus();
    scRefresh();
  }

  function updateReqButtons() {
    if (isPrintPage) return;
    for (const nameEl of document.querySelectorAll('.user-cell .name')) {
      const row = nameEl.closest('.row') || nameEl.parentElement;
      if (!row || row.querySelector('.rf-req-btn')) continue;
      const name = (nameEl.textContent || '').trim();
      if (!name) continue;
      const btn = document.createElement('button');
      btn.className = 'rf-req-btn';
      btn.textContent = '＋';
      btn.title = `${name} のシフト変更依頼を起票`;
      btn.style.cssText = 'flex:none;margin-left:3px;width:17px;height:17px;line-height:15px;padding:0;' +
        'border:1px solid #b9a3dd;border-radius:4px;background:#f4effb;color:#6b46a8;' +
        'font-weight:700;cursor:pointer;font-size:12px;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        scOpenNewFor(name);
      });
      nameEl.after(btn);
    }
  }

  $('#shiftToggle').addEventListener('click', () => {
    shiftPanel.classList.toggle('open');
    localStorage.setItem('rfShiftOpen', shiftPanel.classList.contains('open') ? '1' : '0');
    repositionShiftPanel();
    if (shiftPanel.classList.contains('open')) scRefresh();
  });
  if (localStorage.getItem('rfShiftOpen') === '1') { shiftPanel.classList.add('open'); }
  repositionShiftPanel();

  $('#scReload').addEventListener('click', scRefresh);
  const scSetFilter = (f) => {
    scFilter = f;
    localStorage.setItem('rfScFilter', f); // 日付遷移(フルリロード)しても選択を引き継ぐ
    $('#scFilterOpen').classList.toggle('on', f === 'open');
    $('#scFilterDay').classList.toggle('on', f === 'day');
    $('#scFilterAll').classList.toggle('on', f === 'all');
    scRenderList();
  };
  $('#scFilterOpen').addEventListener('click', () => scSetFilter('open'));
  $('#scFilterDay').addEventListener('click', () => scSetFilter('day'));
  $('#scFilterAll').addEventListener('click', () => scSetFilter('all'));
  // 前回のフィルタ選択を復元
  const savedScFilter = localStorage.getItem('rfScFilter');
  if (savedScFilter && ['open', 'day', 'all'].includes(savedScFilter)) scSetFilter(savedScFilter);
  $('#scNewBtn').addEventListener('click', () => {
    const f = $('#scNewForm');
    if (f.style.display !== 'none') { scCloseNewForm(); return; } // 開いていれば閉じる
    if (!f.innerHTML) scBuildNewForm();
    $('#scNewDate').value = scDateStr(); // 開くたびに表示中の日へ合わせる
    $('#scNewDateEnd').value = '';
    f.style.display = '';
  });

  shiftPanel.addEventListener('change', async (ev) => {
    const box = ev.target;
    if (!box.matches('input[type=checkbox][data-p]')) return;
    box.disabled = true;
    const r = await shiftApi('/api/shift/flag', { path: box.dataset.p, key: box.dataset.k, value: box.checked });
    if (!r.ok) alert(`更新失敗: ${r.error || r.data?.error || ''}`);
    scRefresh();
  });
  shiftPanel.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.matches('.sc-note-input button')) {
      const input = t.parentElement.querySelector('input');
      const text = (input.value || '').trim();
      if (!text) return;
      t.disabled = true;
      const r = await shiftApi('/api/shift/note', { path: t.dataset.p, text });
      if (!r.ok) alert(`追記失敗: ${r.error || r.data?.error || ''}`);
      scRefresh();
    }
    if (t.id === 'scNewCreate') {
      const zenin = $('#scNewZenin') && $('#scNewZenin').checked;
      const person = ($('#scNewTarget').value || '').trim();   // 全員宛では「休みにしたい人」
      const targetDate = scJoinDate($('#scNewDate').value, $('#scNewDateEnd').value);
      const change = $('#scNewChange').value;
      // 対象者が空（=対象者なし・他の人に募集ラインを出さない）は誤入力しやすいので確認する
      if (!zenin && !person && !confirm('対象者なしで間違いありませんか？\n（他の人の行に募集の黄色ラインは出ません）')) return;
      t.disabled = true;
      // 全員宛（休み募集）: target='全員' / 発信者=休みたい人。通常は入力どおり。
      const target = zenin ? '全員' : person;
      const requester = zenin ? person.replace(/\s+/g, '') : $('#scNewRequester').value;
      const reqTime = readReqTime($('#scNewForm'), 'scn');
      const r = await shiftApi('/api/shift/create', {
        target, target_date: targetDate, change, req_time: reqTime,
        requester,
        source: $('#scNewSource').value, memo: $('#scNewMemo').value,
      });
      t.disabled = false;
      if (!r.ok) { alert(`作成失敗: ${r.error || r.data?.error || ''}`); return; }
      scShowWowtalk(target, targetDate, change, requester, reqTime);   // 起票直後にWowTalk用文言を出す
      scRefresh();
    }
    if (t.id === 'scNewCancel') scCloseNewForm();
    if (t.id === 'scWtClose') scCloseNewForm();
    if (t.matches('.sc-wt-copy')) {
      // このボタンの直前の textarea をコピー（①送信用 / ②反映完了 のそれぞれ）
      const ta = t.closest('div').previousElementSibling;
      const text = ta && ta.matches('.sc-wt-text') ? ta.value : '';
      try { await navigator.clipboard.writeText(text); }
      catch { if (ta) { ta.select(); document.execCommand('copy'); } }  // 権限が無い場合のフォールバック
      t.textContent = '✓ コピーしました';
      setTimeout(() => { if (t) t.textContent = '📋 コピー'; }, 1500);
    }

    // 依頼の削除（恒久削除ではなく archived/ 退避・可逆）。歯止めは「理由必須」。
    if (t.matches('.sc-del-btn')) {
      const card = t.closest('.sc-card');
      const form = card.querySelector('.sc-del-form');
      form.style.display = form.style.display === 'none' ? 'flex' : 'none';
      if (form.style.display === 'flex') form.querySelector('.sc-del-reason').focus();
    }
    if (t.matches('.sc-del-cancel')) {
      const form = t.closest('.sc-del-form');
      form.style.display = 'none';
      form.querySelector('.sc-del-reason').value = '';
    }
    if (t.matches('.sc-del-do')) {
      const input = t.parentElement.querySelector('.sc-del-reason');
      const reason = (input.value || '').trim();
      if (!reason) { input.focus(); input.placeholder = '削除理由を入力してください'; return; }
      t.disabled = true;
      const r = await shiftApi('/api/shift/delete', { path: t.dataset.p, reason });
      if (!r.ok) { alert(`削除失敗: ${r.error || r.data?.error || ''}`); t.disabled = false; return; }
      scRefresh();
    }

    // 依頼の拒否（本人が断った）。理由は任意。削除(archived)とは別で案件は残る・可逆。
    if (t.matches('.sc-rej-btn')) {
      const form = t.closest('.sc-card').querySelector('.sc-rej-form');
      form.style.display = form.style.display === 'none' ? 'flex' : 'none';
      if (form.style.display === 'flex') form.querySelector('.sc-rej-reason').focus();
    }
    if (t.matches('.sc-rej-cancel')) {
      const form = t.closest('.sc-rej-form');
      form.style.display = 'none';
      form.querySelector('.sc-rej-reason').value = '';
    }
    if (t.matches('.sc-rej-do')) {
      const reason = (t.parentElement.querySelector('.sc-rej-reason').value || '').trim();
      t.disabled = true;
      const r = await shiftApi('/api/shift/reject', { path: t.dataset.p, value: true, reason });
      if (!r.ok) { alert(`拒否失敗: ${r.error || r.data?.error || ''}`); t.disabled = false; return; }
      scRefresh();
    }
    if (t.matches('.sc-unrej-btn')) {
      t.disabled = true;
      const r = await shiftApi('/api/shift/reject', { path: t.dataset.p, value: false });
      if (!r.ok) { alert(`取消失敗: ${r.error || r.data?.error || ''}`); t.disabled = false; return; }
      scRefresh();
    }

    // 依頼の編集（対象者/対象日/変更内容/対象時間をまとめて上書き）
    if (t.matches('.sc-edit-btn')) {
      const form = t.closest('.sc-card').querySelector('.sc-edit-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
      if (form.style.display === 'block') form.querySelector('.sc-edit-change').focus();
    }
    if (t.matches('.sc-edit-cancel')) t.closest('.sc-edit-form').style.display = 'none';
    if (t.matches('.sc-edit-do')) {
      const f = t.closest('.sc-edit-form');
      const target = f.querySelector('.sc-edit-target').value;
      const targetDate = scJoinDate(f.querySelector('.sc-edit-date').value,
                                    f.querySelector('.sc-edit-date-end').value);
      const change = f.querySelector('.sc-edit-change').value;
      // 編集は6チェックを変えないので、編集前の状態でチェック有無を見ておく
      const cur = (scState?.cases || []).find((c) => c.path === t.dataset.p);
      const noChecks = !cur || cur.checked_count === 0;
      t.disabled = true;
      const reqTime = readReqTime(f, 'sce');
      const r = await shiftApi('/api/shift/edit', {
        path: t.dataset.p, target, target_date: targetDate, change, req_time: reqTime,
      });
      if (!r.ok) { alert(`編集失敗: ${r.error || r.data?.error || ''}`); t.disabled = false; return; }
      // まだチェックが1つも付いていない依頼は、更新後の内容でWowTalk文言を出し直す（本人指定）
      if (noChecks) scShowWowtalk(target, targetDate, change, cur && cur.requester, reqTime);
      scRefresh();
    }
  });
  shiftPanel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('.sc-note-input input')) {
      ev.target.parentElement.querySelector('button').click();
    }
    if (ev.key === 'Enter' && ev.target.matches('.sc-del-reason')) {
      ev.target.parentElement.querySelector('.sc-del-do').click();
    }
    if (ev.key === 'Enter' && ev.target.matches('.sc-rej-reason')) {
      ev.target.parentElement.querySelector('.sc-rej-do').click();
    }
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

  // 海賊版らくしふセクションの折りたたみ（見出しの月セレクタ/ボタン/リンクは対象外）
  function applyDraftFold() {
    const hidden = localStorage.getItem('rfDraftHidden') === '1';
    $('#draft').style.display = hidden ? 'none' : '';
    $('#draftFold').textContent = hidden ? '▸' : '▾';
  }
  $('#draftTitle').addEventListener('click', (ev) => {
    if (ev.target.closest('select, button, a')) return;
    const hidden = localStorage.getItem('rfDraftHidden') === '1';
    localStorage.setItem('rfDraftHidden', hidden ? '0' : '1');
    applyDraftFold();
  });
  applyDraftFold();

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

  // バッジ類は名前と同じ行に入れると名前が省略されて消えるため、名前の下の専用行に置く
  function badgeBox(nameEl) {
    const row = nameEl.closest('.row') || nameEl.parentElement;
    if (!row || !row.parentElement) return null;
    let box = [...row.parentElement.children].find((e) => e.classList?.contains('rf-badges'));
    if (!box) {
      box = document.createElement('div');
      box.className = 'rf-badges';
      box.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px 3px;margin-top:1px;';
      row.after(box);
    }
    return box;
  }

  function updateWeekBadges(per) {
    if (!per || isPrintPage) return; // 印刷画面にはバッジを出さない（紙に載せない）
    for (const nameEl of document.querySelectorAll('.user-cell .name')) {
      const nm = (nameEl.textContent || '').replace(/\s+/g, '');
      const st = per[nm];
      const box = badgeBox(nameEl);
      if (!box) continue;
      let b = box.querySelector('.rf-week-badge');
      if (!st) { b?.remove(); continue; }
      if (!b) {
        b = document.createElement('span');
        b.className = 'rf-week-badge';
        b.style.cssText = 'font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#2c6e49;background:#eef4f0;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;';
        box.appendChild(b);
      }
      b.textContent = `週${st.days.size}日/${Math.round(st.mins / 6) / 10}h`;
      b.title = `この週(月〜日)のアサイン合計（休憩控除後・ヘルプ含む）`;

      // 出勤曜日の表示（月〜日、出勤日を濃く）
      let wd = box.querySelector('.rf-week-days');
      if (!wd) {
        wd = document.createElement('span');
        wd.className = 'rf-week-days';
        wd.style.cssText = 'font:700 10px/14px -apple-system,"Hiragino Sans",sans-serif;' +
          'background:#f7f7f7;border-radius:4px;padding:1px 4px;white-space:nowrap;flex:none;letter-spacing:1px;';
        b.after(wd);
      }
      const dows = new Set([...st.days].map((ds) => parseYmd(ds)?.getDay()));
      wd.innerHTML = [1, 2, 3, 4, 5, 6, 0].map((dow) =>
        `<span style="color:${dows.has(dow) ? (dow === 0 ? '#c33' : dow === 6 ? '#26c' : '#222') : '#d5d5d5'}">${WEEKDAYS[dow]}</span>`
      ).join('');
      wd.title = '出勤曜日（この週）';
    }
  }

  // ===== らくしふ画面上のヒートバー（実人数と不足） =====
  // 各セクションの時間軸ヘッダー(.time-header)直下に、実人数と 実−REQ を行として差し込む。
  // フロア・キッチンのどちらでも同じ内容を出す（下の STRIP_ROWS 参照）。
  // 不足=赤、SURPLUS_WARN以上のプラス=緑(浪費警告)。
  // 表示中の日とパネルの対象日が一致するOneDayのときだけ出す。
  let lastStrip = null; // {catDiffs, tip, catActs} Vue再描画後の張り直し用
  // 帯の段構成（上から順に描画）。フロア/キッチンのどちらのセクションでも**同じ内容**を出す。
  // 経緯: 以前は差分だけそのセクションのカテゴリ（フロア=差F / キッチン=差K）だったが、
  // 「実Fの隣に差F、実Kの隣に差K」で見たいという本人指定（2026-07-21）で全段共通に統一。
  // どちらのセクションを見ていても F/K 両方の過不足がその場で判断できる。
  // [種別, データのキー, 見出し]。act=いま何人 / diff=あと何人(実−REQ)。
  // TRは研修中の人数（TRer+TRee）で、見出しは本人指定の「TR」。
  // 実数の数字に色は付けない（本人指定）。色は差分の不足/過剰の意味だけに残す。
  const STRIP_ROWS = [
    ['act', 'F', '実F'], ['diff', 'F', '差F'],
    ['act', 'K', '実K'], ['diff', 'K', '差K'],
    ['act', 'FK', '実FK'], ['diff', 'FK', '差FK'],
    ['act', 'TR', 'TR'],
  ];
  const ACT_STRIP_COLOR = '#374151'; // 実数の数字・見出しとも中立色
  const DIFF_LABEL_COLOR = '#6b7280';
  let lastLE = null;
  const onOneDayTarget = () => {
    const p = new URLSearchParams(location.search);
    const fromD = parseYmd(p.get('from') || '');
    return p.get('u') === 'OneDay' && fromD && ymd(fromD) === ymd(targetDate);
  };

  // 要素が属するセクションを「直前の .table-title」で判定し F/K を返す（対象外はnull）。
  // 旧実装は全要素からテキストが「フロア/キッチン」の葉要素を拾っていたが、同じ文字列が
  // help-info（ツールチップ）にも現れるため誤検出し、見出しと帯の対応が1つずつズレていた
  // （実DOMで確認: 見出し6件検出 vs 帯4件）。実際のセクションは
  // フロア/キッチン/清掃/正社員 の4つで、清掃・正社員はクルーREQの比較対象外。
  const CAT_OF = { 'フロア': 'F', 'キッチン': 'K' };
  function sectionCatOf(el) {
    let sec = null;
    for (const t of document.querySelectorAll('.table-title')) {
      if (t.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        sec = (t.textContent || '').trim();
      }
    }
    return CAT_OF[sec] || null;
  }

  function updateStrips(catDiffs, tipFor, catActs, basisName) {
    document.querySelectorAll('.rf-heat-strip, .rf-strip-label').forEach((e) => e.remove());
    lastStrip = catDiffs ? { catDiffs, tip: tipFor, catActs, basisName } : null;
    if (!catDiffs || !onOneDayTarget()) return;
    // 各 time-header が属するセクションを「直前の .table-title」で決める。
    // 旧実装は全要素からテキストが「フロア/キッチン」の葉要素を拾っていたが、
    // 同じ文字列が help-info（ツールチップ）にも出るため誤検出し、見出しと帯の対応が
    // 1つずつズレていた（実DOMで確認: 見出し6件検出 vs 帯4件）。
    // 実際のセクションは フロア/キッチン/清掃/正社員 の4つ。清掃・正社員はクルーREQの
    // 比較対象外なので帯を出さない。
    for (const header of document.querySelectorAll('.time-header')) {
      if (!sectionCatOf(header)) continue;   // 清掃・正社員はクルーREQの対象外
      const stripCss =
        'display:flex;height:16px;font:700 10px/16px -apple-system,"Hiragino Sans",sans-serif;' +
        'text-align:center;position:relative;overflow:visible;';
      // 行ラベルは「時刻の左にある固定列のTH」の中に入れる。
      // 経緯: 帯の左外側へ絶対配置(v1.27)は見えず、帯の内側(v1.29)は6時の数字に重なった。
      // 実DOMを調べたところ overflow は全て visible で、原因は重なり順だった:
      //   左列 th.top-left-corner-sticky は z-index:1100・背景不透明、
      //   帯のある th.timeline-sticky は z-index:1000 → 左に出したラベルが左列の背面に回る。
      // よって左列のTHへ入れる。THはsticky=配置済み要素なので絶対配置の基準になる。
      // 縦位置は帯を挿入した後に実測して合わせる（TH内部の高さが時刻ヘッダーと違うため）。
      const leftTh = header.closest('tr') && header.closest('tr').querySelector('th');
      // THは中身を上下中央に置くため、帯を足して行が伸びると「指定順/スタッフ並替」が
      // 下がってきてラベルと衝突する。上寄せにして衝突を防ぐ（実機で確認済み）。
      if (leftTh) leftTh.style.verticalAlign = 'top';
      const addLabel = (el, text, color) => {
        if (!leftTh) return;
        const lb = document.createElement('div');
        lb.className = 'rf-strip-label';
        lb.textContent = text;
        lb.style.cssText = 'position:absolute;left:8px;height:16px;white-space:nowrap;' +
          `font:700 10px/16px -apple-system,"Hiragino Sans",sans-serif;color:${color};`;
        leftTh.appendChild(lb);
        // 帯がレイアウトされてから位置を確定させる
        requestAnimationFrame(() => {
          const top = el.getBoundingClientRect().top - leftTh.getBoundingClientRect().top;
          lb.style.top = `${Math.round(top)}px`;
        });
      };
      // 1段ぶんの帯を作る。act=いま何人（中立色）/ diff=あと何人（不足赤・過剰緑）。
      const makeStrip = (kind, values, label) => {
        const s = document.createElement('div');
        s.className = kind === 'act' ? 'rf-heat-strip rf-act-strip' : 'rf-heat-strip';
        s.style.cssText = stripCss + (kind === 'act' ? `color:${ACT_STRIP_COLOR};` : '');
        for (const c of header.children) {
          const txt = (c.textContent || '').trim();
          const h = /^\d{1,2}$/.test(txt) ? +txt : null;
          const i = h !== null ? HOURS.indexOf(h) : -1;
          const cell = document.createElement('div');
          cell.style.cssText = `width:${c.getBoundingClientRect().width}px;flex:none;`;
          const v = i >= 0 ? values[i] : undefined;
          if (v !== undefined && v !== null && (kind === 'diff' || v)) {
            if (kind === 'act') {
              cell.textContent = String(v);
              cell.title = `${label} ${v}` + (tipFor ? `\n${tipFor(i)}` : '');
            } else {
              // |差分|<1 は軽微 → 塗りつぶさず白地に色文字。±1以上のみ塗りつぶしで強調
              if (v < 0) {
                cell.textContent = v;
                cell.style.cssText += v > -1
                  ? 'color:#d64545;'
                  : 'background:#d64545;color:#fff;border-radius:3px;';
              } else if (v >= SURPLUS_WARN) {
                cell.textContent = `+${v}`;
                cell.style.cssText += 'background:#2e9e5b;color:#fff;border-radius:3px;';
              } else if (v > 0 && v < 1) {
                cell.textContent = `+${v}`;
                cell.style.cssText += 'color:#2e9e5b;';
              } else {
                cell.textContent = v > 0 ? `+${v}` : '0';
                cell.style.cssText += 'color:#9aa8b5;';
              }
              if (tipFor) cell.title = tipFor(i);
            }
          }
          s.appendChild(cell);
        }
        return s;
      };

      let prev = header;
      for (const [kind, key, label] of STRIP_ROWS) {
        const values = kind === 'act' ? (catActs && catActs[key]) : catDiffs[key];
        if (!values) continue;
        // 差の帯は「どの基準に対する差か」が分かるよう見出しに基準名を付ける（差F(LE) 等）
        const lb = kind === 'diff' && basisName ? `${label}(${basisName})` : label;
        const s = makeStrip(kind, values, lb);
        prev.after(s);
        addLabel(s, lb, kind === 'act' ? ACT_STRIP_COLOR : DIFF_LABEL_COLOR);
        prev = s;
      }
    }
  }

  // ===== 前年客数・修正客数の下に LE客数 行と 必要人数(REQ計) 行を注入 =====
  // 印刷画面用: .custom-field-rows(前年/修正客数)へ行を追加。
  // グループはDOM順=編集画面のセクション順(フロア→キッチン)前提で F/K を割当
  function updatePrintRows(le, reqPack) {
    document.querySelectorAll('.rf-le-row-p, .rf-req-row-p').forEach((e) => e.remove());
    if (!le || !onOneDayTarget()) return;
    const groups = [...document.querySelectorAll('.custom-field-rows')].filter((g) => g.children.length > 0);
    groups.forEach((g, gi) => {
      const proto = [...g.children].find((r) =>
        (r.querySelector('.header')?.textContent || '').includes('修正客数')) || g.lastElementChild;
      if (!proto) return;
      const mk = (cls, label, vals, color, total) => {
        const clone = proto.cloneNode(true);
        clone.classList.add(cls);
        const head = clone.querySelector('.header');
        if (head) {
          head.innerHTML = `<span style="font-weight:700;color:${color};">${label}</span>` +
            `<span style="color:${color};">合計: ${total || '-'}</span>`;
        }
        const cells = [...clone.children].filter((c) => !c.classList.contains('header'));
        cells.forEach((cell, idx) => {
          cell.textContent = idx < HOURS.length ? (vals[idx] || '') : '';
          cell.style.color = color;
          cell.style.fontWeight = '700';
        });
        g.appendChild(clone);
      };
      mk('rf-le-row-p', 'LE客数', le.hours, '#1a5fb4', le.total);
      if (gi === 0) {
        if (reqPack?.f) mk('rf-req-row-p', '必要F', reqPack.f.hours, '#2c6e49', reqPack.f.total);
      } else {
        if (reqPack?.k) mk('rf-req-row-p', '必要K', reqPack.k.hours, '#2c6e49', reqPack.k.total);
      }
      if (reqPack?.fk) mk('rf-req-row-p', '必要FK', reqPack.fk.hours, '#0e7490', reqPack.fk.total);
    });
  }

  function updateLERows(le, reqPack, act) {
    lastLE = le ? { le, reqPack, act } : null;
    if (isPrintPage) { updatePrintRows(le, reqPack); return; }
    document.querySelectorAll('.rf-le-row, .rf-req-row, .rf-act-row').forEach((e) => e.remove());
    if (!le || !onOneDayTarget()) return;
    const labels = [...document.querySelectorAll('th.metrics-row-header')]
      .filter((th) => (th.textContent || '').includes('修正客数'));
    for (const th of labels) {
      const tr = th.closest('tr');
      if (!tr) continue;
      // 清掃・正社員セクションにも修正客数行があれば拾ってしまうため、
      // 帯と同じ判定でフロア/キッチンだけに絞る
      if (!sectionCatOf(tr)) continue;
      // 修正客数行のクローンにラベルと値を差し替えた行を作る。
      // opts.sub があれば各セルを2段（上=vals / 下=opts.sub.vals）にする（必要/WS併記用）。
      const mkRow = (cls, labelHtml, vals, color, tipFn, styleFn, opts) => {
        const clone = tr.cloneNode(true);
        clone.classList.add(cls);
        const cth = clone.querySelector('th.metrics-row-header');
        if (cth) cth.innerHTML = labelHtml;
        // 時刻6..24の19セルが並ぶコンテナを探して値を差し替え
        const rowCells = [...clone.querySelectorAll('*')].find((e) => e.children.length === 19);
        const sub = opts && opts.sub;
        if (rowCells) {
          [...rowCells.children].forEach((cell, idx) => {
            const top = idx < HOURS.length ? (vals[idx] || '') : '';
            if (sub && idx < HOURS.length) {
              const sv = sub.vals[idx] ? String(sub.vals[idx]) : '';
              cell.innerHTML =
                `<div style="line-height:1.05;color:${color}">${top}</div>` +
                `<div style="line-height:1.05;font-size:9px;font-weight:600;color:${sub.color}">${sv}</div>`;
            } else {
              cell.textContent = top;
              cell.style.color = color;
            }
            cell.style.fontWeight = '700';
            if (tipFn && idx < HOURS.length) cell.title = tipFn(idx);
            if (styleFn && idx < HOURS.length) styleFn(cell, idx);
          });
        }
        return clone;
      };
      const leRow = mkRow('rf-le-row',
        `<span style="font-weight:700;color:#1a5fb4;">LE客数 (合計: ${le.total || '-'})</span>`,
        le.hours, '#1a5fb4');
      tr.after(leRow);

      // 必要人数は F/K/FK を全部、フロア・キッチンの両方に出す（本人指定）。
      // どちらのセクションを見ていても店全体の必要と実が一度に読めるようにするため。
      // 時刻直下のヒートバー(updateStrips)も同じ理由で両セクション共通にしてある。
      let anchor = leRow;
      const tipSum = reqPack?.sum ? (i) => `REQ計 ${reqPack.sum.hours[i] || '0'}` : null;
      // 必要行(LE由来)の各セル下に、モデルWS(曜日テンプレ)の同区分を小さく併記する。
      // 上=LE必要 / 下=WS。ラベルにも「合計: 必要 / WS」を出す。WSは緑系の色で区別。
      const WS_SUB_COLOR = '#b45309'; // 琥珀。必要(緑/ティール)と区別
      const addReq = (label, row, color, wsRow) => {
        if (!row) return;
        const bn = reqPack?.basisName || 'LE', sn = reqPack?.subName || 'モデルWS';
        const tipFn = wsRow
          ? (i) => `${label.slice(2)} 上=${bn} ${row.hours[i] || '0'} / 下=${sn} ${wsRow.hours[i] || 0}`
          : tipSum;
        // ラベルの色をセルの上下段と一致させる: 上段(=基準)=color / 下段(=もう一方)=琥珀。
        // どちらが基準か分かるよう見出しに基準名(LE/モデルWS)を出す。
        const labelHtml = wsRow
          ? `<span style="font-weight:700;color:${color};">${label}(${bn}) ${row.total || '-'}</span>`
            + `<span style="font-weight:700;color:${WS_SUB_COLOR};">／${sn} ${wsRow.total}</span>`
            + `<span style="font-weight:400;font-size:9px;color:#9aa8b5;"> 上${bn}/下${sn}</span>`
          : `<span style="font-weight:700;color:${color};">${label}(${bn}) (合計: ${row.total || '-'})</span>`;
        const r = mkRow('rf-req-row', labelHtml,
          row.hours, color, tipFn, null,
          wsRow ? { sub: { vals: wsRow.hours, color: WS_SUB_COLOR } } : null);
        anchor.after(r);
        anchor = r;
      };
      // 実人数（いまらくしふ上で組まれている人数）を対応する必要行の直下に出す。
      // 色・不足判定はパネルの実F/実K行と同じ規則（紫、不足1人以上=赤塗り・1人未満=赤字）。
      const addAct = (label, arr, reqRow, sumV) => {
        if (!arr) return;
        const r = mkRow('rf-act-row',
          `<span style="font-weight:700;color:#6b21a8;">${label} (合計: ${sumV ?? '-'})</span>`,
          HOURS.map((h, i) => (arr[i] ? String(arr[i]) : '')), '#6b21a8', null,
          reqRow ? (cell, i) => {
            const deficit = num(reqRow.hours[i]) - arr[i];
            if (deficit >= 1) { cell.style.background = '#fdecec'; cell.style.color = '#b02a2a'; }
            else if (deficit > 1e-9) cell.style.color = '#b02a2a';
          } : null);
        anchor.after(r);
        anchor = r;
      };
      const ws = reqPack?.sub;   // 併記するもう一方の基準（LE⇔WS）
      addReq('必要F', reqPack?.f, '#2c6e49', ws?.f);
      addAct('実F', act?.F, reqPack?.f, act?.sum?.F);
      addReq('必要K', reqPack?.k, '#2c6e49', ws?.k);
      addAct('実K', act?.K, reqPack?.k, act?.sum?.K);
      addReq('必要FK', reqPack?.fk, '#0e7490', ws?.fk);
      // 実FK: FK需要はF/Kの余剰でも埋まるため単独の不足判定はしない（パネルと同じ）
      addAct('実FK', act?.FK, null, act?.sum?.FK);
    }
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
      renderTasks(); // 取得不可でもタスク欄は独立して更新する
      renderDraft().catch(() => {});
    updateDraftGhosts().catch(() => {});
      updateStrips(null);
      updateLERows(null);
      return;
    }
    const { header, hourly } = res;

    $('#stats').innerHTML = HEADER_LABELS
      .map((l) => `<span class="chip">${l} <b>${header[l] || '-'}</b></span>`)
      .join('');

    // 時間を横軸に: 列 = 6:00〜23:00 + 計、行 = LE / REQ F / REQ K / REQ計
    const nowHour = new Date().getHours();
    const isToday = ymd(targetDate) === ymd(new Date());
    const nowCls = (h) => (isToday && h === nowHour ? ' now' : '');

    // 実人数 (らくしふ現シフト・休憩控除済) と REQ の比較。マイナス＝不足
    const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
    // ===== REQの基準: LE(客数から算出) or モデルWS(計画人数) を切り替え =====
    // どちらが主か分からないという指摘。主=基準／従=もう一方 を必要行に併記する。
    const leReq = { sum: hourly['REQ（SUM）'], f: hourly['REQ（F）'],
                    k: hourly['REQ（K）'], fk: hourly['REQ（FK）'] };
    const toRow = (a) => ({
      hours: a.hours.map((v) => (v ? String(Math.round(v * 10) / 10) : '')),
      total: String(Math.round(a.total)),
    });
    const wsReq = res.wsPack ? (() => {
      const p = res.wsPack;
      const sumH = HOURS.map((h, i) => (p.f.hours[i] || 0) + (p.k.hours[i] || 0) + (p.fk.hours[i] || 0));
      return { sum: toRow({ hours: sumH, total: sumH.reduce((x, y) => x + y, 0) }),
               f: toRow(p.f), k: toRow(p.k), fk: toRow(p.fk) };
    })() : null;
    const useWs = reqBasis() === 'ws' && wsReq;
    const primary = useWs ? wsReq : leReq;     // 基準（必要行の上段・差分の相手）
    const secondary = useWs ? leReq : wsReq;   // 併記（必要行の下段）
    const basisName = useWs ? 'モデルWS' : 'LE', subName = useWs ? 'LE' : 'モデルWS';
    // この日に適用するモデルWS型の選択欄。自動=曜日割当に従う／型を選ぶと日別上書き。
    {
      const params = (leMakerCache && leMakerCache.params) || {};
      const tpls = (params.ws && params.ws.templates) || [];
      const iso = ymd(targetDate);
      const ovr = ((params.byDate || {})[iso] || {}).wsTpl || '';
      const auto = wsAutoTpl(params, iso, num(hourly['LE']?.total));
      const sel = $('#wsTplSel');
      sel.innerHTML = `<option value="">自動（${auto ? esc(auto.name) : '未設定'}）</option>` +
        tpls.map((t) => `<option value="${esc(t.id)}"${t.id === ovr ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
      sel.value = ovr;
      sel.style.display = tpls.length ? '' : 'none';
    }
    // WSが無い日（モデルWSの曜日割当が未設定など）は、黙ってLEに戻らず理由を出す
    const wantWs = reqBasis() === 'ws';
    $('#reqBasis').textContent = wsReq ? `基準: ${basisName}` : '基準: LE（モデルWS未設定）';
    $('#reqBasis').title = wsReq
      ? '必要人数(REQ)の基準を切り替え。LE=客数から算出 / モデルWS=モデルWSの計画人数'
      : 'この日はモデルWSが決まっていません（海賊版らくしふの📐モデルWSで、この曜日に型を割り当ててください）。'
        + (wantWs ? '\nモデルWS基準を選んでいますがLEで表示しています。' : '');
    const req = primary.sum;
    const reqF = primary.f, reqK = primary.k;
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

    // REQ行は選択中の基準(LE/モデルWS)の値を出す。見出しにも基準名を付けてどちらか分かるようにする。
    const REQ_ROW = { 'REQ（F）': 'f', 'REQ（K）': 'k', 'REQ（FK）': 'fk', 'REQ（SUM）': 'sum' };
    const bodyRows = HOURLY_COLS.map((c) => {
      const key = REQ_ROW[c.rowLabel];
      const data = key ? primary[key] : hourly[c.rowLabel];
      const head = key ? `${c.head}(${basisName})` : c.head;
      const cells = HOURS.map((h, i) =>
        `<td class="${nowCls(h)}">${data ? (data.hours[i] || '') : '?'}</td>`).join('');
      return `<tr class="${c.cls}"><td class="row-head">${head}</td>${cells}` +
        `<td class="total">${data?.total ?? '?'}</td></tr>`;
    }).join('');

    let actualRows = '', diffRow = '';
    if (hasActual) {
      const fmt = (v) => (v === 0 ? '' : String(v));
      // 実F/実K/実計: 対応するREQを下回る時間帯を赤。不足1人以上=塗りつぶし、1人未満=赤字のみ
      const actRow = (arr, reqRow, label, sumV, extra = '') => {
        const cells = HOURS.map((h, i) => {
          const deficit = reqRow ? num(reqRow.hours[i]) - arr[i] : 0;
          const cls = deficit >= 1 ? ' short' : deficit > 1e-9 ? ' short-lite' : '';
          return `<td class="${nowCls(h)}${cls}">${fmt(arr[i])}</td>`;
        }).join('');
        return `<tr class="act${extra}"><td class="row-head">${label}</td>${cells}` +
          `<td class="total">${sumV}</td></tr>`;
      };
      actualRows =
        actRow(actual.F, reqF, '実F', actual.sum.F, ' act-first') +
        actRow(actual.K, reqK, '実K', actual.sum.K) +
        // 実FK: FK需要はF/Kの余剰でも埋まるため単独の不足判定はしない(素の表示)
        actRow(actual.FK, null, '実FK', actual.sum.FK) +
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
    const reqFK = primary.fk;   // 差分も選択中の基準に追従
    // 差は区分どおり忠実に出す（実F−必要F / 実K−必要K / 実FK−必要FK）。
    // 以前は実FKを0.5ずつ差F/差Kに配分していたが、FKはFK枠として見る方針に戻した（2026-07-23）。
    const mkDiff = (arr, reqRow) => (hasActual && arr) ? HOURS.map((h, i) => {
      const supply = arr[i] || 0;
      if (!reqRow?.hours?.[i] && !supply) return null;
      return Math.round((supply - num(reqRow?.hours?.[i])) * 10) / 10;
    }) : null;
    const catDiffs = hasActual ? {
      F: mkDiff(actual.F, reqF), K: mkDiff(actual.K, reqK), FK: mkDiff(actual.FK, reqFK),
    } : null;
    const tip = (i) =>
      `${HOURS[i]}時  F ${actual?.F?.[i] ?? '-'}/${reqF?.hours?.[i] || '0'}` +
      ` ・ K ${actual?.K?.[i] ?? '-'}/${reqK?.hours?.[i] || '0'}` +
      ` ・ FK ${actual?.FK?.[i] ?? '-'}/${reqFK?.hours?.[i] || '0'}` +
      ` ・ 計 ${actual?.total?.[i] ?? '-'}/${req?.hours?.[i] || '0'}`;
    updateStrips(catDiffs, tip,
      hasActual ? { F: actual.F, K: actual.K, FK: actual.FK, TR: actual.TR } : null, basisName);
    updateLERows(hourly['LE'],
      { sum: req, f: reqF, k: reqK, fk: reqFK, sub: secondary, basisName, subName },
      hasActual ? actual : null);
    // 週間アサインバッジ（非同期・失敗しても本体表示に影響させない）
    fetchWeekStats(targetDate)
      .then((per) => { lastWeekStats = per; updateWeekBadges(per); })
      .catch(() => {});
    renderTasks();
    renderDraft().catch(() => {});
    updateDraftGhosts().catch(() => {});
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

  // ===== シフト原案 (ShiftDraft・apps/ShiftDraft ポート8790) =====
  // 希望送信=表示月のdesiredを同一オリジンfetchしSW経由でPOST（Akamai認証は拡張が肩代わり）。
  // 原案はShiftDraft側で編集し、ここでは対象日の中身を読むだけ（らくしふへは書き込まない）。
  const draftApi = (path, payload) => new Promise((resolve) => {
    if (!alive()) return resolve(null);
    try { chrome.runtime.sendMessage({ type: 'draftApi', path, payload }, resolve); } catch { resolve(null); }
  });

  async function sendWishes() {
    // 折りたたみ中でも進捗/結果が見えるよう、送信時は開く
    localStorage.setItem('rfDraftHidden', '0');
    applyDraftFold();
    const el = $('#draft');
    const p = new URLSearchParams(location.search);
    const storeId = p.get('s');
    if (!storeId) { el.innerHTML = '<span class="err">store_id 不明</span>'; return; }
    const genreIds = p.getAll('g');
    // 対象月はセレクタから（らくしふの表示月に依存しない。APIは任意期間を取れる）
    const mv = $('#draftMonth').value;
    const [y, mo1] = mv.split('-').map(Number);
    const start = `${mv}-01`;
    const end = ymd(new Date(y, mo1, 0));
    el.innerHTML = `<span class="muted">${mv} の希望を取得中…</span>`;
    try {
      const q = new URLSearchParams();
      q.set('page_ctx_name', 'admin');
      q.set('store_id', storeId);
      for (const g of (genreIds.length ? genreIds : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
      q.set('start_date', start);
      q.set('end_date', end);
      q.set('is_staff_print_page', 'false');
      const r = await fetch('/ajax/admin/v2/schedules?' + q, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!r.ok) throw new Error(`シフトAPI HTTP ${r.status}`);
      const j = await r.json();
      const month = start.slice(0, 7);
      const res = await draftApi('/api/wishes', {
        meta: { month, store_id: storeId, captured_at: new Date().toISOString().slice(0, 19) },
        desired: j.desired || [], instructed: j.instructed || [],
        rest_times: j.rest_times || [], users: j.users || [],
      });
      if (!res || !res.ok) throw new Error((res && (res.error || (res.data || {}).msg)) || 'ShiftDraft未達');
      el.innerHTML = `<span class="allok">✓ ${month} 希望${res.data.desired}件を送信しました</span>`;
    } catch (e) {
      el.innerHTML = `<span class="err">送信失敗: ${e.message}</span>`;
    }
  }

  async function renderDraft() {
    const el = $('#draft');
    if (!el) return;
    const r = await draftApi('/api/draft-day?date=' + ymd(targetDate));
    if (!r || !r.ok) {
      el.innerHTML = '<span class="muted">ShiftDraft未達（Mac mini稼働とTailscaleを確認）</span>';
      return;
    }
    const list = r.data.assignments || [];
    const t = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    el.innerHTML = list.length
      ? list.map((a) =>
          `<div class="dli"><span class="dtag ${a.genre}">${a.genre}</span>${a.name} ${t(a.s)}-${t(a.e)}` +
          (a.rest ? `（休 ${t(a.rest[0])}-${t(a.rest[1])}）` : '') + (a.locked ? ' 🔒' : '') + '</div>')
        .join('')
      : '<span class="muted">この日の原案なし</span>';
  }

  // ===== 海賊版原案 → らくしふ実シフトへの反映（差分プレビュー＋1件ずつ手押し反映）=====
  // 方針（本人合意 2026-07-23）: 確定送信(/confirm)には一切触れない・削除もしない・
  // 反映は必ず1行ずつご本人のボタン押下で。ツールは「差分を出す/1件POSTする」まで。
  // 反映するのは (1)新規バー(create) と (2)時間・休憩の変更(retime) のみ。
  //   ・FK区分／既存が複数バー／時間指定タスク → 自動化せず「要手動」で表示。
  //   ・全域を覆う単一タスクだけは create 時に store_task_ids として付ける。
  const RF_GENRE = { F: 2, K: 3 };   // 原案の区分 → らくしふ attending_genre_id

  // ===== CK（温度・日付・廃棄）の自動割付 =====
  // 実測した運用（2026-06〜07の51件）に合わせる:
  //   ・CKは「タスクバー」ではなく**シフト全域タグ** = schedule.store_task_ids に入れる。
  //   ・毎日 温度×4（F午前/F午後/K午前/K午後）・日付×1（K午後）・廃棄×1（K午後のラスト）。
  //   ・付与先はすべて確定済み(is_shared)のシフト＝確定後に付ける運用なので、
  //     ここだけは is_shared でも書き込む（勤務時間は変えず、タグを足すだけ）。
  const CK_TASK = { 温度: 238056, 日付: 222328, 廃棄: 222329 };
  const NOON = 12 * 60;
  // 社会保険加入者（優先枠）。らくしふにも台帳にもデータが無いので、ここで手入力して維持する。
  // 名前は空白を除いた表記で（例 '千石京輔'）。空のままなら勤務時間順だけで並ぶ。
  const SOCIAL_INSURANCE = [];
  // 非GETに必須のCSRFトークン（らくしふページのDOMから読む。無ければ書けない）
  const rfCsrf = () => (document.querySelector('#csrf-token')?.dataset?.csrfToken) || '';
  // らくしふの確定/未確定シフト(instructed)を対象日ぶん生で取る
  async function fetchInstructedRaw(date) {
    const p = new URLSearchParams(location.search);
    const storeId = p.get('s');
    if (!storeId) throw new Error('store_id 不明');
    const q = new URLSearchParams();
    q.set('page_ctx_name', 'admin'); q.set('store_id', storeId);
    for (const g of (p.getAll('g').length ? p.getAll('g') : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
    q.set('start_date', ymd(date)); q.set('end_date', ymd(date)); q.set('is_staff_print_page', 'false');
    const r = await fetch('/ajax/admin/v2/schedules?' + q, {
      credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`シフトAPI HTTP ${r.status}`);
    const j = await r.json();
    return { storeId, list: (j.instructed || []).filter((s) => s.date === ymd(date) && !s.is_deleted) };
  }
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const restEq = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  // 分[s,e]の休憩配列 → らくしふ rest_times [{start_hour,start_minute,end_hour,end_minute}]
  const restsToApi = (rests) => (rests || [])
    .filter((r) => Array.isArray(r) && r.length === 2 && r[1] > r[0])
    .map(([s, e]) => ({ start_hour: Math.floor(s / 60), start_minute: s % 60,
                        end_hour: Math.floor(e / 60), end_minute: e % 60 }));
  // 既存バーの rest_times({start_hour..}) を分[s,e]配列へ（比較用）
  const apiRestToMin = (rt) => (rt || [])
    .map((r) => [r.start_hour * 60 + r.start_minute, r.end_hour * 60 + r.end_minute]);

  // 対象日の差分プランを組む。行: {kind, user_id, name, genre, payload, desc, manual?}
  async function buildReflectPlan(date) {
    const [draftR, cur, taskMap] = await Promise.all([
      draftApi('/api/draft-day?date=' + ymd(date)),
      fetchInstructedRaw(date),
      fetchStoreTaskMap(new URLSearchParams(location.search).get('s')).catch(() => ({})),
    ]);
    if (!draftR || !draftR.ok) throw new Error('ShiftDraft未達（原案が取れません）');
    const nameToTaskId = {};
    for (const [id, nm] of Object.entries(taskMap)) nameToTaskId[nm] = +id;
    const asg = draftR.data.assignments || [];
    // user_id ごとに: 本体バー(taskなし) と タスクバー に分ける
    const byUser = {};
    for (const a of asg) {
      const u = (byUser[a.user_id] ||= { name: a.name, shift: [], tasks: [], genre: a.genre });
      (a.task ? u.tasks : u.shift).push(a);
      if (a.genre) u.genre = a.genre;
    }
    // 既存バーを (user_id, attending_genre_id) で引く。区分跨ぎの誤マッチを防ぐ。
    const curKey = (uid, g) => `${uid}:${g}`;
    const curByUG = {};
    for (const s of cur.list) (curByUG[curKey(s.user_id, s.attending_genre_id)] ||= []).push(s);

    const rows = [];
    for (const [uidStr, u] of Object.entries(byUser)) {
      const uid = +uidStr;
      const genreId = RF_GENRE[u.genre];
      // 本体バー（タスクでないバー）だけを「シフト」とみなす。
      // タスクだけの人（固定作業のみ・研修枠のみ）はシフトが無いので自動対象にしない。
      const shiftBars = u.shift;
      const manualRow = (desc) => rows.push({
        kind: 'manual', user_id: uid, name: u.name, genre: u.genre, desc, manual: true });
      if (!shiftBars.length) {
        if (u.tasks.length) manualRow(`時間指定タスクのみ（本体シフト無し）→手動`);
        continue;
      }
      if (shiftBars.length > 1) { manualRow(`原案に本体バーが複数（分割勤務）→手動`); continue; }
      if (!genreId) { manualRow(`区分${u.genre}は自動対象外→手動`); continue; }
      const s = shiftBars[0].s, e = shiftBars[0].e;
      const rests = shiftBars[0].rests || [];
      // 時間指定タスク: 本体スパンと完全一致する単一タスクだけ store_task_ids で付ける
      const fullTaskIds = [];
      let partialTasks = 0;
      for (const t of u.tasks) {
        const id = nameToTaskId[t.task];
        if (id && t.s === s && t.e === e) fullTaskIds.push(id);
        else partialTasks += 1;
      }
      const manualNotes = partialTasks ? [`時間指定タスク${partialTasks}件は手動`] : [];

      const existing = curByUG[curKey(uid, genreId)] || [];
      if (existing.length > 1) {
        manualRow(`${hm(s)}-${hm(e)}：この区分に既存バーが複数→手動`); continue;
      }
      const ex = existing[0];
      // 既に確定/共有/固定済みのバーには絶対に触れない（上書き事故を防ぐ）
      if (ex && (ex.is_shared || ex.is_fixed)) {
        manualRow(`${hm(s)}-${hm(e)}：既に確定/共有済み→手動（上書きしません）`); continue;
      }
      const restApi = restsToApi(rests);
      if (!ex) {
        // 新規作成
        rows.push({
          kind: 'create', user_id: uid, name: u.name, genre: u.genre,
          desc: `新規 ${hm(s)}-${hm(e)}` + (restApi.length ? `（休${rests.map((r) => hm(r[0]) + '-' + hm(r[1])).join(',')}）` : '')
            + (fullTaskIds.length ? `＋タスク${fullTaskIds.length}` : '')
            + (manualNotes.length ? `　⚠${manualNotes.join('・')}` : ''),
          payload: { schedule: {
            user_id: uid, attending_store_id: +cur.storeId, attending_genre_id: genreId,
            date: ymd(date), start_hour: Math.floor(s / 60), start_minute: s % 60,
            end_hour: Math.floor(e / 60), end_minute: e % 60,
            rest_times: restApi, shift_pattern_id: null, off: false, off_type: 0,
            memo_text: null, store_task_ids: fullTaskIds.length ? fullTaskIds : null,
            instructedScheduleStoreTasks: [], company_special_holiday_id: null,
          } },
        });
      } else if (ex.off || ex.start_as_min == null || ex.end_as_min == null) {
        // 既存が「休み」または時間なしのバー。働きに変える判断は人に委ねる（手動）
        manualRow(`${hm(s)}-${hm(e)}：既存が休み/時間未設定→手動`);
      } else {
        // 既存あり: 時間 or 休憩が違えば retime（タスクは既存を保持・触らない）
        const sameTime = ex.start_as_min === s && ex.end_as_min === e;
        const sameRest = restEq(apiRestToMin(ex.rest_times).sort(), rests.map((r) => [r[0], r[1]]).sort());
        if (sameTime && sameRest) continue;   // 一致は出さない
        rows.push({
          kind: 'retime', user_id: uid, name: u.name, genre: u.genre,
          desc: `変更 ${hm(ex.start_as_min)}-${hm(ex.end_as_min)} → ${hm(s)}-${hm(e)}`
            + (sameRest ? '' : `／休憩を更新`)
            + (partialTasks ? `　⚠時間指定タスク${partialTasks}件は手動` : ''),
          bar_id: ex.id,
          payload: { schedule: {
            id: ex.id, attending_store_id: ex.attending_store_id, attending_genre_id: ex.attending_genre_id,
            start_hour: Math.floor(s / 60), start_minute: s % 60,
            end_hour: Math.floor(e / 60), end_minute: e % 60,
            rest_times: restApi, shift_pattern_id: ex.shift_pattern_id, off: ex.off,
            off_type: ex.off_type, memo_text: ex.memo_text,
            store_task_ids: ex.store_task_ids, company_special_holiday_id: ex.company_special_holiday_id,
          } },
        });
      }
    }
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    return rows;
  }

  let reflectRows = null;
  async function renderReflectPlan() {
    const el = $('#reflect');
    el.className = 'reflect';
    el.innerHTML = '<span class="muted">差分を計算中…</span>';
    try {
      reflectRows = await buildReflectPlan(targetDate);
    } catch (e) { el.innerHTML = `<span class="err">失敗: ${esc(e.message)}</span>`; return; }
    const auto = reflectRows.filter((r) => !r.manual);
    const manual = reflectRows.filter((r) => r.manual);
    if (!reflectRows.length) { el.innerHTML = '<span class="allok">✓ 原案と一致（反映する差分なし）</span>'; return; }
    const rowHtml = (r, i) => {
      const btn = r.manual ? '<span class="muted" style="font-size:11px">要手動</span>'
        : `<button class="rap" data-i="${i}">反映</button>`;
      return `<div class="rrow ${r.kind}" data-i="${i}">` +
        `<span class="rwho"><span class="dtag ${esc(r.genre || '')}" style="display:inline-block;` +
        `width:20px;text-align:center;border-radius:4px;color:#fff;font-size:10px">${esc(r.genre || '?')}</span> ` +
        `${esc(r.name)}</span><span class="rwhat">${esc(r.desc)}</span>${btn}</div>`;
    };
    el.innerHTML =
      `<div class="rf-warn">確定送信はしません。反映は1行ずつご確認のうえ「反映」を押してください` +
      `（削除・確定は行いません）。${rfCsrf() ? '' : '<b>⚠CSRFトークン未検出：このページをリロードしてください</b>'}</div>` +
      `<div class="rsum">反映できる差分 ${auto.length}件${manual.length ? ` ／ 要手動 ${manual.length}件` : ''}</div>` +
      (auto.length ? `<div style="margin:2px 0"><button id="reflectAll" title="上から順に1件ずつ反映（各件の成否を表示）">▶ ${auto.length}件を順に反映</button></div>` : '') +
      reflectRows.map(rowHtml).join('');
  }

  // 1行を実際にPOST/PUTする。成功でDOMに✓、失敗で赤表示。確定には触れない。
  async function applyReflectRow(i) {
    const r = reflectRows && reflectRows[i];
    if (!r || r.manual) return false;
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return false; }
    const rowEl = $(`#reflect .rrow[data-i="${i}"]`);
    const btn = rowEl && rowEl.querySelector('.rap');
    if (btn) { btn.disabled = true; btn.textContent = '送信中'; }
    const url = r.kind === 'create' ? '/ajax/admin/schedules' : `/ajax/admin/schedules/${r.bar_id}`;
    const method = r.kind === 'create' ? 'POST' : 'PUT';
    try {
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
        body: JSON.stringify(r.payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (rowEl) { rowEl.classList.add('done'); rowEl.classList.remove('err'); }
      if (btn) { btn.textContent = '✓ 反映'; btn.disabled = true; }
      r.applied = true;
      // 反映後はゴースト/実数を取り直す
      renderSheet();
      return true;
    } catch (e) {
      if (rowEl) rowEl.classList.add('err');
      if (btn) { btn.textContent = '再試行'; btn.disabled = false; }
      const w = rowEl && rowEl.querySelector('.rwhat');
      if (w) w.textContent += `　→ 失敗: ${e.message}`;
      return false;
    }
  }

  // 対象日のCK割付プランを作る。既に付いている人はそのまま（重複して付けない）。
  async function buildCkPlan(date) {
    const cur = await fetchInstructedRaw(date);
    const nameOf = {};
    // users は schedules レスポンスに入るが fetchInstructedRaw は instructed だけ返すので、
    // 行の名前はシフト表DOMではなくAPIから引き直す（別途取得）。
    const bars = cur.list.filter((s) => !s.off && s.start_as_min != null && s.end_as_min != null
      && (s.attending_genre_id === 2 || s.attending_genre_id === 3));
    // 実働（休憩控除）。長い順の判定に使う
    const netLen = (s) => {
      let L = s.end_as_min - s.start_as_min;
      for (const r of (s.rest_times || [])) {
        L -= Math.max(0, (r.end_hour * 60 + r.end_minute) - (r.start_hour * 60 + r.start_minute));
      }
      return L;
    };
    const si = new Set(SOCIAL_INSURANCE.map((n) => String(n).replace(/\s+/g, '')));
    const isSI = (s) => si.has((nameOf[s.user_id] || '').replace(/\s+/g, ''));
    // 並び: 社保加入 → 実働が長い → 早出
    const rank = (pool) => [...pool].sort((a, b) =>
      (isSI(b) - isSI(a)) || (netLen(b) - netLen(a)) || (a.start_as_min - b.start_as_min));
    const hasTag = (s, id) => (s.store_task_ids || []).includes(id);
    const F = bars.filter((s) => s.attending_genre_id === 2);
    const K = bars.filter((s) => s.attending_genre_id === 3);
    const amOf = (a) => a.filter((s) => s.start_as_min < NOON);
    const pmOf = (a) => a.filter((s) => s.end_as_min > NOON);
    const plan = [];
    const pick = (pool, used) => rank(pool).find((s) => !used.has(s.user_id)) || null;
    const add = (label, s, task) => {
      if (!s) { plan.push({ label, task, missing: true }); return; }
      plan.push({ label, task, bar: s, already: hasTag(s, CK_TASK[task]) });
    };
    // フロア: 午前1名・午後1名に温度（別人）
    const uF = new Set();
    const f1 = pick(amOf(F), uF); if (f1) uF.add(f1.user_id);
    add('F 温度(午前)', f1, '温度');
    const f2 = pick(pmOf(F), uF); if (f2) uF.add(f2.user_id);
    add('F 温度(午後)', f2, '温度');
    // キッチン: 午前温度 → 廃棄(ラスト=最も遅く終わる人) → 午後温度 → 日付（全員別人）
    const uK = new Set();
    const k1 = pick(amOf(K), uK); if (k1) uK.add(k1.user_id);
    add('K 温度(午前)', k1, '温度');
    const kpm = pmOf(K);
    const last = [...kpm].sort((a, b) => b.end_as_min - a.end_as_min)
      .find((s) => !uK.has(s.user_id)) || null;
    if (last) uK.add(last.user_id);
    add('K 廃棄(ラスト)', last, '廃棄');
    const k2 = pick(kpm, uK); if (k2) uK.add(k2.user_id);
    add('K 温度(午後)', k2, '温度');
    const k3 = pick(kpm, uK); if (k3) uK.add(k3.user_id);
    add('K 日付(午後)', k3, '日付');
    return { plan, nameOf, storeId: cur.storeId };
  }

  let ckRows = null;
  async function renderCkPlan() {
    const el = $('#reflect');
    el.className = 'reflect';
    el.innerHTML = '<span class="muted">CK割付を計算中…</span>';
    let res;
    try {
      // 名前は schedules の users から引く（fetchInstructedRawは instructed のみ返すため）
      const p = new URLSearchParams(location.search);
      const q = new URLSearchParams();
      q.set('page_ctx_name', 'admin'); q.set('store_id', p.get('s'));
      for (const g of (p.getAll('g').length ? p.getAll('g') : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
      q.set('start_date', ymd(targetDate)); q.set('end_date', ymd(targetDate));
      q.set('is_staff_print_page', 'false');
      const [uRes, built] = await Promise.all([
        fetch('/ajax/admin/v2/schedules?' + q, { credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json()),
        buildCkPlan(targetDate),
      ]);
      for (const u of (uRes.users || [])) built.nameOf[u.id] = (u.name || '').replace(/\s+/g, ' ').trim();
      res = built;
    } catch (e) { el.innerHTML = `<span class="err">失敗: ${esc(e.message)}</span>`; return; }
    ckRows = res.plan;
    const todo = ckRows.filter((r) => r.bar && !r.already);
    const rowHtml = (r, i) => {
      if (r.missing) return `<div class="rrow manual"><span class="rwho">${esc(r.label)}</span>` +
        `<span class="rwhat">該当者なし（この日はその区分/時間帯に勤務者がいません）</span></div>`;
      const who = res.nameOf[r.bar.user_id] || r.bar.user_id;
      const when = `${hm(r.bar.start_as_min)}-${hm(r.bar.end_as_min)}`;
      if (r.already) return `<div class="rrow done"><span class="rwho">${esc(r.label)}</span>` +
        `<span class="rwhat">${esc(who)} ${when} … 既に付与済み</span></div>`;
      return `<div class="rrow create" data-i="${i}"><span class="rwho">${esc(r.label)}</span>` +
        `<span class="rwhat">${esc(who)} ${when} に「${esc(r.task)}」を付与</span>` +
        `<button class="ckap" data-i="${i}">付与</button></div>`;
    };
    el.innerHTML =
      '<div class="rf-warn">CKは<b>シフト全域タグ</b>（store_task_ids）として付けます。' +
      '勤務時間・休憩は変更しません。既存のタグは消しません。確定送信もしません。' +
      (SOCIAL_INSURANCE.length ? '' : '<br><b>※社会保険加入者リストが未設定のため、勤務時間の長い順のみで選んでいます。</b>') +
      '</div>' +
      `<div class="rsum">付与する ${todo.length}件</div>` +
      (todo.length ? `<div style="margin:2px 0"><button id="ckAll">▶ ${todo.length}件をまとめて付与</button></div>` : '') +
      ckRows.map(rowHtml).join('');
  }

  // 1件付与: 既存 store_task_ids にCKのidを足して PUT（時間は既存のまま送る）
  async function applyCkRow(i) {
    const r = ckRows && ckRows[i];
    if (!r || !r.bar || r.already) return false;
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return false; }
    const rowEl = $(`#reflect .rrow[data-i="${i}"]`);
    const btn = rowEl && rowEl.querySelector('.ckap');
    if (btn) { btn.disabled = true; btn.textContent = '送信中'; }
    const ex = r.bar;
    const ids = Array.from(new Set([...(ex.store_task_ids || []), CK_TASK[r.task]]));
    const payload = { schedule: {
      id: ex.id, attending_store_id: ex.attending_store_id, attending_genre_id: ex.attending_genre_id,
      start_hour: Math.floor(ex.start_as_min / 60), start_minute: ex.start_as_min % 60,
      end_hour: Math.floor(ex.end_as_min / 60), end_minute: ex.end_as_min % 60,
      rest_times: (ex.rest_times || []), shift_pattern_id: ex.shift_pattern_id,
      off: ex.off, off_type: ex.off_type, memo_text: ex.memo_text,
      store_task_ids: ids, company_special_holiday_id: ex.company_special_holiday_id,
    } };
    try {
      const res = await fetch(`/ajax/admin/schedules/${ex.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r.already = true;
      if (rowEl) rowEl.classList.add('done');
      if (btn) { btn.textContent = '✓ 付与'; btn.disabled = true; }
      renderSheet();
      return true;
    } catch (e) {
      if (rowEl) rowEl.classList.add('err');
      if (btn) { btn.textContent = '再試行'; btn.disabled = false; }
      const w = rowEl && rowEl.querySelector('.rwhat');
      if (w) w.textContent += `　→ 失敗: ${e.message}`;
      return false;
    }
  }

  // ===== らくしふ各人の行に、その人のShiftDraft原案を薄いバーで重ねる =====
  // 目的: らくしふの確定ライン（.schedule-bar）の下に「海賊版らくしふで描いた場合のシフト」を
  //       薄く出し、確定作業の下敷きにする。休憩は描かない（本人指定）。
  // DOM実測(2026-07-22 OneDay):
  //   行 = tr.user-cell-container.table-body-row、行内に data-user-id を持つ要素あり。
  //   横の配置基準 = .schedule-row(position:relative・left=6:00原点/1px=1分)。出勤行・休み行の
  //   両方に存在する（.schedule-bar-wrapper は出勤行にしか無いので使わない＝原案あり・らくしふ
  //   休みの人＝一番見たいケースを取りこぼす。実測で確認済み）。
  //   ゴースト style.left=(開始分-360)px / width=(分数)px。確定バーと同じ式（谷本300px=本体300pxで一致確認）。
  //   縦位置は【必ず実測】で「確定バー→希望 の下」に置く。固定pxは禁物:
  //     行高・バー高がビューで変わる（谷本 8/1=行高68/確定h32 、7/25=98/60 と別物）。
  //     以前は固定70pxが .schedule-row 基準で行外(row-rel72>行高68)に落ち、ゴーストが1行下＝
  //     隣の人の位置に出て「整合性が取れていない」状態になっていた。
  //     希望(.isDesired)の下に余白があるので、希望は動かさず、その直下へ置く。
  // 原案ゴーストの色（本人指定 2026-07-22）。原案データ(draft-day)のgenreは F/K/FK のみ。
  // トレーニング/クルー固定業務=黄・マネジメント=黒 も指定されたが、原案データにその区分が
  // 無いため現状は出せない（TR/固定/MGTのキーは用意だけしておく＝データが持てば自動で反映）。
  const GHOST_GEN_COLOR = {
    F: '#2563eb',   // フロア=青
    K: '#2e9e5b',   // キッチン=緑
    FK: '#7c3aed',  // FK=紫
    TR: '#eab308',  // トレーニング=黄（※原案データに未収録）
    FIX: '#eab308', // クルー固定業務=黄（※同上）
    MGT: '#111827', // マネジメント=黒（※同上）
  };
  let lastDraftDay = null;  // {iso, byUser: Map<user_id,[seg,...]>, sig}

  // 変化検知用の軽い署名（順不同で安定するようソート）。海賊版で原案を直したら値が変わる。
  const draftSig = (list) => list
    .map((a) => `${a.user_id}:${a.s}-${a.e}:${a.genre}:${a.rest ? a.rest.join('-') : ''}`)
    .sort().join('|');

  async function fetchDraftDay(iso) {
    const r = await draftApi('/api/draft-day?date=' + iso);
    const list = (r && r.ok && r.data && Array.isArray(r.data.assignments)) ? r.data.assignments : [];
    const byUser = new Map();
    for (const a of list) {
      if (a.s == null || a.e == null) continue;
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
      byUser.get(a.user_id).push(a);
    }
    return { byUser, sig: draftSig(list) };
  }

  async function loadDraftDay(iso) {
    if (lastDraftDay && lastDraftDay.iso === iso) return lastDraftDay.byUser;
    const { byUser, sig } = await fetchDraftDay(iso);
    lastDraftDay = { iso, byUser, sig };
    return byUser;
  }

  // 海賊版の編集に自動追従: 定期的に取り直し、中身が変わっていたら描き直す（変化なしは何もしない）。
  // 表示中タブのOneDayのときだけ。ShiftDraftはTailscaleローカルなので短間隔でも軽い。
  async function pollDraftDay() {
    if (isPrintPage || !onOneDayTarget()) return;
    if (document.visibilityState !== 'visible') return;
    const iso = ymd(targetDate);
    const { byUser, sig } = await fetchDraftDay(iso);
    if (lastDraftDay && lastDraftDay.iso === iso && lastDraftDay.sig === sig) return; // 変化なし
    lastDraftDay = { iso, byUser, sig };
    updateDraftGhosts().catch(() => {});
  }

  async function updateDraftGhosts() {
    document.querySelectorAll('.rf-draft-ghost').forEach((e) => e.remove());
    if (isPrintPage || !onOneDayTarget()) return;
    const byUser = await loadDraftDay(ymd(targetDate));
    if (!byUser || !byUser.size) return;
    const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    for (const tr of document.querySelectorAll('tr.user-cell-container.table-body-row')) {
      const idEl = tr.querySelector('[data-user-id]');
      if (!idEl) continue;
      const segs = byUser.get(Number(idEl.getAttribute('data-user-id')));
      if (!segs || !segs.length) continue;
      const track = tr.querySelector('.schedule-row');
      if (!track) continue;
      const main = tr.querySelector('.schedule-bar.isEditable, .schedule-bar.isShared');
      // 縦位置=確定バーのすぐ下（実測）。経緯:
      //  ・top:0固定(v1.42)は確定バーの真上に重なり、バーの背面で見えなくなった（本人「消えてる」）。
      //  ・(希望||確定)下端に合わせる旧実装は、希望の有無で人ごとに高さが変わりバラついた。
      //  確定バーの下端は「バーの高さ」で決まりタスク(バー内に描かれる)や希望に影響されない＝安定。
      //  タスクはバー内・希望はさらに下なので、バー直下は常に空きスペースで見やすい。
      //  休みの人(バー無し)は重なる相手がいないのでトラック上部に出す。
      const trackTop = track.getBoundingClientRect().top;
      const topPx = main
        ? Math.round(main.getBoundingClientRect().bottom - trackTop + 1)
        : 2;
      for (const a of segs) {
        const color = GHOST_GEN_COLOR[a.genre] || '#888';
        const restTxt = (Array.isArray(a.rest) && a.rest.length === 2)
          ? `　休 ${hm(a.rest[0])}-${hm(a.rest[1])}` : '';
        const title = `原案(ShiftDraft) ${a.name || ''} ${hm(a.s)}-${hm(a.e)}${restTxt}`
          + (main ? '' : '（らくしふは休み）');
        const bar = (l, r) => {
          if (r <= l) return;
          const g = document.createElement('div');
          g.className = 'rf-draft-ghost';
          g.style.cssText =
            `position:absolute;left:${l - 360}px;width:${r - l}px;top:${topPx}px;` +
            `height:5px;border-radius:3px;background:${color};` +
            'opacity:.55;pointer-events:none;z-index:3;';
          g.title = title;
          track.appendChild(g);
        };
        // 休憩は帯を切って隙間にする（本人指定「休憩は空でいい」＝塗らずに空ける）。
        // rest=[開始,終了]分。区間を [s,rest0] と [rest1,e] に分けて描く。
        // 不正値対策で s..e にクランプし、はみ出す/潰れる区間は bar() 側で捨てる。
        if (Array.isArray(a.rest) && a.rest.length === 2) {
          const rs = Math.max(a.s, Math.min(a.rest[0], a.e));
          const re = Math.max(a.s, Math.min(a.rest[1], a.e));
          if (re > rs) { bar(a.s, rs); bar(re, a.e); } else { bar(a.s, a.e); }
        } else {
          bar(a.s, a.e);
        }
      }
    }
  }

  // 注入がセクション単位で欠けていないかを見る。
  // 経緯(2026-07-22): 以前は「.rf-le-row が1つでもあれば張り直さない」判定だったため、
  // フロアにだけ入った状態でキッチンが後から描画されると永久に埋まらなかった
  // （らくしふはセクションを遅延描画する。実機のキッチンでLE客数・必要行が出ない不具合）。
  // 対象セクションの数と実際の注入数を突き合わせて、欠けていれば張り直す。
  const targetSections = (sel, pick) =>
    [...document.querySelectorAll(sel)].filter((e) => sectionCatOf(pick ? pick(e) : e));
  const leRowsIntact = () => {
    if (isPrintPage) return !!document.querySelector('.rf-le-row-p');
    const secs = targetSections('th.metrics-row-header', (th) => th.closest('tr') || th)
      .filter((th) => (th.textContent || '').includes('修正客数'));
    if (!secs.length) return true;   // まだ描画されていない＝張り直しても入れる先がない
    return document.querySelectorAll('.rf-le-row').length >= secs.length;
  };
  const stripsIntact = () => {
    const heads = targetSections('.time-header');
    if (!heads.length) return true;
    return heads.every((h) => h.nextElementSibling
      && h.nextElementSibling.classList.contains('rf-heat-strip'));
  };

  // URL変化 (日付移動・ビュー切替) を監視してパネルの対象日を追従
  // 各張り直しは互いに独立。1つが例外を投げても他を巻き添えにしないよう個別に隔離する。
  // （経緯: 上流の張り直しが投げると、後段の updateReqButtons＝名前横の「＋」依頼ボタンが
  //  毎ティック張り直されず、らくしふ再描画で消えたきり戻らない不具合になっていた）
  const guarded = (label, fn) => { try { fn(); } catch (e) { console.warn(`[rf] ${label}`, e); } };
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    // ＋ボタンは最優先で張り直す（他が壊れても依頼起票の導線は絶やさない）
    guarded('reqButtons', updateReqButtons);
    // Vueの再描画でバッジ/バー/LE行/依頼マークが消えた場合の張り直し（軽量）
    guarded('weekBadges', () => { if (lastWeekStats) updateWeekBadges(lastWeekStats); });
    guarded('strips', () => { if (lastStrip && !stripsIntact()) updateStrips(lastStrip.catDiffs, lastStrip.tip, lastStrip.catActs, lastStrip.basisName); });
    guarded('leRows', () => { if (lastLE && !leRowsIntact()) updateLERows(lastLE.le, lastLE.reqPack, lastLE.act); });
    guarded('shiftMarks', () => { if (scState && !document.querySelector('.rf-sc-mark')) updateShiftMarks(); });
    guarded('reqLines', () => { if (scState && !document.querySelector('.rf-req-line')) updateReqLines(); });
    // 原案ゴースト: 対象日に原案があるのに消えていたら張り直す
    if (lastDraftDay && lastDraftDay.byUser && lastDraftDay.byUser.size &&
        onOneDayTarget() && !document.querySelector('.rf-draft-ghost')) {
      updateDraftGhosts().catch(() => {});
    }
    if (location.href === lastHref) return;
    lastHref = location.href;
    const d = parseYmd(urlParams().from || '');
    if (d && ymd(d) !== ymd(targetDate)) {
      targetDate = d;
      renderSheet();
      scRenderList();      // 「この日」フィルタと依頼マークを新しい日付へ追従
      updateShiftMarks();
      updateReqLines();
    }
  }, URL_WATCH_MS));

  // 海賊版(ShiftDraft)の原案編集に自動追従する定期ポーリング（変化時のみ描き直し）
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    pollDraftDay().catch(() => {});
  }, DRAFT_POLL_MS));

  // 過去のチェック機能(v1.5.x)が残したlocalStorageキーを掃除
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('rfDone:')) localStorage.removeItem(k);
  }
  // 実行中バージョンを常時表示（更新ボタンが出ない=最新、の判断材料）
  try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch { /* context失効時 */ }

  // 希望送信の対象月: 前月〜3ヶ月先。原案作成は翌月分が通常なので翌月を既定にする
  {
    const sel = $('#draftMonth'), now = new Date();
    for (let d = -1; d <= 3; d++) {
      const dt = new Date(now.getFullYear(), now.getMonth() + d, 1);
      const v = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
      const o = document.createElement('option');
      o.value = v; o.textContent = v; o.selected = (d === 1);
      sel.appendChild(o);
    }
  }
  $('#draftSend').addEventListener('click', sendWishes);
  $('#reflectPlan').addEventListener('click', renderReflectPlan);
  // 反映セクションのクリック（差分1件 or 一括）。確定には触れない。
  $('#ckPlan').addEventListener('click', renderCkPlan);
  $('#reflect').addEventListener('click', async (ev) => {
    const ck = ev.target.closest('.ckap');
    if (ck) { await applyCkRow(+ck.dataset.i); return; }
    if (ev.target.id === 'ckAll') {
      ev.target.disabled = true;
      const targets = (ckRows || []).map((r, i) => ({ r, i })).filter((x) => x.r.bar && !x.r.already);
      for (const { i } of targets) { await applyCkRow(i); }
      ev.target.textContent = '完了';
      return;
    }
    const one = ev.target.closest('.rap');
    if (one) { await applyReflectRow(+one.dataset.i); return; }
    if (ev.target.id === 'reflectAll') {
      ev.target.disabled = true;
      const targets = (reflectRows || [])
        .map((r, i) => ({ r, i })).filter((x) => !x.r.manual && !x.r.applied);
      for (const { i } of targets) { await applyReflectRow(i); }   // 1件ずつ順に
      ev.target.textContent = '完了';
    }
  });
  renderSheet();
  renderUnconfirmed();
  scRefresh(); // バッジ表示のためダイアログ閉でも件数を取る
  updateReqButtons();
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    renderUnconfirmed();
    scRefresh();
  }, CONFIRM_POLL_MS));
  // 定期更新（画面上のヒートバーはパネルの開閉に関係なく維持する）
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    renderSheet();
  }, 2 * 60 * 1000));
})();
