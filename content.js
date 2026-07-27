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
      /* ===== E系 設計トークン（案E＝ミニマル/細ゴシック を原点）===== */
      :host {
        all: initial;
        --paper:#fbfbfa; --panel:#ffffff; --ink:#161616; --ink2:#474743; --faint:#8c8c88;
        --line:#eae9e5; --line2:#d9d8d2;
        --accent:#d3402a;                 /* 赤：主アクション・強調 一点 */
        --neg:#bd3a2c; --pos:#3f7a57; --warn:#a97016; --mut:#8c8c88;
        --tintneg:#faeae7; --tintwarn:#f7efe1; --tintpos:#eef5f0;
      }
      * { box-sizing: border-box;
        font-family: "Hiragino Sans", "Helvetica Neue", "Yu Gothic", "YuGothic", -apple-system, sans-serif;
        font-weight: 400; letter-spacing: .004em; }
      .num, .num * { font-variant-numeric: tabular-nums; }
      @media print { #toggle, #panel { display: none !important; } }
      /* ---- トグル（四角・角丸なし・SVGアイコン・選択中は赤下線）---- */
      #toggle, #shiftToggle, #reflectToggle {
        position: fixed; top: 12px; z-index: 2147483646;
        width: 42px; height: 42px; border-radius: 0; cursor: pointer;
        border: 1px solid var(--line2); background: var(--panel); color: var(--ink2);
        display: grid; place-items: center; padding: 0;
      }
      #toggle { right: 12px; } #shiftToggle { right: 60px; } #reflectToggle { right: 108px; }
      #toggle:hover, #shiftToggle:hover, #reflectToggle:hover { color: var(--ink); border-color: var(--ink); }
      #toggle.on, #shiftToggle.on, #reflectToggle.on { color: var(--ink); border-color: var(--ink);
        box-shadow: inset 0 -2px 0 var(--accent); }
      #toggle svg, #shiftToggle svg, #reflectToggle svg {
        width: 19px; height: 19px; stroke: currentColor; fill: none; stroke-width: 1.4;
        stroke-linecap: round; stroke-linejoin: round; }
      #toggle .badge, #shiftToggle .badge {
        position: absolute; top: -8px; right: -8px; min-width: 17px; height: 17px;
        border-radius: 0; background: var(--accent); color: #fff; font-size: 10px; font-weight: 700;
        line-height: 17px; padding: 0 4px; display: none;
      }
      /* 更新ボタン：更新が来ていたら常に画面上部に出す（トグルの左隣・赤で目立たせる） */
      #rfUpdate {
        position: fixed; top: 12px; right: 158px; z-index: 2147483646; height: 42px;
        border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 0;
        cursor: pointer; padding: 0 14px; font-size: 12.5px; font-weight: 600; letter-spacing: .01em;
        box-shadow: 0 2px 10px rgba(211,64,42,.35); white-space: nowrap;
      }
      #rfUpdate:hover { filter: brightness(1.07); }
      @media print { #reflectToggle, #reflectPanel, #rfUpdate { display: none !important; } }
      #reflectPanel {
        position: fixed; right: 12px; top: 62px; z-index: 2147483647;
        width: 468px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 78px); overflow-y: auto;
        background: var(--panel); border: 1px solid var(--line2); border-radius: 0;
        box-shadow: 0 8px 30px rgba(20,20,18,.12); padding: 0 16px 14px; display: none;
        font-size: 13px; color: var(--ink);
      }
      #reflectPanel.open { display: block; }
      #reflectPanel .rp-head { display: flex; align-items: baseline; gap: 12px;
        border-bottom: 2px solid var(--ink); padding: 15px 0 10px; margin-bottom: 4px;
        position: sticky; top: 0; background: var(--panel); z-index: 1; }
      #reflectPanel .rp-head b { font-size: 16px; font-weight: 600; color: var(--ink); white-space: nowrap; }
      #reflectPanel .rp-head .muted { color: var(--faint); }
      #rfCapBox { border: 0; border-left: 2px solid var(--accent); background: transparent; border-radius: 0;
        padding: 4px 0 4px 9px; margin-bottom: 8px; }
      #shiftPanel {
        position: fixed; right: 60px; top: 62px; z-index: 2147483647;
        width: 490px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 78px); overflow-y: auto;
        background: var(--panel); border: 1px solid var(--line2); border-radius: 0;
        box-shadow: 0 8px 30px rgba(20,20,18,.12); padding: 14px 16px; display: none;
        font-size: 13px; color: var(--ink);
      }
      #shiftPanel.open { display: block; }
      .sc-head { display: flex; gap: 7px; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap;
        border-bottom: 2px solid var(--ink); padding-bottom: 10px; }
      .sc-head b { flex: 1 0 auto; font-size: 16px; font-weight: 600; white-space: nowrap; }
      #scDetectBox { border: 0; border-left: 2px solid var(--warn); background: transparent; border-radius: 0;
        padding: 4px 0 4px 9px; margin-bottom: 10px; font-size: 12px; }
      .sc-detect-head { font-weight: 600; margin-bottom: 4px; }
      #scDraftAll { font-size: 11px; font-weight: 600; padding: 3px 12px; border-radius: 0;
        border: 1px solid var(--ink); background: var(--ink); color: var(--panel); cursor: pointer; }
      .sc-drow { display: flex; align-items: baseline; gap: 8px; padding: 6px 0;
        border-top: 1px solid var(--line); }
      .sc-drow .sc-dwho { flex: 0 0 auto; font-weight: 500; min-width: 76px; }
      .sc-drow .sc-dwhat { flex: 1 1 auto; color: var(--ink2); }
      .sc-drow.dup { opacity: .5; }
      .sc-drow.err .sc-dwhat { color: var(--neg); }
      .sc-draft { flex: 0 0 auto; font-size: 12px; font-weight: 600; padding: 1px 2px; border-radius: 0;
        border: 0; background: none; color: var(--accent); cursor: pointer; }
      .sc-draft[disabled] { color: var(--faint); cursor: default; }
      .sc-head button {
        border: 1px solid var(--line2); background: var(--panel); border-radius: 0;
        cursor: pointer; padding: 4px 10px; font-size: 12px; color: var(--ink);
      }
      .sc-head button:hover { border-color: var(--ink); }
      .sc-head button.on { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 600; }
      .sc-card { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 11px 0; margin-bottom: 0; }
      .sc-card.done { opacity: .5; }
      .sc-title { font-weight: 600; font-size: 14px; }
      .sc-title .undone { color: var(--neg); font-weight: 600; }
      .sc-meta { color: var(--faint); font-size: 12px; font-weight: 400; }
      .sc-checks { display: flex; flex-wrap: wrap; gap: 5px 16px; margin: 8px 0; }
      .sc-checks label { font-size: 12.5px; display: flex; gap: 6px; align-items: center; cursor: pointer; color: var(--ink2); }
      .sc-checks input { width: 14px; height: 14px; accent-color: var(--accent); }
      .sc-notes { color: var(--faint); font-size: 12px; margin: 3px 0; }
      .sc-note-input { display: flex; gap: 5px; margin-top: 5px; }
      .sc-note-input input { flex: 1; border: 1px solid var(--line2); border-radius: 0; padding: 4px 8px; font-size: 13px; background: var(--panel); color: var(--ink); }
      .sc-note-input button, #scNewForm button {
        border: 1px solid var(--line2); background: var(--panel); border-radius: 0; cursor: pointer;
        padding: 3px 11px; font-size: 12.5px; color: var(--ink);
      }
      .sc-del-btn, .sc-rej-btn, .sc-edit-btn { float: right; border: none; background: none; cursor: pointer; font-size: 12px; opacity: .5; padding: 0 2px; }
      .sc-del-btn:hover, .sc-rej-btn:hover, .sc-edit-btn:hover { opacity: 1; }
      .sc-edit-form { border: 0; border-left: 2px solid var(--line2); border-radius: 0; padding: 4px 0 4px 10px; margin: 6px 0; }
      .sc-edit-form input { width: 100%; border: 1px solid var(--line2); border-radius: 0; padding: 4px 8px; font-size: 13px; margin-bottom: 5px; box-sizing: border-box; background: var(--panel); color: var(--ink); }
      .sc-edit-form .sc-edit-do { border: 1px solid var(--ink); background: var(--ink); color: var(--panel); border-radius: 0; cursor: pointer; padding: 3px 11px; font-size: 12.5px; }
      .sc-edit-form .sc-edit-cancel { border: 1px solid var(--line2); background: var(--panel); border-radius: 0; cursor: pointer; padding: 3px 11px; font-size: 12.5px; color: var(--ink); }
      .sc-reqtime { font-size: 12.5px; color: var(--ink2); margin-bottom: 5px; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
      #scNewForm select.rf-tsel, .sc-edit-form select.rf-tsel { width: auto !important; min-width: 44px; padding: 3px 4px; font-size: 13px; border: 1px solid var(--line2); border-radius: 0; margin: 0; background: var(--panel); color: var(--ink); }
      .sc-unrej-btn { float: right; border: 1px solid var(--line2); background: var(--panel); border-radius: 0; cursor: pointer; font-size: 11px; padding: 1px 7px; color: var(--ink); }
      .sc-title .rejected { color: var(--mut); }
      .sc-title .sc-nodate { font-size: 10px; font-weight: 700; color: var(--warn); background: transparent;
        border: 1px solid var(--warn); border-radius: 0; padding: 1px 4px; white-space: nowrap; }
      .sc-rej-form, .sc-del-form { display: flex; gap: 5px; margin-top: 5px; }
      .sc-rej-form input, .sc-del-form input { flex: 1; border: 1px solid var(--line2); border-radius: 0; padding: 4px 8px; font-size: 13px; background: var(--panel); color: var(--ink); }
      .sc-rej-form .sc-rej-do { border: 1px solid var(--mut); background: var(--mut); color: #fff; border-radius: 0; cursor: pointer; padding: 3px 11px; font-size: 12.5px; }
      .sc-del-form .sc-del-do { border: 1px solid var(--neg); background: var(--neg); color: #fff; border-radius: 0; cursor: pointer; padding: 3px 11px; font-size: 12.5px; }
      .sc-rej-form .sc-rej-cancel, .sc-del-form .sc-del-cancel { border: 1px solid var(--line2); background: var(--panel); border-radius: 0; cursor: pointer; padding: 3px 11px; font-size: 12.5px; color: var(--ink); }
      #scNewForm { border: 0; border-left: 2px solid var(--line2); border-radius: 0; padding: 4px 0 6px 10px; margin-bottom: 10px; }
      #scNewForm input, #scNewForm select {
        width: 100%; border: 1px solid var(--line2); border-radius: 0; padding: 4px 8px;
        font-size: 13px; margin-bottom: 5px; background: var(--panel); color: var(--ink);
      }
      @media print { #shiftToggle, #shiftPanel { display: none !important; } }
      #panel {
        position: fixed; right: 12px; top: 62px; z-index: 2147483646;
        width: 680px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 78px); overflow-y: auto;
        background: var(--panel); border: 1px solid var(--line2); border-radius: 0;
        box-shadow: 0 8px 30px rgba(20,20,18,.12); padding: 0 14px 12px; display: none;
        font-size: 13px; color: var(--ink);
      }
      #tableWrap { overflow-x: auto; }
      #panel.open { display: block; }
      .nav { display: flex; align-items: center; gap: 7px; padding: 13px 0 10px; margin-bottom: 10px;
        border-bottom: 2px solid var(--ink); position: sticky; top: 0; background: var(--panel); z-index: 1; }
      .nav b { flex: 1 0 auto; text-align: left; font-size: 16px; font-weight: 600; white-space: nowrap; }
      .nav button {
        border: 1px solid var(--line2); background: var(--panel); border-radius: 0;
        cursor: pointer; padding: 4px 11px; font-size: 12px; color: var(--ink);
      }
      .nav button:hover { border-color: var(--ink); }
      .nav button.accent { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 600; }
      .stats { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
      .chip { background: transparent; border: 1px solid var(--line); border-radius: 0; padding: 2px 8px; color: var(--ink2); }
      .chip b { color: var(--ink); font-weight: 600; }
      table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
      th, td { border: 0; border-bottom: 1px solid var(--line); padding: 3px 6px; text-align: right; font-size: 11px; white-space: nowrap; }
      th { background: transparent; color: var(--faint); font-weight: 500; font-size: 10px; }
      th.row-head, td.row-head { text-align: left; color: var(--ink2); font-weight: 600;
        position: sticky; left: 0; background: var(--panel); }
      td.now, th.now { background: var(--tintwarn); }
      tr.le td { color: var(--ink2); font-weight: 600; }
      tr.sum td { font-weight: 600; border-top: 1.5px solid var(--line2); }
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
      .section-title { font-weight: 600; margin: 14px 0 8px; font-size: 10.5px;
        letter-spacing: .14em; text-transform: uppercase; color: var(--faint);
        border-bottom: 1px solid var(--line); padding-bottom: 5px;
        display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      /* 見出し内のアクションボタン（外枠/中身/CK/希望送信/スキャン等）を1系統に統一 */
      .section-title button, .section-title a#draftOpen {
        margin-left: 2px; font-size: 11px; font-weight: 500; padding: 3px 9px; border-radius: 0;
        border: 1px solid var(--line2); background: var(--panel); color: var(--ink); cursor: pointer;
        letter-spacing: 0; text-transform: none; }
      .section-title button:hover { border-color: var(--ink); }
      /* 反映を実行する系＝未実施のアクション。赤(アクセント)で「これから押す」と分かるように */
      #reflectPlan, #taskPlan, #ckPlan, #reflectMonthScan, #taskMonthScan, #ckMonthScan, #memoLE {
        border-color: var(--accent); color: var(--accent); font-weight: 600; }
      #reflectPlan:hover, #taskPlan:hover, #ckPlan:hover, #reflectMonthScan:hover, #taskMonthScan:hover, #ckMonthScan:hover, #memoLE:hover {
        background: var(--accent); color: #fff; border-color: var(--accent); }
      .section-title a#draftOpen { border: 0; color: var(--accent); text-decoration: none; }
      .section-title #draftMonth, .section-title #reflectMonthSel {
        margin-left: 2px; font-size: 11px; font-weight: 400; padding: 2px 4px;
        border: 1px solid var(--line2); border-radius: 0; background: var(--panel); color: var(--ink); }
      /* 一括実行系＝主アクション（インク塗り） */
      #ckAll, #reflectAll, #taskAll, #rmRun, #tmRun, #ckmRun, #rangeRunAll {
        font-size: 11px; font-weight: 600; padding: 3px 12px; border-radius: 0;
        border: 1px solid var(--ink); background: var(--ink); color: var(--panel); cursor: pointer; }
      #ckAll[disabled], #reflectAll[disabled], #taskAll[disabled], #rmRun[disabled], #tmRun[disabled], #ckmRun[disabled], #rangeRunAll[disabled] {
        border-color: var(--line2); background: var(--line); color: var(--faint); }
      .rf-date { font-size: 11px; padding: 2px 4px; border: 1px solid var(--line2); border-radius: 0;
        background: var(--panel); color: var(--ink); font-family: inherit; }
      #rmAllToggle, #tmAllToggle, #ckmAllToggle {
        font-size: 11px; padding: 2px 9px; border-radius: 0; border: 1px solid var(--line2);
        background: var(--panel); color: var(--ink); cursor: pointer; }
      .nav #ver { font-size: 10px; font-weight: 400; margin-left: 4px; color: var(--faint); }
      .draft .dli { padding: 1px 0; font-size: 12px; }
      .draft .dtag { display: inline-block; width: 22px; text-align: center; border-radius: 0;
        color: #fff; font-size: 10px; font-weight: 700; margin-right: 6px; }
      .draft .dtag.F { background: #2b3f74; } .draft .dtag.K { background: #245a3a; }
      .draft .dtag.FK { background: #4a3a6b; }
      /* ---- 反映の結果リスト ---- */
      .reflect { font-size: 12.5px; }
      .reflect .rf-warn { color: var(--ink2); background: transparent; border: 0;
        border-left: 2px solid var(--accent); border-radius: 0; padding: 2px 0 2px 9px; margin-bottom: 9px; font-size: 11.5px; }
      .reflect .rsum { margin: 6px 0; font-weight: 400; color: var(--faint); font-size: 12px; }
      .reflect .rsum b { color: var(--ink); font-weight: 600; }
      .reflect .rrow { display: flex; align-items: baseline; gap: 10px; padding: 8px 0;
        border-bottom: 1px solid var(--line); }
      .reflect .rrow .rwho { flex: 0 0 auto; font-weight: 500; min-width: 96px; }
      .reflect .rrow .rwhat { flex: 1 1 auto; color: var(--faint); font-variant-numeric: tabular-nums; }
      .reflect .rrow.create .rwhat em, .reflect .rrow.retime .rwhat em, .reflect .rrow.off .rwhat em { font-style: normal; color: var(--ink); }
      .reflect .rrow.match { opacity: .75; }
      .reflect .rrow.match .rwhat { color: var(--pos); }
      .reflect .rrow.manual .rwhat { color: var(--faint); }
      .reflect .rrow.done { opacity: .55; }
      .reflect .rrow.err .rwhat { color: var(--neg); }
      /* 行アクション＝赤テキストボタン（塗らない・ミニマル） */
      .reflect .rap, .reflect .ckap, .reflect .tap {
        flex: 0 0 auto; font-size: 12px; font-weight: 600; padding: 1px 2px; border-radius: 0;
        border: 0; background: none; color: var(--accent); cursor: pointer; white-space: nowrap; }
      .reflect .rrow.off .rap { color: var(--mut); }
      .reflect .rap[disabled], .reflect .ckap[disabled], .reflect .tap[disabled] {
        color: var(--faint); cursor: default; }
      .rmday { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 12.5px; }
      .rmday .rmc { color: var(--warn); font-variant-numeric: tabular-nums; }
      .rmday.failed { border-left: 2px solid var(--neg); padding-left: 6px; }
      .rmday.failed .d, .rmday.failed .ckm-d { color: var(--neg); font-weight: 700; }
      .rm-stat { font-size: 11px; }
      .section-title.fold { cursor: pointer; user-select: none; }
      .unconfirmed { display: flex; flex-wrap: wrap; gap: 5px; }
      .unconfirmed .day {
        background: transparent; color: var(--neg); border: 1px solid var(--neg);
        border-radius: 0; padding: 2px 8px; font-variant-numeric: tabular-nums;
      }
      .allok { color: var(--pos); font-weight: 600; }
      .err { color: var(--neg); }
      .muted { color: var(--faint); font-size: 12px; }
      .tasks .task { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); align-items: flex-start; }
      .tasks .task .tid {
        flex: 0 0 auto; font-weight: 600; color: var(--ink2); font-size: 11px;
        background: transparent; border: 1px solid var(--line2); border-radius: 0; padding: 0 5px; align-self: center;
      }
      .tasks .task.ext .tid { color: var(--warn); border-color: var(--warn); background: transparent; }
      .tasks .task .tnote { color: var(--faint); font-size: 11px; }
    </style>
    <button id="toggle" title="客数予測パネル（Shift+クリックで他と併用）"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><span class="badge" id="badge"></span></button>
    <button id="shiftToggle" title="シフト変更依頼（Shift+クリックで他と併用）"><svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg><span class="badge" id="shiftBadge"></span></button>
    <button id="reflectToggle" title="海賊版らくしふ → らくしふへ反映（Shift+クリックで他と併用）"><svg viewBox="0 0 24 24"><path d="M3 6h13M3 6l3-3M3 6l3 3M21 18H8M21 18l-3-3M21 18l-3 3"/></svg></button>
    <button id="rfUpdate" style="display:none"></button>
    <div id="shiftPanel">
      <div class="sc-head">
        <b>シフト変更依頼</b>
        <button id="scFilterOpen" class="on">未完了</button>
        <button id="scFilterDay">この日</button>
        <button id="scFilterAll">すべて</button>
        <button id="scNewBtn">＋新規</button>
        <button id="scDetect" title="この日の「要確定」（未確定の指示シフト）を検出して依頼として起案する">⚠要確定</button>
        <button id="scReload">更新</button>
      </div>
      <datalist id="scNames"></datalist>
      <div id="scNewForm" style="display:none"></div>
      <div id="scDetectBox" style="display:none"></div>
      <div id="scList" class="muted">読込中…</div>
    </div>
    <div id="panel">
      <div class="nav">
        <b id="dateLabel">-</b>
        <button id="reqBasis" title="必要人数(REQ)の基準を切り替え。LE=客数から算出 / モデルWS=モデルWSの計画人数">基準: LE</button>
        <select id="wsTplSel" title="この日に適用するモデルWS型。自動=曜日割当に従う（変更はLE Makerのparams.jsonに保存＝海賊版と共通）"></select>
        <button id="reload" class="accent">更新</button>
        <span id="ver" class="muted"></span>
      </div>
      <div id="stats" class="stats"></div>
      <div id="tableWrap"></div>
      <div class="section-title fold" id="tasksTitle"><span id="taskFold">▾</span> タスク 月次/週次/要請（<span id="taskDate">-</span>）</div>
      <div id="tasks" class="tasks muted">読込中…</div>
      <div class="section-title">シフト確定 未処理日（今日〜月末）</div>
      <div id="unconfirmed" class="unconfirmed muted">確認中…</div>
    </div>
    <div id="reflectPanel">
      <div class="rp-head"><b>海賊版らくしふ → 反映</b>
        <span class="muted" style="font-size:11px">確定送信はしません／反映は1件ずつ手押し</span>
      </div>
      <div class="section-title fold" id="draftTitle"><span id="draftFold">▾</span> 希望送信・この日の原案
        <select id="draftMonth" title="送信する月（らくしふの表示月とは無関係に選べます）"></select>
        <button id="draftSend" title="選択した月の希望シフトをShiftDraftへ送る">希望送信</button>
        <a id="draftOpen" href="http://mac-mini.tail1f88ff.ts.net:8790/" target="_blank" rel="noopener">開く↗</a>
      </div>
      <div id="draft" class="draft muted">-</div>
      <div id="rfCapBox" style="display:none"></div>
      <div class="section-title" style="margin-top:6px">この日を らくしふへ反映
        <button id="reflectPlan" title="海賊版の原案どおりに、らくしふへシフトのラインを引く（新規作成／時間の引き直し。押した瞬間は書き込みません）">外枠を引く</button>
        <button id="ckPlan" title="温度・日付・廃棄のCKを、この日の勤務者に自動で割り付ける（シフト全域タグ。時間は変えません）">CK割付</button>
        <button id="taskPlan" title="FK/TRer/TRee/ポジションの区間タスクを原案どおり引く（そのシフトのタスクを丸ごと置換）">中身 FK/TR</button>
      </div>
      <div id="reflect" class="reflect muted">-</div>
      <div class="section-title" style="margin-top:6px">月まとめて
        <select id="reflectMonthSel" title="スキャンする月"></select>
        <button id="reflectMonthScan" title="相違のある日を抽出し、選んだ日をまとめて外枠を反映">外枠 相違日→反映</button>
        <button id="taskMonthScan" title="中身(区間タスク)に相違のある日を抽出し、選んだ日をまとめて反映">中身 相違日→反映</button>
        <button id="ckMonthScan" title="CK未付与の日を抽出し、選んだ日にまとめてCK割付">CK未付与日→割付</button>
      </div>
      <div id="reflectMonth" class="reflect muted" style="display:none">-</div>
      <div id="taskMonth" class="reflect muted" style="display:none">-</div>
      <div id="ckMonth" class="reflect muted" style="display:none">-</div>
      <div class="section-title" style="margin-top:6px">期間まとめて（外枠→CK→中身の順）</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0">
        <input type="date" id="rangeFrom" class="rf-date">
        <span style="font-size:11px;color:var(--ink2)">〜</span>
        <input type="date" id="rangeTo" class="rf-date">
        <button id="rangeRunAll" title="指定期間を、外枠→CK→中身の順にらくしふへ反映（確定送信・削除はしません）">▶ 順に反映</button>
      </div>
      <div id="rangeRun" class="reflect muted" style="display:none">-</div>
      <div class="section-title" style="margin-top:6px">店舗メモ</div>
      <div style="margin:2px 0"><button id="memoLE" title="次の1週間で店舗メモが空の日に、LE客数の予測を【修正客数】###として入れる（既存メモがある日は触りません）">LE客数を店舗メモへ（次1週間・空の日）</button></div>
      <div id="memoRun" class="reflect muted" style="display:none">-</div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('#panel'), badge = $('#badge');

  let targetDate = parseYmd(urlParams().from || '') || new Date();
  let lastHref = location.href;

  const reflectPanel = $('#reflectPanel');
  // 3つのパネル(📊/🔁/🔀)を右端から順に並べて重ならないようにする。
  // どれも右寄せ＝左のシフト表を隠さない（左に出て邪魔という指摘対応）。
  function repositionShiftPanel() {
    const gap = 8;
    let right = 12;
    // 右から: 📊 → 🔁 → 🔀 の順に、開いているものだけ左へ積む
    if (panel.classList.contains('open')) { panel.style.right = `${right}px`; right += panel.offsetWidth + gap; }
    if (shiftPanel.classList.contains('open')) { shiftPanel.style.right = `${right}px`; right += shiftPanel.offsetWidth + gap; }
    else shiftPanel.style.right = `${right}px`;   // 閉じていても次回開く位置を用意
    if (reflectPanel.classList.contains('open')) { reflectPanel.style.right = `${right}px`; }
  }

  // トグルボタンの選択中スタイル(.on)をパネルの開閉に同期する
  const syncToggle = (btnSel, isOpen) => $(btnSel).classList.toggle('on', isOpen);
  // 3パネルは既定で「どれか1つだけ表示」。Shift+クリックのときだけ他を閉じず複数表示。
  const PANELS = { '#toggle': () => panel, '#shiftToggle': () => shiftPanel, '#reflectToggle': () => reflectPanel };
  const persistPanels = () => {
    localStorage.setItem('rfPanelOpen', panel.classList.contains('open') ? '1' : '0');
    localStorage.setItem('rfShiftOpen', shiftPanel.classList.contains('open') ? '1' : '0');
    localStorage.setItem('rfReflectOpen', reflectPanel.classList.contains('open') ? '1' : '0');
    syncToggle('#toggle', panel.classList.contains('open'));
    syncToggle('#shiftToggle', shiftPanel.classList.contains('open'));
    syncToggle('#reflectToggle', reflectPanel.classList.contains('open'));
  };
  function clickTogglePanel(sel, ev) {
    const p = PANELS[sel]();
    const willOpen = !p.classList.contains('open');
    if (!ev.shiftKey) {                       // 単独表示: 他の2つを閉じる
      for (const s of Object.keys(PANELS)) { if (s !== sel) PANELS[s]().classList.remove('open'); }
    }
    p.classList.toggle('open', willOpen);
    persistPanels();
    repositionShiftPanel();
    if (sel === '#shiftToggle' && shiftPanel.classList.contains('open')) scRefresh();
  }
  $('#toggle').addEventListener('click', (ev) => clickTogglePanel('#toggle', ev));
  if (localStorage.getItem('rfPanelOpen') === '1') { panel.classList.add('open'); syncToggle('#toggle', true); }

  // 🔀 海賊版→らくしふ反映パネル（右寄せ・他パネルと重ならない）
  $('#reflectToggle').addEventListener('click', (ev) => clickTogglePanel('#reflectToggle', ev));
  if (localStorage.getItem('rfReflectOpen') === '1') { reflectPanel.classList.add('open'); syncToggle('#reflectToggle', true); }

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
  // シフト表に出ている人の名前一覧（対象者の候補。全角空白は半角に）
  const crewNames = () => {
    const set = new Set();
    for (const el of document.querySelectorAll('.user-cell .name')) {
      const n = (el.textContent || '').replace(/　/g, ' ').trim();
      if (n) set.add(n);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  };
  // 対象者ドロップダウン(datalist)の中身を今のシフト表から作り直す
  const refreshCrewDatalist = () => {
    const dl = $('#scNames');
    if (dl) dl.innerHTML = crewNames().map((n) => `<option value="${esc(n)}">`).join('');
  };
  // 「閉じた」案件＝完了 or 拒否。保留(未完了)判定・黄色線・バッジはこれで外す。
  const scClosed = (c) => c.is_done || c.is_rejected;

  // ===== 「要確定」検出 → 依頼の起案 =====
  // 要確定＝instructed(指示シフト)が is_shared=false（＝確定・共有されていない）状態。
  // らくしふ上で赤破線「要確定」で出る。これは「シフトに未確定の変更がある」＝依頼が発生、と同義（本人判断）。
  // 検出して WorkLogWeb に変更依頼として起案できるようにする。
  const g2label = (g) => (g === 2 ? 'F' : g === 3 ? 'K' : '');
  async function detectYoukakutei(date) {
    const p = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    q.set('page_ctx_name', 'admin'); q.set('store_id', p.get('s'));
    for (const g of (p.getAll('g').length ? p.getAll('g') : ['2', '3', '4', '17'])) q.append('genre_ids[]', g);
    q.set('start_date', ymd(date)); q.set('end_date', ymd(date)); q.set('is_staff_print_page', 'false');
    const r = await fetch('/ajax/admin/v2/schedules?' + q, {
      credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    if (!r.ok) throw new Error(`シフトAPI HTTP ${r.status}`);
    const j = await r.json();
    const iso = ymd(date);
    const nameOf = {};
    for (const u of (j.users || [])) nameOf[u.id] = (u.name || '').replace(/\s+/g, ' ').trim();
    const ins = (j.instructed || []).filter((s) => s.date === iso && !s.is_deleted);
    const desired = (j.desired || []).filter((s) => s.date === iso);
    const span = (s) => (s.off ? '休み' : `${hm(s.start_as_min)}-${hm(s.end_as_min)}`);
    // 要確定が「その人の元々の希望」と一致するか。一致するものだけ依頼として扱う。
    // 一致しない要確定（例: 休み希望なのに勤務で入っている＝反映漏れ由来）は無視する。
    const matchesWish = (s, des) => {
      if (!des) return false;                       // 希望が無いものは対象外（本人指定）
      if (!!des.off !== !!s.off) return false;      // 休み↔勤務の食い違いは無視
      if (des.off) return true;                     // 双方休み
      return des.start_as_min === s.start_as_min && des.end_as_min === s.end_as_min;
    };
    const rows = [];
    for (const s of ins) {
      if (s.is_shared) continue;                 // 確定・共有済み＝要確定ではない
      if (s.off) continue;                        // 休みは依頼ではない（確定漏れの休みは無視）
      const des = desired.find((x) => x.user_id === s.user_id);
      if (!matchesWish(s, des)) continue;        // 元々の希望でないもの（反映漏れ由来）は無視
      // 差分の before は「同じ人・同じ区分の確定済みバー」だけ。別区分の確定は
      // 置き換えではなく“応援などの追加”なので混同しない（岩永の例）。
      const base = ins.find((x) => x.user_id === s.user_id && x.is_shared
        && x.attending_genre_id === s.attending_genre_id) || null;
      const gl = g2label(s.attending_genre_id);
      const now = (gl ? `${gl} ` : '') + span(s);
      let change;
      if (base && (base.start_as_min !== s.start_as_min || base.end_as_min !== s.end_as_min || base.off !== s.off)) {
        change = `確定${span(base)} → ${now}（要確定）`;
      } else if (base) {
        change = `${now}（要確定・確定と同時刻）`;    // 同時刻だが未共有
      } else {
        change = `${now} を新規追加（要確定）` + (des ? ` / 希望${span(des)}` : '');
      }
      rows.push({
        bar_id: s.id, user_id: s.user_id, name: nameOf[s.user_id] || String(s.user_id),
        genre: gl, off: s.off, change,
        req_time: s.off ? '' : `${hm(s.start_as_min)}-${hm(s.end_as_min)}`,
        span: span(s),
      });
    }
    // 同じ人の複数バー（例: 応援で2本）はまとめず各行出す。名前順。
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    return rows;
  }
  // その人・その日に既に開いている依頼があるか（二重起案を防ぐ）
  const hasOpenCase = (name, date) => (scState?.cases || []).some((c) =>
    !scClosed(c) && normName(c.target) === normName(name) &&
    (scMatchesDay(c, date) || !(c.target_date || '').trim()));

  let detectRows = null;
  async function renderDetect() {
    const box = $('#scDetectBox');
    // トグル: 開いていたら閉じる
    if (box.style.display !== 'none' && box.dataset.day === ymd(targetDate)) {
      box.style.display = 'none'; return;
    }
    $('#scNewForm').style.display = 'none';
    box.style.display = ''; box.dataset.day = ymd(targetDate);
    box.innerHTML = '<span class="muted">要確定を検出中…</span>';
    try { detectRows = await detectYoukakutei(targetDate); }
    catch (e) { box.innerHTML = `<span class="err">検出失敗: ${esc(e.message)}</span>`; return; }
    const md = `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;
    if (!detectRows.length) {
      box.innerHTML = `<div class="sc-detect-head">${md} の要確定：なし ✓</div>`;
      return;
    }
    const rowHtml = (r, i) => {
      const dup = hasOpenCase(r.name, targetDate);
      const btn = dup
        ? '<span class="muted" style="font-size:11px">起案済み</span>'
        : `<button class="sc-draft" data-i="${i}">起案</button>`;
      return `<div class="sc-drow${dup ? ' dup' : ''}" data-i="${i}">` +
        `<span class="sc-dwho">${esc(r.name)}</span>` +
        `<span class="sc-dwhat">${esc(r.change)}</span>${btn}</div>`;
    };
    const todo = detectRows.filter((r) => !hasOpenCase(r.name, targetDate));
    box.innerHTML =
      `<div class="sc-detect-head">${md} の要確定 ${detectRows.length}件` +
      `（未起案 ${todo.length}件）` +
      `<button id="scDetectClose" style="float:right">閉じる</button></div>` +
      (todo.length ? `<div style="margin:3px 0"><button id="scDraftAll">▶ 未起案 ${todo.length}件を起案</button></div>` : '') +
      detectRows.map(rowHtml).join('');
  }
  // 1件を変更依頼として起案（WorkLogWeb /api/shift/create）
  async function draftFromDetect(i) {
    const r = detectRows && detectRows[i];
    if (!r) return false;
    const rowEl = $(`#scDetectBox .sc-drow[data-i="${i}"]`);
    const btn = rowEl && rowEl.querySelector('.sc-draft');
    if (btn) { btn.disabled = true; btn.textContent = '起案中'; }
    const res = await shiftApi('/api/shift/create', {
      target: r.name.replace(/\s+/g, ''),
      target_date: `${targetDate.getMonth() + 1}/${targetDate.getDate()}`,
      change: r.change, req_time: r.req_time,
      requester: r.name.replace(/\s+/g, ''),
      source: 'らくしふ要確定', memo: `らくしふの要確定から自動起案（bar_id ${r.bar_id}）`,
    });
    if (!res || !res.ok) {
      if (btn) { btn.textContent = '再試行'; btn.disabled = false; }
      if (rowEl) rowEl.classList.add('err');
      return false;
    }
    if (rowEl) rowEl.classList.add('dup');
    if (btn) btn.outerHTML = '<span class="muted" style="font-size:11px">✓ 起案</span>';
    scRefresh();   // 新しい案件をリストへ反映
    return true;
  }

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
        <input class="sc-edit-target" list="scNames" value="${esc(c.target || '')}" placeholder="対象者（選択 or 入力）">
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
      `<input id="scNewTarget" list="scNames" placeholder="対象者（選択 or 入力）">` +
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
    refreshCrewDatalist();   // 対象者の候補を今のシフト表から充填
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
    refreshCrewDatalist();
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

  $('#shiftToggle').addEventListener('click', (ev) => clickTogglePanel('#shiftToggle', ev));
  if (localStorage.getItem('rfShiftOpen') === '1') { shiftPanel.classList.add('open'); syncToggle('#shiftToggle', true); }
  repositionShiftPanel();

  $('#scReload').addEventListener('click', scRefresh);
  $('#scDetect').addEventListener('click', renderDetect);
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
    refreshCrewDatalist();               // 対象者候補を最新のシフト表から
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
    if (t.id === 'scDetectClose') { $('#scDetectBox').style.display = 'none'; return; }
    if (t.matches('.sc-draft')) { await draftFromDetect(+t.dataset.i); return; }
    if (t.id === 'scDraftAll') {
      const targets = (detectRows || []).map((r, i) => ({ r, i }))
        .filter((x) => !hasOpenCase(x.r.name, targetDate));
      // 一括で大量に起票して「面倒なことになる」のを防ぐ確認（本人指定 2026-07-26）
      if (!confirm(`${targets.length}件の依頼をまとめて起票します。よろしいですか？\n（多い場合は1件ずつ「起案」を推奨）`)) return;
      t.disabled = true;
      for (const { i } of targets) { await draftFromDetect(i); }
      t.textContent = '完了';
      return;
    }
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
      if (form.style.display === 'block') { refreshCrewDatalist(); form.querySelector('.sc-edit-change').focus(); }
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
  // 直前の .table-title の見出しで F/K を決める。完全一致だと、実セッションで見出しに
  // ツールバー文字（業務割振/シフト拡大…）が連結されると外れてキッチンが出ない不具合になる。
  // 見出しはセクション名で始まるので前方一致で判定（清掃/正社員は null＝対象外）。
  function sectionCatOf(el) {
    let sec = null;
    for (const t of document.querySelectorAll('.table-title')) {
      if (t.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        sec = (t.textContent || '').trim();
      }
    }
    if (!sec) return null;
    return sec.startsWith('フロア') ? 'F' : sec.startsWith('キッチン') ? 'K' : null;
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
    if (ev.source !== window) return;
    // タスク割当保存の採取（中身の反映を作るための一時機能）。反映パネルに出す。
    if (ev.data?.__rfCapture) {
      const c = ev.data.__rfCapture;
      // 採取をShiftDraftへ転送（Claudeがログでエンドポイントを特定できるように）。反映失敗と同じ仕組み。
      try { draftApi('/api/reflect-capture', { method: c.method, url: c.url, body: c.body, at: new Date().toISOString(), href: location.href }); } catch { /* noop */ }
      const box = $('#rfCapBox');
      if (box) {
        box.style.display = '';
        // URLも本文と一緒にコピーできるよう、テキスト欄に「METHOD URL / body」でまとめて入れる
        const dump = `${c.method} ${c.url}\n\n${c.body || ''}`;
        box.innerHTML = '<div style="font-weight:700;color:#0e7490">📥 保存通信を採取</div>' +
          '<div style="font-size:11px;margin:2px 0">下の枠を<b>全部コピー</b>して貼ってください（URLも入っています）</div>' +
          `<textarea readonly style="width:100%;height:110px;font-size:11px;box-sizing:border-box">${esc(dump)}</textarea>` +
          '<div style="margin-top:3px"><button id="rfCapCopy">📋 全部コピー</button></div>';
      }
      return;
    }
    if (ev.data?.__rfPanel !== 'dataChanged') return;
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
  // 社会保険加入者は海賊版らくしふの constraints.json（kind:"shakaiho"）が正。
  // 海賊版側で区分を変えたらそのまま追従する（拡張にはコピーを持たない）。
  // 正社員(REGULAR_STAFF)は当然加入者なので足す。
  let siCache = null;
  async function fetchSocialInsurance() {
    if (siCache) return siCache;
    const ids = new Set();
    try {
      const r = await draftApi('/data/constraints.json');
      const c = (r && r.ok) ? r.data : null;
      for (const [uid, v] of Object.entries(c || {})) {
        if ((v || {}).kind === 'shakaiho') ids.add(+uid);
      }
    } catch { /* 取れなければ社保優先なしで続行 */ }
    siCache = ids;
    return ids;
  }
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
    return { storeId, users: j.users || [],
             list: (j.instructed || []).filter((s) => s.date === ymd(date) && !s.is_deleted) };
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

  // 各原案セグメント → らくしふ区分(2/3)。F/Kはそのまま。FKは直前のF/Kライン、
  // 無ければ直後、それも無ければ mapGenre(所属/ベース)。本人指定(FKは前のラインに従う)。
  function buildGidResolver(asg, mapGenre) {
    const map = new Map();
    const byU = {};
    for (const a of asg) { if (a.e > a.s) (byU[a.user_id] ||= []).push(a); }
    for (const uid of Object.keys(byU)) {
      const segs = byU[uid].slice().sort((x, y) => x.s - y.s || x.e - y.e);
      for (const a of segs) {                       // 先にF/Kを確定
        if (a.genre === 'F') map.set(a, 2);
        else if (a.genre === 'K') map.set(a, 3);
      }
      for (let i = 0; i < segs.length; i++) {
        const a = segs[i];
        if (map.has(a)) continue;
        if (a.genre === 'FK') {
          let g = null;
          for (let j = i - 1; j >= 0 && !g; j--) { const v = map.get(segs[j]); if (v === 2 || v === 3) g = v; }
          for (let j = i + 1; j < segs.length && !g; j++) { const v = map.get(segs[j]); if (v === 2 || v === 3) g = v; }
          map.set(a, g || mapGenre('FK', +uid));
        } else {
          map.set(a, mapGenre(a.genre, +uid));      // MGT/非生産/役割等
        }
      }
    }
    return (a) => map.get(a);
  }

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
    // 既存バーを (user_id, attending_genre_id) で引く。区分跨ぎの誤マッチを防ぐ。
    const curKey = (uid, g) => `${uid}:${g}`;
    const curByUG = {};
    const curByUser = {};
    for (const s of cur.list) {
      (curByUG[curKey(s.user_id, s.attending_genre_id)] ||= []).push(s);
      (curByUser[s.user_id] ||= []).push(s);
    }
    // FK・非生産・役割は基本「所属区分」に寄せる。所属がF/Kでない（社員等）人は、
    // らくしふ本体にFK区分が無いので、その人の既存らくしふ勤務の区分（単一なら）に寄せる。
    // （らくしふのFKは"区分"でなく"タスク"。FKの区間性は中身を引く=FKタスクで表現される）
    const belong = {};
    for (const uu of (cur.users || [])) belong[uu.id] = uu.belonging_genre_id;
    const baseGenre = {};   // uid → 既存らくしふ勤務の単一区分（両方あれば0=曖昧）
    for (const s of cur.list) {
      if (s.off || (s.attending_genre_id !== 2 && s.attending_genre_id !== 3)) continue;
      if (baseGenre[s.user_id] === undefined) baseGenre[s.user_id] = s.attending_genre_id;
      else if (baseGenre[s.user_id] !== s.attending_genre_id) baseGenre[s.user_id] = 0;
    }
    // F/Kはそのまま。FKだけ所属/ベースにフォールバック。MGT/非生産/勉強会/MTG等の
    // 非オペ業務はF/K勤務ではない → null（外枠は引かない。管理時間は社員シフト等が持つ）。
    const mapGenre = (glabel, uid) => (glabel === 'F' ? 2 : glabel === 'K' ? 3
      : glabel === 'FK' ? ((belong[uid] === 2 || belong[uid] === 3) ? belong[uid]
        : (baseGenre[uid] === 2 || baseGenre[uid] === 3) ? baseGenre[uid] : null)
      : null);

    // 各セグメントの区分を決める。F/Kはそのまま。FKは「直前のF/Kライン」に付ける
    // （無ければ直後→所属/ベース）。本人指定: FとKはそれぞれ／FKは前のラインに従う。
    const resolveGid = buildGidResolver(asg, mapGenre);
    // 原案を (user_id, らくしふ区分) ごとにまとめる。区分をまたぐ人（応援）は区分別に線を持つ。
    // 区分がnull（MGT等の非オペ）は外枠を引かない＝スキップ。
    const byUG = {};
    for (const a of asg) {
      if (a.e <= a.s) continue;
      const gid = resolveGid(a);
      if (gid == null) continue;
      const key = `${a.user_id}:${gid}`;
      const g = (byUG[key] ||= { uid: a.user_id, name: a.name, gid, glabel: a.genre, bars: [] });
      g.bars.push(a);
    }
    // 各(user,区分)の「原案での最終区間」= マージ結果（単一区間のときだけ）。
    // 別区分の新規が既存線と重なるか調べるとき、既存線が原案で短くなる予定なら
    // その"予定後の区間"で重複を見る（例: 鎌田 F 10-19→10-17 に縮む間にK 17-19を新規したい）。
    const intendedSpan = {};
    for (const [key, g] of Object.entries(byUG)) {
      const bs = g.bars.filter((b) => b.e > b.s).sort((a, b) => a.s - b.s);
      const mg = [];
      for (const b of bs) {
        const last = mg[mg.length - 1];
        if (last && b.s <= last[1]) last[1] = Math.max(last[1], b.e);
        else mg.push([b.s, b.e]);
      }
      if (mg.length === 1) intendedSpan[key] = mg[0];   // 単一区間の人だけ
    }

    const rows = [];
    let splitSkipped = 0;   // 分割勤務は自動で弾く（本人指定）。件数だけ控える。
    for (const g of Object.values(byUG)) {
      const uid = g.uid;
      const manualRow = (desc) => rows.push({
        kind: 'manual', user_id: uid, name: g.name, genre: g.glabel, desc, manual: true });
      // 同区分のバーを時間帯でマージ＝その区分での出勤の線。2区間以上＝分割勤務。
      const bars = g.bars.filter((b) => b.e > b.s).sort((a, b) => a.s - b.s);
      if (!bars.length) continue;
      const merged = [];
      for (const b of bars) {
        const last = merged[merged.length - 1];
        if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
        else merged.push({ s: b.s, e: b.e });
      }
      if (merged.length > 1) {
        // 同区分が複数区間（分割 or F→K→Fのように別区分を挟む）。自動では引かないが、
        // 「対象外」で黙って隠すと相違が見えなくなるので、区間つきで要手動として必ず表示する。
        manualRow(`${g.glabel} ${merged.map((m) => `${hm(m.s)}-${hm(m.e)}`).join(' / ')}：分割（別区分を挟む等）→手動で個別に引く`);
        continue;
      }
      if (!g.gid) { manualRow(`区分${g.glabel}の所属が不明→手動`); continue; }
      const s = merged[0].s, e = merged[0].e;
      // 休憩は全バーから拾う（本体がポジション区間で表現される人でも取りこぼさない）。同一休憩は重複除去。
      const restSeen = new Set();
      const rests = [].concat(...g.bars.map((b) => b.rests || []))
        .filter((r) => Array.isArray(r) && r.length === 2 && r[1] > r[0]
          && !restSeen.has(`${r[0]}-${r[1]}`) && restSeen.add(`${r[0]}-${r[1]}`))
        .sort((a, b) => a[0] - b[0]);
      const restApi = restsToApi(rests);
      const restLabel = restApi.length ? `（休${rests.map((r) => hm(r[0]) + '-' + hm(r[1])).join(',')}）` : '';
      // 全域一致の単一タスクだけ store_task_ids に付ける。部分区間タスクは手動注記。
      const fullTaskIds = [];
      let partialTasks = 0;
      for (const t of g.bars.filter((b) => b.task)) {
        const id = nameToTaskId[t.task];
        if (id && t.s === s && t.e === e) fullTaskIds.push(id);
        else if (id) partialTasks += 1;
      }
      const genreId = g.gid;
      const existing = curByUG[curKey(uid, genreId)] || [];
      if (existing.length > 1) { manualRow(`${hm(s)}-${hm(e)}：既存バーが複数→手動`); continue; }
      const ex = existing[0];
      const warn = [];
      if (ex && (ex.is_shared || ex.is_fixed)) warn.push('共有済みを引き直し');
      if (partialTasks) warn.push(`時間指定タスク${partialTasks}件は手動`);
      const warnTxt = warn.length ? `　⚠${warn.join('・')}` : '';
      const gl = g2label(genreId);

      if (!ex) {
        // その区分の既存バーは無い。ただし別区分で時間が重なる勤務があると、新規作成は
        // 「時間が重複」で弾かれる。区分が変わっただけ（例 K→F）なら、その線を引き直す。
        // ★重複判定は既存線の「原案での最終区間」で見る。別グループが縮める予定の線
        //   （例 鎌田F 10-19→10-17）とは、縮んだ後の区間で重ならなければ別物＝新規で引く。
        const overlap = (curByUser[uid] || []).filter((x) => {
          if (x.off || x.start_as_min == null || x.end_as_min == null) return false;
          const eff = intendedSpan[curKey(uid, x.attending_genre_id)]
            || [x.start_as_min, x.end_as_min];
          return eff[0] < e && eff[1] > s;
        });
        if (overlap.length === 1) {
          const o = overlap[0];
          rows.push({
            kind: 'retime', user_id: uid, name: g.name, genre: gl,
            desc: `${g2label(o.attending_genre_id)} ${hm(o.start_as_min)}-${hm(o.end_as_min)} → ${gl} ${hm(s)}-${hm(e)} に引き直す（区分変更）${restLabel}` + warnTxt,
            bar_id: o.id,
            payload: { schedule: {
              id: o.id, attending_store_id: o.attending_store_id, attending_genre_id: genreId,
              start_hour: Math.floor(s / 60), start_minute: s % 60,
              end_hour: Math.floor(e / 60), end_minute: e % 60,
              rest_times: restApi, off: false, off_type: 0,
              store_task_ids: o.store_task_ids || [], company_special_holiday_id: o.company_special_holiday_id,
            } },
          });
          continue;
        }
        if (overlap.length > 1) { manualRow(`${gl} ${hm(s)}-${hm(e)}：既存の勤務が複数重なる→手動`); continue; }
        rows.push({
          kind: 'create', user_id: uid, name: g.name, genre: gl,
          desc: `新しく ${gl} ${hm(s)}-${hm(e)} を引く${restLabel}`
            + (fullTaskIds.length ? `＋タスク${fullTaskIds.length}` : '') + warnTxt,
          payload: { schedule: {
            user_id: uid, attending_store_id: +cur.storeId, attending_genre_id: genreId,
            date: ymd(date), start_hour: Math.floor(s / 60), start_minute: s % 60,
            end_hour: Math.floor(e / 60), end_minute: e % 60,
            rest_times: restApi, off: false, off_type: 0,
            store_task_ids: fullTaskIds, company_special_holiday_id: null,
          } },
        });
        continue;
      }
      const wasOff = ex.off || ex.start_as_min == null || ex.end_as_min == null;
      if (!wasOff) {
        const sameTime = ex.start_as_min === s && ex.end_as_min === e;
        const sameRest = restEq(apiRestToMin(ex.rest_times).sort(), rests.map((r) => [r[0], r[1]]).sort());
        if (sameTime && sameRest) {   // 既に原案どおり＝一致。反映は不要だが「見える」ように出す
          rows.push({ kind: 'match', user_id: uid, name: g.name, genre: gl, manual: true,
            desc: `${gl} ${hm(s)}-${hm(e)}${restLabel}` });
          continue;
        }
      }
      rows.push({
        kind: 'retime', user_id: uid, name: g.name, genre: gl,
        desc: (wasOff ? `休み → ${gl} ${hm(s)}-${hm(e)} を引く${restLabel}`
          : `${gl} ${hm(ex.start_as_min)}-${hm(ex.end_as_min)} → ${hm(s)}-${hm(e)} に引き直す${restLabel}`) + warnTxt,
        bar_id: ex.id,
        // 実際の成功PUTに合わせた最小ボディ（shift_pattern_id/memo_text を入れると400）。
        // store_task_ids は既存を保持（null不可＝配列で送る）。off は必ず外す。
        payload: { schedule: {
          id: ex.id, attending_store_id: ex.attending_store_id, attending_genre_id: ex.attending_genre_id,
          start_hour: Math.floor(s / 60), start_minute: s % 60,
          end_hour: Math.floor(e / 60), end_minute: e % 60,
          rest_times: restApi, off: false, off_type: 0,
          store_task_ids: ex.store_task_ids || [], company_special_holiday_id: ex.company_special_holiday_id,
        } },
      });
    }

    // 休みの反映: らくしふに勤務(要確定含む)の線があるのに、原案ではその区分で働かせない人
    //   → 休みにする(PUT off:true)。原案に(その区分で)いない＝設計上その区分は休み、という判断。
    //   採取した休みPUTの最小ボディ形をそのまま使う。
    const nameByUid = {};
    for (const uu of (cur.users || [])) nameByUid[uu.id] = (uu.name || '').replace(/\s+/g, ' ').trim();
    // 原案の勤務区間を「区分ごと」に持つ。らくしふのある区分の線が、原案の"同じ区分"の
    // 勤務と重ならなければ「休みにする」。区分単位にすることで、区分が変わって不要になった
    // 別区分の線（例 FKをFで引いた残り→原案はK）を確実に消せる（重複400の元を断つ）。
    const draftSpansG = {};
    for (const a of asg) {
      if (a.e <= a.s) continue;
      const gid = resolveGid(a);
      if (gid !== 2 && gid !== 3) continue;
      (draftSpansG[`${a.user_id}:${gid}`] ||= []).push([a.s, a.e]);
    }
    const draftCoversG = (uid, gid, s0, e0) =>
      (draftSpansG[`${uid}:${gid}`] || []).some(([a, b]) => a < e0 && b > s0);
    for (const s of cur.list) {
      if (s.off || s.start_as_min == null || s.end_as_min == null) continue;    // 既に休み/時間なし
      if (s.attending_genre_id !== 2 && s.attending_genre_id !== 3) continue;    // F/K以外は対象外
      if (draftCoversG(s.user_id, s.attending_genre_id, s.start_as_min, s.end_as_min)) continue; // 同区分の原案勤務と重なる→残す
      const gl = g2label(s.attending_genre_id);
      rows.push({
        kind: 'off', user_id: s.user_id, name: nameByUid[s.user_id] || String(s.user_id), genre: gl,
        desc: `${gl} ${hm(s.start_as_min)}-${hm(s.end_as_min)} → 休みにする`
          + (s.is_shared || s.is_fixed ? '　⚠共有済み' : ''),
        bar_id: s.id,
        payload: { schedule: {
          id: s.id, attending_store_id: s.attending_store_id, attending_genre_id: s.attending_genre_id,
          rest_times: [], off: true, off_type: 0, company_special_holiday_id: s.company_special_holiday_id,
        } },
      });
    }
    // 総労働時間クロスチェック（防止対策・本人指定）: 原案とらくしふの F+K 実働(分)が
    // 人ごとに違うのに、他のロジックで何も出ていない＝「一致に見えて実は相違」を拾う。
    const netMin = (s0, e0, rr) => Math.max(0, (e0 - s0) - (rr || []).reduce((a, r) => a + Math.max(0, r[1] - r[0]), 0));
    const draftNet = {};
    for (const a of asg) {
      const gid = resolveGid(a);
      if (gid !== 2 && gid !== 3) continue;
      draftNet[a.user_id] = (draftNet[a.user_id] || 0) + netMin(a.s, a.e, a.rests);
    }
    const rkNet = {};
    for (const s of cur.list) {
      if (s.off || s.start_as_min == null || s.end_as_min == null) continue;
      if (s.attending_genre_id !== 2 && s.attending_genre_id !== 3) continue;
      if (String(s.attending_store_id) !== String(cur.storeId)) continue;
      rkNet[s.user_id] = (rkNet[s.user_id] || 0) + netMin(s.start_as_min, s.end_as_min, apiRestToMin(s.rest_times));
    }
    for (const uid of new Set([...Object.keys(draftNet), ...Object.keys(rkNet)].map(Number))) {
      const dn = draftNet[uid] || 0; const rn = rkNet[uid] || 0;
      if (Math.abs(dn - rn) < 15) continue;                    // 15分未満のズレは無視
      if (rows.some((r) => r.user_id === uid && r.kind !== 'match')) continue; // 既に何か出てる人は重複させない
      rows.push({ kind: 'manual', user_id: uid, name: nameByUid[uid] || String(uid), genre: '', manual: true,
        desc: `総労働時間が違う（原案 ${(dn / 60).toFixed(1)}h ／ らくしふ ${(rn / 60).toFixed(1)}h）→要確認` });
    }
    // 名前順。ただし同じ人では 引き直し/休み を新規より先に（既存線を縮めてから新規を引く＝重複回避）
    const kindOrd = (r) => (r.kind === 'off' ? 0 : r.kind === 'retime' ? 1 : r.kind === 'create' ? 2 : 3);
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja') || (kindOrd(a) - kindOrd(b)));
    rows.splitSkipped = splitSkipped;   // 分割勤務で弾いた件数（表示用）
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
    const matched = reflectRows.filter((r) => r.kind === 'match');
    const manual = reflectRows.filter((r) => r.manual && r.kind !== 'match');
    if (!reflectRows.length) { el.innerHTML = '<span class="allok">✓ 原案どおり引けています（引く線なし）</span>'; return; }
    const rowHtml = (r, i) => {
      const label = r.kind === 'create' ? '線を引く' : r.kind === 'off' ? '休みにする' : '引き直す';
      const btn = r.manual ? '<span class="muted" style="font-size:11px">要手動</span>'
        : `<button class="rap" data-i="${i}">${label}</button>`;
      return `<div class="rrow ${r.kind}" data-i="${i}">` +
        `<span class="rwho"><span class="dtag ${esc(r.genre || '')}" style="display:inline-block;` +
        `width:20px;text-align:center;border-radius:4px;color:#fff;font-size:10px">${esc(r.genre || '?')}</span> ` +
        `${esc(r.name)}</span><span class="rwhat">${esc(r.desc)}</span>${btn}</div>`;
    };
    const matchHtml = matched.length
      ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:#2c6e49">✓ 既に一致 ${matched.length}件（他セクション応援も含む・反映不要）</summary>`
        + matched.map((r) => `<div class="rrow match"><span class="rwho"><span class="dtag ${esc(r.genre || '')}" `
          + `style="display:inline-block;width:20px;text-align:center;border-radius:4px;color:#fff;font-size:10px">${esc(r.genre || '?')}</span> `
          + `${esc(r.name)}</span><span class="rwhat">${esc(r.desc)}</span></div>`).join('') + '</details>'
      : '';
    el.innerHTML =
      `<div class="rf-warn">原案どおりにらくしふへ線を引きます。1行ずつご確認のうえボタンを押してください` +
      `（削除・確定送信は行いません）。${rfCsrf() ? '' : '<b>⚠CSRFトークン未検出：このページをリロードしてください</b>'}</div>` +
      `<div class="rsum">反映できる ${auto.length}件（引く/引き直す/休みにする）`
      + `${manual.length ? ` ／ 要手動 ${manual.length}件` : ''}${matched.length ? ` ／ 一致 ${matched.length}件` : ''}`
      + `${reflectRows.splitSkipped ? ` ／ 分割勤務 ${reflectRows.splitSkipped}人は対象外` : ''}</div>` +
      (auto.length ? `<div style="margin:2px 0"><button id="reflectAll" title="上から順に1件ずつ反映（各件の成否を表示）">▶ ${auto.length}件をまとめて反映</button></div>` : '') +
      reflectRows.filter((r) => r.kind !== 'match').map((r) => rowHtml(r, reflectRows.indexOf(r))).join('') +
      matchHtml;
  }

  // 反映失敗を海賊版サーバ(:8790)へ自動送信（原因調査用・義務化）。送信失敗は握りつぶす。
  async function reportReflectFailure(kind, date, r, err) {
    try {
      await draftApi('/api/reflect-failure', {
        kind, date: ymd(date), at: new Date().toISOString(), href: location.href,
        name: r?.name || '', genre: r?.genre || '', row_kind: r?.kind || '',
        bar_id: r?.bar_id || null, error: String(err && err.message || err || ''),
        payload: r?.payload || r?.sched || null,
      });
    } catch { /* 送信失敗は無視 */ }
  }

  // 1行分の実書き込み（POST=新規 / PUT=引直・休み）。DOM非依存。確定には触れない。
  async function reflectRequest(r, token) {
    const url = r.kind === 'create' ? '/ajax/admin/schedules' : `/ajax/admin/schedules/${r.bar_id}`;
    const method = r.kind === 'create' ? 'POST' : 'PUT';
    const res = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
      body: JSON.stringify(r.payload),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text() || '').slice(0, 300); } catch { /* noop */ }
      throw new Error(`HTTP ${res.status}${detail ? ' ' + detail : ''}`);
    }
    return true;
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
    try {
      await reflectRequest(r, token);
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
      reportReflectFailure('外枠', targetDate, r, e);
      return false;
    }
  }

  // ===== 月まとめて反映：相違のある日を抽出→チェックで選択→実行 =====
  let monthScan = null;  // [{day, rows, auto, counts}]
  const monthDays = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    const n = new Date(y, m, 0).getDate();
    return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  };
  async function scanReflectMonth() {
    const box = $('#reflectMonth');
    box.style.display = ''; box.className = 'reflect';
    const ym = $('#reflectMonthSel').value;
    const days = monthDays(ym);
    box.innerHTML = `<span class="muted">${ym} を全日スキャン中… 0/${days.length}</span>`;
    monthScan = [];
    for (let k = 0; k < days.length; k++) {
      const day = days[k];
      try {
        const rows = await buildReflectPlan(parseYmd(day));
        const auto = rows.filter((r) => !r.manual && r.kind !== 'match');
        const manual = rows.filter((r) => r.manual && r.kind !== 'match');
        if (auto.length) {
          const c = { create: 0, retime: 0, off: 0 };
          for (const r of auto) c[r.kind] = (c[r.kind] || 0) + 1;
          monthScan.push({ day, rows, auto, manual: manual.length, counts: c });
        }
      } catch { /* その日は飛ばす */ }
      box.querySelector('.muted') && (box.querySelector('.muted').textContent = `${ym} を全日スキャン中… ${k + 1}/${days.length}`);
    }
    renderMonthScan();
  }
  function renderMonthScan() {
    const box = $('#reflectMonth');
    if (!monthScan.length) { box.innerHTML = '<span class="allok">✓ この月は相違なし（全日一致）</span>'; return; }
    const total = monthScan.reduce((a, s) => a + s.auto.length, 0);
    const md = (d) => { const x = parseYmd(d); return `${x.getMonth() + 1}/${x.getDate()}(${WEEKDAYS[x.getDay()]})`; };
    const rowHtml = (s) => {
      const c = s.counts;
      const parts = [c.create ? `引く${c.create}` : '', c.retime ? `引直${c.retime}` : '', c.off ? `休み${c.off}` : '']
        .filter(Boolean).join(' ');
      return `<label class="rmday"><input type="checkbox" class="rm-cb" data-day="${s.day}" checked> ` +
        `<b>${md(s.day)}</b> <span class="rmc">${parts}</span>` +
        `${s.manual ? `<span class="muted" style="font-size:10px">（手動${s.manual}）</span>` : ''}` +
        `<span class="rm-stat" data-day="${s.day}"></span></label>`;
    };
    box.innerHTML =
      `<div class="rf-warn">相違のある ${monthScan.length}日・計${total}件。チェックした日を上から順に反映します` +
      `（引く/引き直す/休みにする。削除・確定送信はしません／手動分は入りません）。</div>` +
      `<div style="margin:3px 0"><button id="rmAllToggle">全解除</button> ` +
      `<button id="rmRun">▶ 選択した日を反映</button></div>` +
      monthScan.map(rowHtml).join('');
  }
  async function runMonthReflect() {
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return; }
    const picked = [...$('#reflectMonth').querySelectorAll('.rm-cb:checked')].map((c) => c.dataset.day);
    if (!picked.length) { alert('反映する日が選ばれていません。'); return; }
    const n = picked.reduce((a, d) => a + (monthScan.find((s) => s.day === d)?.auto.length || 0), 0);
    if (!confirm(`${picked.length}日・計${n}件をらくしふへ反映します。よろしいですか？\n（確定送信はしません）`)) return;
    const runBtn = $('#rmRun'); if (runBtn) { runBtn.disabled = true; }
    for (const day of picked) {
      const s = monthScan.find((x) => x.day === day);
      const stat = $(`#reflectMonth .rm-stat[data-day="${day}"]`);
      if (!s) continue;
      let ok = 0; let ng = 0;
      for (const r of s.auto) {
        if (stat) stat.textContent = `　送信中… ${ok + ng + 1}/${s.auto.length}`;
        try { await reflectRequest(r, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('外枠(月)', parseYmd(day), r, e); }
      }
      if (stat) { stat.textContent = `　✓ ${ok}件${ng ? ` / 失敗${ng}` : ''}`; stat.style.color = ng ? 'var(--neg)' : 'var(--pos)'; }
      // 失敗が無い日だけチェックを外す。失敗が残る日はチェックしたまま＝常に見える（本人指定）
      const row = $(`#reflectMonth .rmday[data-day="${day}"]`) || (stat && stat.closest('.rmday'));
      const cb = $(`#reflectMonth .rm-cb[data-day="${day}"]`);
      if (ng) { if (row) row.classList.add('failed'); }
      else if (cb) cb.checked = false;
    }
    if (runBtn) { runBtn.textContent = '完了'; }
    lastDraftDay = null;
    renderSheet();   // 表示中日を取り直す
  }

  // ===== 月まとめて（中身＝区間タスク）：相違のある日を抽出→チェックで選択→反映 =====
  let taskMonthScan = null;  // [{day, rows, storeId}]
  async function scanTaskMonth() {
    const box = $('#taskMonth');
    box.style.display = ''; box.className = 'reflect';
    const ym = $('#reflectMonthSel').value;
    const days = monthDays(ym);
    box.innerHTML = `<span class="muted">${ym} の中身を全日スキャン中… 0/${days.length}</span>`;
    taskMonthScan = [];
    for (let k = 0; k < days.length; k++) {
      const day = days[k];
      try {
        const res = await buildTaskPlan(parseYmd(day));
        if (res.rows.length) taskMonthScan.push({ day, rows: res.rows, storeId: res.storeId });
      } catch { /* その日は飛ばす */ }
      box.querySelector('.muted') && (box.querySelector('.muted').textContent = `${ym} の中身を全日スキャン中… ${k + 1}/${days.length}`);
    }
    renderTaskMonthScan();
  }
  function renderTaskMonthScan() {
    const box = $('#taskMonth');
    if (!taskMonthScan.length) { box.innerHTML = '<span class="allok">✓ この月は中身も一致（引く区間タスクなし）</span>'; return; }
    const total = taskMonthScan.reduce((a, s) => a + s.rows.length, 0);
    const md = (d) => { const x = parseYmd(d); return `${x.getMonth() + 1}/${x.getDate()}(${WEEKDAYS[x.getDay()]})`; };
    const rowHtml = (s) => `<label class="rmday"><input type="checkbox" class="tm-cb" data-day="${s.day}" checked> ` +
      `<b>${md(s.day)}</b> <span class="rmc">${s.rows.length}人</span>` +
      `<span class="rm-stat tm-stat" data-day="${s.day}"></span></label>`;
    box.innerHTML =
      `<div class="rf-warn">中身に相違のある ${taskMonthScan.length}日・計${total}人。チェックした日を上から順に反映します` +
      `（区間タスクを原案どおり／そのシフトのタスクを丸ごと置換・確定送信・削除はしません）。</div>` +
      `<div style="margin:3px 0"><button id="tmAllToggle">全解除</button> ` +
      `<button id="tmRun">▶ 選択した日の中身を反映</button></div>` +
      taskMonthScan.map(rowHtml).join('');
  }
  async function runTaskMonthReflect() {
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return; }
    const picked = [...$('#taskMonth').querySelectorAll('.tm-cb:checked')].map((c) => c.dataset.day);
    if (!picked.length) { alert('反映する日が選ばれていません。'); return; }
    const n = picked.reduce((a, d) => a + (taskMonthScan.find((s) => s.day === d)?.rows.length || 0), 0);
    if (!confirm(`${picked.length}日・計${n}人の中身(区間タスク)をらくしふへ反映します。よろしいですか？\n（確定送信はしません）`)) return;
    const runBtn = $('#tmRun'); if (runBtn) { runBtn.disabled = true; }
    for (const day of picked) {
      const s = taskMonthScan.find((x) => x.day === day);
      const stat = $(`#taskMonth .tm-stat[data-day="${day}"]`);
      if (!s) continue;
      let ok = 0; let ng = 0;
      for (const r of s.rows) {
        if (stat) stat.textContent = `　送信中… ${ok + ng + 1}/${s.rows.length}`;
        try { await taskAssignRequest(parseYmd(day), s.storeId, r.genre_id, r.sched, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('中身(月)', parseYmd(day), r, e); }
      }
      if (stat) { stat.textContent = `　✓ ${ok}件${ng ? ` / 失敗${ng}` : ''}`; stat.style.color = ng ? 'var(--neg)' : 'var(--pos)'; }
      const row = $(`#taskMonth .rmday .tm-cb[data-day="${day}"]`)?.closest('.rmday');
      const cb = $(`#taskMonth .tm-cb[data-day="${day}"]`);
      if (ng) { if (row) row.classList.add('failed'); }
      else if (cb) cb.checked = false;
    }
    if (runBtn) { runBtn.textContent = '完了'; }
    lastDraftDay = null;
    renderSheet();
  }

  // ===== 期間まとめて：指定期間を「外枠→CK→中身」の順にらくしふへ反映 =====
  // 各フェーズは日ごとにその都度らくしふをGETしてプランを組む（外枠反映で変わった状態を
  // CK/中身が正しく参照できるよう、フェーズを跨いで最新を取り直す）。確定送信・削除はしない。
  const rangeDays = (from, to) => {
    const out = []; const d = parseYmd(from); const end = parseYmd(to);
    while (d <= end) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
    return out;
  };
  async function runRangeAll() {
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return; }
    const from = $('#rangeFrom').value; const to = $('#rangeTo').value;
    if (!from || !to) { alert('期間（開始・終了）を指定してください。'); return; }
    if (from > to) { alert('開始日が終了日より後になっています。'); return; }
    const days = rangeDays(from, to);
    if (days.length > 62) { alert('期間が長すぎます（62日以内で指定してください）。'); return; }
    if (!confirm(`${from} 〜 ${to}（${days.length}日）を\n① 外枠 → ② CK → ③ 中身 の順にらくしふへ反映します。\nよろしいですか？（確定送信・削除はしません）`)) return;
    const box = $('#rangeRun'); box.style.display = ''; box.className = 'reflect';
    const btn = $('#rangeRunAll'); if (btn) { btn.disabled = true; }
    const done = [];
    const paint = (cur) => { box.innerHTML = done.map((l) => `<div>${l}</div>`).join('') + (cur ? `<div class="muted">${cur}</div>` : ''); };
    // ① 外枠
    let ok = 0; let ng = 0;
    for (let i = 0; i < days.length; i++) {
      paint(`① 外枠 反映中… ${i + 1}/${days.length}日（${ok}件${ng ? ` / 失敗${ng}` : ''}）`);
      let rows; try { rows = await buildReflectPlan(parseYmd(days[i])); } catch { continue; }
      for (const r of rows.filter((x) => !x.manual && x.kind !== 'match')) {
        try { await reflectRequest(r, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('外枠(期間)', parseYmd(days[i]), r, e); }
      }
    }
    done.push(`① 外枠: ${ok}件${ng ? ` / <span style="color:var(--neg)">失敗${ng}</span>` : ' ✓'}`);
    // ② CK
    ok = 0; ng = 0;
    for (let i = 0; i < days.length; i++) {
      paint(`② CK 割付中… ${i + 1}/${days.length}日（${ok}件${ng ? ` / 失敗${ng}` : ''}）`);
      let res; try { res = await buildCkPlan(parseYmd(days[i])); } catch { continue; }
      for (const x of (res.plan || []).filter((y) => y.bar && !y.already)) {
        try { await ckRequest(x.bar, x.task, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('CK(期間)', parseYmd(days[i]), { name: res.nameOf?.[x.bar?.user_id] || '', genre: 'CK', kind: x.task, bar_id: x.bar?.id }, e); }
      }
    }
    done.push(`② CK: ${ok}件${ng ? ` / <span style="color:var(--neg)">失敗${ng}</span>` : ' ✓'}`);
    // ③ 中身
    ok = 0; ng = 0;
    for (let i = 0; i < days.length; i++) {
      paint(`③ 中身 反映中… ${i + 1}/${days.length}日（${ok}件${ng ? ` / 失敗${ng}` : ''}）`);
      let res; try { res = await buildTaskPlan(parseYmd(days[i])); } catch { continue; }
      for (const r of res.rows) {
        try { await taskAssignRequest(parseYmd(days[i]), res.storeId, r.genre_id, r.sched, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('中身(期間)', parseYmd(days[i]), r, e); }
      }
    }
    done.push(`③ 中身: ${ok}件${ng ? ` / <span style="color:var(--neg)">失敗${ng}</span>` : ' ✓'}`);
    done.push('<b>完了</b>（失敗があれば原因は自動送信済み）');
    paint('');
    if (btn) { btn.disabled = false; }
    lastDraftDay = null;
    renderSheet();
  }

  // ===== 店舗メモに「【修正客数】###」(LE客数の日予測) を入れる（次1週間・空の日だけ） =====
  // 口: GET/POST /ajax/(admin/)dailymemos（実測で確定）。既存メモがある日は触らない。
  const MEMO_GENRES = ['2', '3', '4', '17'];
  async function dailyMemoMap(storeId, fromStr, toStr) {
    const q = new URLSearchParams(); q.set('store_id', storeId);
    for (const g of MEMO_GENRES) q.append('genre_ids[]', g);
    q.set('from_date', fromStr); q.set('to_date', toStr);
    const r = await fetch('/ajax/admin/dailymemos?' + q, {
      credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`店舗メモ取得 HTTP ${r.status}`);
    return (await r.json()).store_memo || {};
  }
  async function dailyMemoPost(storeId, dateStr, text, token) {
    const res = await fetch('/ajax/dailymemos', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
      body: JSON.stringify({ dailymemo_id: `${dateStr}__store_memo`, store_id: +storeId, dailymemo: text }),
    });
    if (!res.ok) { let t = ''; try { t = await res.text(); } catch { /* noop */ } throw new Error(`HTTP ${res.status} ${t}`.slice(0, 200)); }
    return true;
  }
  async function runMemoLE() {
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return; }
    const storeId = new URLSearchParams(location.search).get('s');
    if (!storeId) { alert('store_id 不明'); return; }
    // 次の1週間（今日から7日ぶん）
    const days = [];
    const b = new Date(); b.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) { const d = new Date(b); d.setDate(d.getDate() + i); days.push(d); }
    const box = $('#memoRun'); box.style.display = ''; box.className = 'reflect';
    box.innerHTML = '<span class="muted">店舗メモを確認中…</span>';
    let memo;
    try { memo = await dailyMemoMap(storeId, ymd(days[0]), ymd(days[6])); }
    catch (e) { box.innerHTML = `<span class="err">失敗: ${esc(e.message)}</span>`; return; }
    const btn = $('#memoLE'); if (btn) { btn.disabled = true; }
    const lines = []; let wrote = 0; let skip = 0; let ng = 0;
    for (const d of days) {
      const ds = ymd(d);
      if ((memo[ds] || '').trim()) { skip += 1; lines.push(`${ds}　既存メモあり → 触らない`); continue; }
      let total = null;
      try { const s = await fetchSheet(d); if (s && !s.error) total = s.hourly?.LE?.total; } catch { /* noop */ }
      if (total == null || total === '') { skip += 1; lines.push(`${ds}　LE値なし(範囲外?) → スキップ`); continue; }
      const text = `【修正客数】${total}`;
      try { await dailyMemoPost(storeId, ds, text, token); wrote += 1; lines.push(`${ds}　✓ ${text}`); }
      catch (e) { ng += 1; lines.push(`${ds}　<span style="color:var(--neg)">失敗 ${esc(e.message)}</span>`); reportReflectFailure('店舗メモ', d, { name: '', genre: 'memo', payload: { date: ds, text } }, e); }
    }
    box.innerHTML = `<div class="rf-warn">次の1週間、空の店舗メモに【修正客数】(LE客数)を入れました` +
      `（書込 ${wrote} / スキップ ${skip}${ng ? ` / <span style="color:var(--neg)">失敗 ${ng}</span>` : ''}）。既存メモは触りません。</div>` +
      lines.map((l) => `<div style="font-size:11px">${l}</div>`).join('');
    if (btn) { btn.disabled = false; }
  }

  // 対象日のCK割付プランを作る。既に付いている人はそのまま（重複して付けない）。
  async function buildCkPlan(date) {
    const [cur, siIds] = await Promise.all([fetchInstructedRaw(date), fetchSocialInsurance()]);
    // 正社員判定に名前が要るので、先にAPIの users から埋めておく
    const nameOf = {};
    for (const u of cur.users) nameOf[u.id] = (u.name || '').replace(/\s+/g, ' ').trim();
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
    // 社保加入 = 海賊版 constraints.json の kind:"shakaiho" ＋ 正社員
    const regIds = new Set(cur.list
      .filter((s) => REGULAR_STAFF.includes((nameOf[s.user_id] || '').replace(/\s+/g, '')))
      .map((s) => s.user_id));
    const isSI = (s) => siIds.has(s.user_id) || regIds.has(s.user_id);
    // 午後・日付: 社保加入 → 実働が長い順 → 早出（本人指定のルール）
    const rank = (pool) => [...pool].sort((a, b) =>
      (isSI(b) - isSI(a)) || (netLen(b) - netLen(a)) || (a.start_as_min - b.start_as_min));
    // 午前の温度は「オープン担当」＝最も早く出る人。廃棄=ラストと対称で、
    // 実績(7日)との一致が 40%→59% に上がったため午前だけこの並びにする（2026-07-24検証）。
    const rankAm = (pool) => [...pool].sort((a, b) =>
      (isSI(b) - isSI(a)) || (a.start_as_min - b.start_as_min) || (netLen(b) - netLen(a)));
    const hasTag = (s, id) => (s.store_task_ids || []).includes(id);
    const F = bars.filter((s) => s.attending_genre_id === 2);
    const K = bars.filter((s) => s.attending_genre_id === 3);
    const amOf = (a) => a.filter((s) => s.start_as_min < NOON);
    const pmOf = (a) => a.filter((s) => s.end_as_min > NOON);
    const plan = [];
    const pick = (pool, used) => rank(pool).find((s) => !used.has(s.user_id)) || null;
    const pickAm = (pool, used) => rankAm(pool).find((s) => !used.has(s.user_id)) || null;
    const add = (label, s, task) => {
      if (!s) { plan.push({ label, task, missing: true }); return; }
      plan.push({ label, task, bar: s, already: hasTag(s, CK_TASK[task]) });
    };
    // フロア: 午前1名・午後1名に温度（別人）
    const uF = new Set();
    const f1 = pickAm(amOf(F), uF); if (f1) uF.add(f1.user_id);
    add('F 温度(午前)', f1, '温度');
    const f2 = pick(pmOf(F), uF); if (f2) uF.add(f2.user_id);
    add('F 温度(午後)', f2, '温度');
    // キッチン: 午前温度 → 廃棄(ラスト=最も遅く終わる人) → 午後温度 → 日付（全員別人）
    const uK = new Set();
    const k1 = pickAm(amOf(K), uK); if (k1) uK.add(k1.user_id);
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
    const siCount = new Set([...siIds, ...regIds]).size;
    return { plan, nameOf, storeId: cur.storeId, siCount };
  }

  let ckRows = null;
  async function renderCkPlan() {
    const el = $('#reflect');
    el.className = 'reflect';
    el.innerHTML = '<span class="muted">CK割付を計算中…</span>';
    let res;
    try { res = await buildCkPlan(targetDate); }
    catch (e) { el.innerHTML = `<span class="err">失敗: ${esc(e.message)}</span>`; return; }
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
      (res.siCount ? `<br>社保加入者 ${res.siCount}名を優先（海賊版 constraints.json の kind:shakaiho＋正社員）。`
        + '午前の温度は「最も早く出る人」＝オープン担当。'
        : '<br><b>※社保加入者が取れませんでした（海賊版に繋がらない）。勤務時間順のみで選んでいます。</b>') +
      '</div>' +
      `<div class="rsum">付与する ${todo.length}件</div>` +
      (todo.length ? `<div style="margin:2px 0"><button id="ckAll">▶ ${todo.length}件をまとめて付与</button></div>` : '') +
      ckRows.map(rowHtml).join('');
  }

  // 1件付与: 既存 store_task_ids にCKのidを足して PUT（時間は既存のまま送る）
  // CK1件の実書き込み（既存 store_task_ids にCK idを足すPUT）。DOM非依存。
  async function ckRequest(ex, task, token) {
    const ids = Array.from(new Set([...(ex.store_task_ids || []), CK_TASK[task]]));
    const payload = { schedule: {
      id: ex.id, attending_store_id: ex.attending_store_id, attending_genre_id: ex.attending_genre_id,
      start_hour: Math.floor(ex.start_as_min / 60), start_minute: ex.start_as_min % 60,
      end_hour: Math.floor(ex.end_as_min / 60), end_minute: ex.end_as_min % 60,
      rest_times: (ex.rest_times || []),
      off: !!ex.off, off_type: ex.off_type || 0,
      store_task_ids: ids, company_special_holiday_id: ex.company_special_holiday_id,
    } };
    const res = await fetch(`/ajax/admin/schedules/${ex.id}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let d = ''; try { d = (await res.text() || '').slice(0, 200); } catch { /* noop */ }
      throw new Error(`HTTP ${res.status}${d ? ' ' + d : ''}`);
    }
    return true;
  }

  async function applyCkRow(i) {
    const r = ckRows && ckRows[i];
    if (!r || !r.bar || r.already) return false;
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return false; }
    const rowEl = $(`#reflect .rrow[data-i="${i}"]`);
    const btn = rowEl && rowEl.querySelector('.ckap');
    if (btn) { btn.disabled = true; btn.textContent = '送信中'; }
    try {
      await ckRequest(r.bar, r.task, token);
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
      reportReflectFailure('CK', targetDate, { name: r.label || '', genre: r.genre || '', kind: r.task || 'ck', bar_id: r.bar && r.bar.id, payload: null }, e);
      return false;
    }
  }

  // ===== CK割付：月まとめて（未付与の日を抽出→チェック選択→実行）=====
  let ckMonthScan = null;  // [{day, todo:[{bar,task}], counts}]
  async function scanCkMonth() {
    const box = $('#ckMonth');
    $('#reflectMonth').style.display = 'none';
    box.style.display = ''; box.className = 'reflect';
    const ym = $('#reflectMonthSel').value;
    const days = monthDays(ym);
    box.innerHTML = `<span class="muted">${ym} のCKを全日スキャン中… 0/${days.length}</span>`;
    ckMonthScan = [];
    for (let k = 0; k < days.length; k++) {
      const day = days[k];
      try {
        const res = await buildCkPlan(parseYmd(day));
        const todo = res.plan.filter((r) => r.bar && !r.already);
        if (todo.length) ckMonthScan.push({ day, todo });
      } catch { /* 飛ばす */ }
      const m = box.querySelector('.muted'); if (m) m.textContent = `${ym} のCKを全日スキャン中… ${k + 1}/${days.length}`;
    }
    renderCkMonthScan();
  }
  function renderCkMonthScan() {
    const box = $('#ckMonth');
    if (!ckMonthScan.length) { box.innerHTML = '<span class="allok">✓ この月はCK未付与なし</span>'; return; }
    const total = ckMonthScan.reduce((a, s) => a + s.todo.length, 0);
    const md = (d) => { const x = parseYmd(d); return `${x.getMonth() + 1}/${x.getDate()}(${WEEKDAYS[x.getDay()]})`; };
    const rowHtml = (s) => `<label class="rmday"><input type="checkbox" class="ckm-cb" data-day="${s.day}" checked> ` +
      `<b>${md(s.day)}</b> <span class="rmc">CK ${s.todo.length}件</span>` +
      `<span class="ckm-stat" data-day="${s.day}"></span></label>`;
    box.innerHTML =
      `<div class="rf-warn">CK未付与の ${ckMonthScan.length}日・計${total}件。チェックした日にCK（温度/日付/廃棄）を付与します` +
      `（シフト全域タグ・時間は変えません／確定送信はしません）。</div>` +
      `<div style="margin:3px 0"><button id="ckmAllToggle">全解除</button> ` +
      `<button id="ckmRun">▶ 選択した日にCK割付</button></div>` +
      ckMonthScan.map(rowHtml).join('');
  }
  async function runCkMonth() {
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return; }
    const picked = [...$('#ckMonth').querySelectorAll('.ckm-cb:checked')].map((c) => c.dataset.day);
    if (!picked.length) { alert('付与する日が選ばれていません。'); return; }
    const n = picked.reduce((a, d) => a + (ckMonthScan.find((s) => s.day === d)?.todo.length || 0), 0);
    if (!confirm(`${picked.length}日・計${n}件にCKを付与します。よろしいですか？`)) return;
    const runBtn = $('#ckmRun'); if (runBtn) runBtn.disabled = true;
    for (const day of picked) {
      const s = ckMonthScan.find((x) => x.day === day);
      const stat = $(`#ckMonth .ckm-stat[data-day="${day}"]`);
      if (!s) continue;
      let ok = 0; let ng = 0;
      for (const r of s.todo) {
        if (stat) stat.textContent = `　送信中… ${ok + ng + 1}/${s.todo.length}`;
        try { await ckRequest(r.bar, r.task, token); ok += 1; }
        catch (e) { ng += 1; reportReflectFailure('CK(月)', parseYmd(day), { name: '', genre: '', kind: r.task, bar_id: r.bar && r.bar.id, payload: null }, e); }
      }
      if (stat) { stat.textContent = `　✓ ${ok}件${ng ? ` / 失敗${ng}` : ''}`; stat.style.color = ng ? 'var(--neg)' : 'var(--pos)'; }
      const cb = $(`#ckMonth .ckm-cb[data-day="${day}"]`);
      if (ng) { const row = stat && stat.closest('.rmday'); if (row) row.classList.add('failed'); }
      else if (cb) cb.checked = false;
    }
    if (runBtn) runBtn.textContent = '完了';
    renderSheet();
  }

  // ===== 中身(区間タスク)の反映：FK/TRer/TRee/ポジションを原案どおり引く =====
  // 口: PUT /typed/v1/ajax/admin/schedules/task_assign/bulk（採取で確定）
  //   body {date, store_id, genre_id, schedules:[{id, rest_times:[{start_hour,..}], store_tasks:[{id,start_as_min,end_as_min}]}]}
  //   ★このシフトのタスクを"丸ごと置換"する。なので原案の区間タスク一式をまとめて送る。
  const TASK_ASSIGN_URL = '/typed/v1/ajax/admin/schedules/task_assign/bulk';
  async function taskAssignRequest(date, storeId, genreId, sched, token) {
    const body = { date: ymd(date), store_id: +storeId, genre_id: genreId, schedules: [sched] };
    const res = await fetch(TASK_ASSIGN_URL, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let d = ''; try { d = (await res.text() || '').slice(0, 200); } catch { /* noop */ }
      throw new Error(`HTTP ${res.status}${d ? ' ' + d : ''}`);
    }
    return true;
  }
  const restToApiObj = (rests) => (rests || [])
    .filter((r) => Array.isArray(r) && r.length === 2 && r[1] > r[0])
    .map(([s, e]) => ({ start_hour: Math.floor(s / 60), start_minute: s % 60, end_hour: Math.floor(e / 60), end_minute: e % 60 }));

  let taskRows = null;
  async function buildTaskPlan(date) {
    const [draftR, cur, taskMap] = await Promise.all([
      draftApi('/api/draft-day?date=' + ymd(date)),
      fetchInstructedRaw(date),
      fetchStoreTaskMap(new URLSearchParams(location.search).get('s')).catch(() => ({})),
    ]);
    if (!draftR || !draftR.ok) throw new Error('ShiftDraft未達（原案が取れません）');
    const nameToId = {};
    // らくしふのタスク名は「QC (R)」「MS (S2)」等の注記付き。原案は「QC」「MS」で持つので、
    // 注記（半角/全角カッコ以降）を落としたエイリアスも登録して名前ゆれを吸収する。
    const stripNote = (s) => (s || '').replace(/\s*[（(].*$/, '').trim();
    for (const [id, nm] of Object.entries(taskMap)) {
      nameToId[nm] = +id;
      const base = stripNote(nm);
      if (base && !(base in nameToId)) nameToId[base] = +id;
    }
    // 原案キー→id。完全一致で無ければ注記落としで再照合（双方向）。
    const taskNameToId = (key) => {
      if (!key) return null;
      if (key in nameToId) return nameToId[key];
      const b = stripNote(key);
      return (b in nameToId) ? nameToId[b] : null;
    };
    const belong = {};
    for (const uu of (cur.users || [])) belong[uu.id] = uu.belonging_genre_id;
    // 外枠の反映と同じ寄せ方: 所属がF/Kでない人は既存らくしふ勤務の単一区分へ（FKタスクをその線に乗せる）
    const baseGenre = {};
    for (const s of cur.list) {
      if (s.off || (s.attending_genre_id !== 2 && s.attending_genre_id !== 3)) continue;
      if (baseGenre[s.user_id] === undefined) baseGenre[s.user_id] = s.attending_genre_id;
      else if (baseGenre[s.user_id] !== s.attending_genre_id) baseGenre[s.user_id] = 0;
    }
    const mapGenre = (gl, uid) => (gl === 'F' ? 2 : gl === 'K' ? 3
      : gl === 'FK' ? ((belong[uid] === 2 || belong[uid] === 3) ? belong[uid]
        : (baseGenre[uid] === 2 || baseGenre[uid] === 3) ? baseGenre[uid] : null)
      : null);
    const nameOf = {};
    for (const uu of (cur.users || [])) nameOf[uu.id] = (uu.name || '').replace(/\s+/g, ' ').trim();
    // 区間タスクid: role(TRer/TRee) → task名 → genre名。ベース区分(F/K)と同じなら重ね不要=null。
    const FID = nameToId.F, KID = nameToId.K, FKID = nameToId.FK;
    // 原案を (user, らくしふ区分) にまとめる。FKは直前のラインに従う（外枠と同じ寄せ方）
    const resolveGid = buildGidResolver(draftR.data.assignments || [], mapGenre);
    const byUG = {};
    for (const a of (draftR.data.assignments || [])) {
      if (a.e <= a.s) continue;
      let gid = resolveGid(a);
      if (!gid) {
        // 非生産/MGT等でも、固定作業のタスクがらくしふタスクに解決できるなら本人のベースF/K線へ
        // 乗せる（例: スタンバイ・勉強会・商品管理）。素のF/K/FKは対象外（外枠が持つ）。
        const tid = taskNameToId(a.role) || taskNameToId(a.task);
        const bg = baseGenre[a.user_id];
        if (tid && ![FID, KID, FKID].includes(tid) && (bg === 2 || bg === 3)) gid = bg;
      }
      if (!gid) continue;
      (byUG[`${a.user_id}:${gid}`] ||= []).push(a);
    }
    const overlayId = (seg, baseGid) => {
      let id = taskNameToId(seg.role) || taskNameToId(seg.task) || taskNameToId(seg.genre);
      if (!id) return null;
      if ((baseGid === 2 && id === FID) || (baseGid === 3 && id === KID)) return null; // ベース区分はタグ不要
      return id;
    };
    const sortT = (arr) => arr.slice().sort((a, b) => a.start_as_min - b.start_as_min || a.id - b.id);
    const sameTasks = (a, b) => {
      const A = sortT(a); const B = sortT(b);
      if (A.length !== B.length) return false;
      return A.every((x, i) => x.id === B[i].id && x.start_as_min === B[i].start_as_min && x.end_as_min === B[i].end_as_min);
    };
    const rows = [];
    for (const s of cur.list) {
      if (s.off || s.start_as_min == null) continue;
      // 他店応援のシフトは対象外（別店のシフトに業務割振を付けると
      // 「対象の店舗…への出勤ではないシフト」400。実測: 岩永8/25 store73のF）。
      if (String(s.attending_store_id) !== String(cur.storeId)) continue;
      if (s.attending_genre_id !== 2 && s.attending_genre_id !== 3) continue;
      const segs = byUG[`${s.user_id}:${s.attending_genre_id}`];
      if (!segs) continue;
      // 原案の休憩（全バーから拾い重複除去）。タスクは休憩と重複できない（らくしふ制約）。
      const rseen = new Set();
      const dRests = [].concat(...segs.map((b) => b.rests || []))
        .filter((r) => Array.isArray(r) && r.length === 2 && r[1] > r[0]
          && !rseen.has(`${r[0]}-${r[1]}`) && rseen.add(`${r[0]}-${r[1]}`))
        .sort((a, b) => a[0] - b[0]);
      // 区間[s,e]をまず らくしふシフト範囲へ丸める（出勤前スタンバイ等シフト外は落とす＝400防止）、
      // その上で休憩区間を差し引く（休憩に食い込むタスクは分割・除去）。
      const clip = (s0, e0) => {
        let parts = [[Math.max(s0, s.start_as_min), Math.min(e0, s.end_as_min)]];
        for (const [rs, re] of dRests) {
          const nx = [];
          for (const [a, b] of parts) {
            if (re <= a || rs >= b) { nx.push([a, b]); continue; }
            if (rs > a) nx.push([a, Math.min(rs, b)]);
            if (re < b) nx.push([Math.max(re, a), b]);
          }
          parts = nx;
        }
        return parts.filter(([a, b]) => b > a);
      };
      // 休憩を「このバーの出勤範囲」でクリップ（範囲外は落とす・またぐ分は縮める）
      const clipRestToBar = (rests) => (rests || [])
        .map(([a, b]) => [Math.max(a, s.start_as_min), Math.min(b, s.end_as_min)])
        .filter(([a, b]) => b > a);
      // 原案の区間タスク一式（重ね対象のみ・休憩でクリップ）
      const want = [];
      for (const seg of segs) {
        const id = overlayId(seg, s.attending_genre_id);
        if (!id) continue;
        for (const [a, b] of clip(seg.s, seg.e)) want.push({ id, start_as_min: a, end_as_min: b });
      }
      const cur0 = (s.instructed_schedule_store_tasks || [])
        .map((t) => ({ id: t.store_task_id, start_as_min: t.start_time_as_min, end_as_min: t.end_time_as_min }))
        // CK(温度/日付/廃棄)は全域タグ側で扱うので区間比較から除外
        .filter((t) => ![CK_TASK.温度, CK_TASK.日付, CK_TASK.廃棄].includes(t.id));
      if (sameTasks(want, cur0)) continue;   // 既に一致
      if (!want.length && !cur0.length) continue;
      const label = (t) => `${taskMap[t.id] || t.id} ${hm(t.start_as_min)}-${hm(t.end_as_min)}`;
      rows.push({
        user_id: s.user_id, name: nameOf[s.user_id] || String(s.user_id),
        genre: g2label(s.attending_genre_id), genre_id: s.attending_genre_id,
        desc: want.length ? want.map(label).join(' / ') : '（区間タスクを消す）',
        // 休憩も原案の値で送る（タスクと整合）。ただし**このバーの出勤範囲でクリップ**する。
        // らくしふが同一(人,区分)を複数バーに割っていると、別バーの休憩が混入して
        // 「出勤時間外の休憩」400になるため（実測: 鎌田8/4・米川8/14/22・岩永8/19）。
        sched: { id: s.id,
          rest_times: restToApiObj(clipRestToBar(dRests.length ? dRests : apiRestToMin(s.rest_times))),
          store_tasks: want },
      });
    }
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    return { rows, storeId: cur.storeId };
  }

  async function renderTaskPlan() {
    const el = $('#reflect');
    el.className = 'reflect';
    el.innerHTML = '<span class="muted">中身(区間タスク)を計算中…</span>';
    let res;
    try { res = await buildTaskPlan(targetDate); }
    catch (e) { el.innerHTML = `<span class="err">失敗: ${esc(e.message)}</span>`; return; }
    taskRows = res.rows; taskStoreId = res.storeId;
    if (!taskRows.length) { el.innerHTML = '<span class="allok">✓ 中身も原案どおり（引く区間タスクなし）</span>'; return; }
    const rowHtml = (r, i) => `<div class="rrow" data-i="${i}">` +
      `<span class="rwho"><span class="dtag ${esc(r.genre)}" style="display:inline-block;width:20px;text-align:center;` +
      `border-radius:4px;color:#fff;font-size:10px">${esc(r.genre)}</span> ${esc(r.name)}</span>` +
      `<span class="rwhat" style="font-size:11px">${esc(r.desc)}</span><button class="tap" data-i="${i}">引く</button></div>`;
    el.innerHTML =
      '<div class="rf-warn">原案の<b>区間タスク（FK/TRer/TRee/ポジション）</b>をらくしふへ引きます。' +
      'そのシフトのタスクを丸ごと置き換えます（確定送信・削除はしません）。まず1人で試してください。</div>' +
      `<div class="rsum">引ける中身 ${taskRows.length}件</div>` +
      `<div style="margin:2px 0"><button id="taskAll">▶ ${taskRows.length}件をまとめて引く</button></div>` +
      taskRows.map(rowHtml).join('');
  }
  let taskStoreId = null;
  async function applyTaskRow(i) {
    const r = taskRows && taskRows[i];
    if (!r) return false;
    const token = rfCsrf();
    if (!token) { alert('CSRFトークンが取れません。ページをリロードしてください。'); return false; }
    const rowEl = $(`#reflect .rrow[data-i="${i}"]`);
    const btn = rowEl && rowEl.querySelector('.tap');
    if (btn) { btn.disabled = true; btn.textContent = '送信中'; }
    try {
      await taskAssignRequest(targetDate, taskStoreId, r.genre_id, r.sched, token);
      if (rowEl) rowEl.classList.add('done');
      if (btn) { btn.textContent = '✓ 引いた'; btn.disabled = true; }
      renderSheet();
      return true;
    } catch (e) {
      if (rowEl) rowEl.classList.add('err');
      if (btn) { btn.textContent = '再試行'; btn.disabled = false; }
      const w = rowEl && rowEl.querySelector('.rwhat'); if (w) w.textContent += `　→ 失敗: ${e.message}`;
      reportReflectFailure('中身', targetDate, r, e);
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
    const now = new Date();
    for (const selId of ['#draftMonth', '#reflectMonthSel']) {
      const sel = $(selId);
      for (let d = -1; d <= 3; d++) {
        const dt = new Date(now.getFullYear(), now.getMonth() + d, 1);
        const v = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
        const o = document.createElement('option');
        o.value = v; o.textContent = v; o.selected = (d === 1);
        sel.appendChild(o);
      }
    }
    // 反映スキャンは表示中の月を既定に
    const cm = `${targetDate.getFullYear()}-${pad2(targetDate.getMonth() + 1)}`;
    if ([...$('#reflectMonthSel').options].some((o) => o.value === cm)) $('#reflectMonthSel').value = cm;
    // 期間まとめての既定＝表示中の日から月末まで
    const rf = $('#rangeFrom'); const rt = $('#rangeTo');
    if (rf && rt) {
      const eom = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
      rf.value = ymd(targetDate);
      rt.value = ymd(eom);
    }
  }
  // 反映系の排他ロック。連打しても実行中は無視＝並行実行しない（本人指定）。
  let reflectBusy = false;
  const withReflectLock = async (fn) => {
    if (reflectBusy) return;
    reflectBusy = true;
    try { return await fn(); } finally { reflectBusy = false; }
  };
  // 反映(外枠/中身/CK)を実際に書き込んだら、少し置いてページをリロードする（本人指定）。
  // らくしふ本体の表示を確定後の状態へ更新し、パネルも一致状態に組み直すため。まとめて引く時は最後に1回。
  let reloadPending = false;
  const scheduleReload = (didWrite) => {
    if (!didWrite || reloadPending) return;
    reloadPending = true;
    setTimeout(() => location.reload(), 700);   // ✓表示を一瞬見せてから
  };
  $('#draftSend').addEventListener('click', sendWishes);
  $('#reflectPlan').addEventListener('click', () => withReflectLock(renderReflectPlan));
  $('#reflectMonthScan').addEventListener('click', () => withReflectLock(scanReflectMonth));
  $('#reflectMonth').addEventListener('click', (ev) => {
    if (ev.target.id === 'rmRun') { withReflectLock(runMonthReflect); return; }
    if (ev.target.id === 'rmAllToggle') {
      const cbs = [...$('#reflectMonth').querySelectorAll('.rm-cb')];
      const anyOn = cbs.some((c) => c.checked);
      cbs.forEach((c) => { c.checked = !anyOn; });
      ev.target.textContent = anyOn ? '全選択' : '全解除';
    }
  });
  $('#rangeRunAll').addEventListener('click', () => withReflectLock(runRangeAll));
  $('#memoLE').addEventListener('click', () => withReflectLock(runMemoLE));
  $('#taskMonthScan').addEventListener('click', () => withReflectLock(scanTaskMonth));
  $('#taskMonth').addEventListener('click', (ev) => {
    if (ev.target.id === 'tmRun') { withReflectLock(runTaskMonthReflect); return; }
    if (ev.target.id === 'tmAllToggle') {
      const cbs = [...$('#taskMonth').querySelectorAll('.tm-cb')];
      const anyOn = cbs.some((c) => c.checked);
      cbs.forEach((c) => { c.checked = !anyOn; });
      ev.target.textContent = anyOn ? '全選択' : '全解除';
    }
  });
  $('#rfCapBox').addEventListener('click', (ev) => {
    if (ev.target.id !== 'rfCapCopy') return;
    const ta = $('#rfCapBox textarea');
    if (!ta) return;
    ta.select();
    navigator.clipboard.writeText(ta.value).then(
      () => { ev.target.textContent = '✓ コピーした'; },
      () => { try { document.execCommand('copy'); ev.target.textContent = '✓ コピーした'; } catch { /* noop */ } });
  });
  $('#ckMonthScan').addEventListener('click', () => withReflectLock(scanCkMonth));
  $('#ckMonth').addEventListener('click', (ev) => {
    if (ev.target.id === 'ckmRun') { withReflectLock(runCkMonth); return; }
    if (ev.target.id === 'ckmAllToggle') {
      const cbs = [...$('#ckMonth').querySelectorAll('.ckm-cb')];
      const anyOn = cbs.some((c) => c.checked);
      cbs.forEach((c) => { c.checked = !anyOn; });
      ev.target.textContent = anyOn ? '全選択' : '全解除';
    }
  });
  // 反映セクションのクリック（差分1件 or 一括）。確定には触れない。
  $('#ckPlan').addEventListener('click', () => withReflectLock(renderCkPlan));
  $('#taskPlan').addEventListener('click', () => withReflectLock(renderTaskPlan));
  $('#reflect').addEventListener('click', async (ev) => {
    const tp = ev.target.closest('.tap');
    if (tp) { const i = +tp.dataset.i; const ok = await withReflectLock(() => applyTaskRow(i)); scheduleReload(ok); return; }
    if (ev.target.id === 'taskAll') {
      if (!confirm(`${taskRows.length}件の中身(区間タスク)をまとめて引きます。よろしいですか？`)) return;
      const btn = ev.target;
      const n = await withReflectLock(async () => {
        btn.disabled = true;
        let w = 0;
        for (let i = 0; i < taskRows.length; i++) { if (await applyTaskRow(i)) w += 1; }
        btn.textContent = '完了';
        return w;
      });
      scheduleReload(n);
      return;
    }
    const ck = ev.target.closest('.ckap');
    if (ck) { const i = +ck.dataset.i; const ok = await withReflectLock(() => applyCkRow(i)); scheduleReload(ok); return; }
    if (ev.target.id === 'ckAll') {
      const btn = ev.target;
      const n = await withReflectLock(async () => {
        btn.disabled = true;
        const targets = (ckRows || []).map((r, i) => ({ r, i })).filter((x) => x.r.bar && !x.r.already);
        let w = 0;
        for (const { i } of targets) { if (await applyCkRow(i)) w += 1; }
        btn.textContent = '完了';
        return w;
      });
      scheduleReload(n);
      return;
    }
    const one = ev.target.closest('.rap');
    if (one) { const i = +one.dataset.i; const ok = await withReflectLock(() => applyReflectRow(i)); scheduleReload(ok); return; }
    if (ev.target.id === 'reflectAll') {
      const btn = ev.target;
      const n = await withReflectLock(async () => {
        btn.disabled = true;
        const targets = (reflectRows || [])
          .map((r, i) => ({ r, i })).filter((x) => !x.r.manual && !x.r.applied);
        let w = 0;
        for (const { i } of targets) { if (await applyReflectRow(i)) w += 1; }   // 1件ずつ順に
        btn.textContent = '完了';
        return w;
      });
      scheduleReload(n);
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
