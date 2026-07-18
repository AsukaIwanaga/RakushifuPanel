// らくしふ 客数予測パネル（配布版）
// - LE = らくしふの「修正客数」、REQ = 負担率モデルで計算（外部サービス連携なし）
// - シフト確定 未処理日を今日〜月末で監視
// - 店舗ごとの値（計算係数・genre分類・正社員名）は設定画面から (chrome.storage.sync)

(async () => {
  'use strict';

  // ===== 設定 =====
  // 店舗固有の値はハードコードせず設定画面で入力する。ここはキーとデフォルトのみ。
  const DEFAULTS = {
    leFieldName: '修正客数', // らくしふカスタム指標のフィールド名（会社により異なる場合に変更）
    fP2: '0', fP1: '30', fN1: '0', fY: '20', // フロア: 二時間前%/一時間前%/一時間後%/客数◯名につき1人
    kP2: '0', kP1: '20', kN1: '0', kY: '20', // キッチン: 同上
    totP2: '0', totP1: '50', totN1: '0', totY: '10', // 全体(FK判定・差方式で使用)
    fkMode: 'gap',     // REQ FKの計算方法: off|gap(全体との差)|th(客数しきい値)|ratio(客数比例)
    fkGap: '1',        // gap: 全体REQ−(F+K) がこれ以上の時間帯にFKを立てる
    fkThLe: '60',      // th: 時間帯の修正客数がこれ以上でFKを立てる
    fkCount: '1',      // gap/th: 立てる人数
    fkP2: '0', fkP1: '0', fkN1: '0', fkY: '40', // ratio: FK専用の係数
    fixedTasks: '',    // 固定作業: 1行1件「名前 開始-終了 F|K|FK 人数」(例: 締め 21:30-23:00 K 1)
    genresF: '2',      // フロアの genre_id（カンマ区切り可）
    genresK: '3',      // キッチンの genre_id（カンマ区切り可）
    regularStaff: '',  // 正社員名（カンマ/改行区切り）
    fillTh: '1',       // 塗りつぶし境界: |差分|がこれ以上で赤/緑の塗りつぶし表示
    surplusWarn: '2',  // 過剰警告: 余剰がこれ以上で緑塗りつぶし
    tasksF: 'F',                    // F振替とみなす業務割振タスク名（カンマ区切り・末尾*で前方一致）
    tasksK: 'K, BU*',               // K振替とみなすタスク名
    tasksFK: 'FK',                  // FK振替とみなすタスク名
    tasksMgt: 'MGT, TRer, TRee',    // OP外(MGT/cMGT)とみなすタスク名
    showHeatbar: '1',   // 画面上のヒートバー
    showReqRow: '1',    // OP全体必要人数行の注入
    showWeekBadges: '1', // 週間アサインバッジ
  };
  const cfg = await new Promise((resolve) => {
    try { chrome.storage.sync.get(DEFAULTS, (v) => resolve(v || { ...DEFAULTS })); }
    catch { resolve({ ...DEFAULTS }); }
  });
  const csvInts = (s) => String(s || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const csvNames = (s) => String(s || '').split(/[,、\n]/).map((x) => x.replace(/\s+/g, '')).filter(Boolean);

  const LE_FIELD = String(cfg.leFieldName || '').trim() || '修正客数';
  const numOr = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  // 負担率モデルの係数（F/K別）: load = LE + p1%×1h前 + p2%×2h前 + n1%×1h後、REQ = load / y
  const LOAD = {
    F: { p2: numOr(cfg.fP2, 0), p1: numOr(cfg.fP1, 30), n1: numOr(cfg.fN1, 0), y: Math.max(1, numOr(cfg.fY, 20)) },
    K: { p2: numOr(cfg.kP2, 0), p1: numOr(cfg.kP1, 20), n1: numOr(cfg.kN1, 0), y: Math.max(1, numOr(cfg.kY, 20)) },
    // 全体: FK判定(差方式)用の独立計算
    T: { p2: numOr(cfg.totP2, 0), p1: numOr(cfg.totP1, 50), n1: numOr(cfg.totN1, 0), y: Math.max(0, numOr(cfg.totY, 10)) },
    // FK比例方式用の係数
    FK: { p2: numOr(cfg.fkP2, 0), p1: numOr(cfg.fkP1, 0), n1: numOr(cfg.fkN1, 0), y: Math.max(0, numOr(cfg.fkY, 40)) },
  };
  // REQ FKの計算方法（設定で切替）: off / gap(全体との差) / th(客数しきい値) / ratio(客数比例)
  const FK_MODE = ['off', 'gap', 'th', 'ratio'].includes(cfg.fkMode) ? cfg.fkMode : 'gap';
  const FK_GAP = Math.max(0.1, numOr(cfg.fkGap, 1));     // gap: この差以上で立てる
  const FK_TH_LE = Math.max(1, numOr(cfg.fkThLe, 60));   // th: この客数以上で立てる
  const FK_COUNT = Math.max(0.5, numOr(cfg.fkCount, 1)); // gap/th: 立てる人数
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6:00 - 23:00

  // 固定作業（客数に依らない必要人数）: 「名前 開始-終了 F|K|FK 人数 [曜日]」を1行1件でパース
  // 曜日は 日月火水木金土 を連結（例 月火水木金）。省略=毎日
  const parseClock = (t) => {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
    return m ? (+m[1]) * 60 + (+(m[2] || 0)) : null;
  };
  const WD_INDEX = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
  const parseDays = (tok) => {
    if (!tok) return null; // null = 毎日
    const set = new Set();
    for (const ch of tok) if (ch in WD_INDEX) set.add(WD_INDEX[ch]);
    return set.size ? set : null;
  };
  const FIXED = String(cfg.fixedTasks || '').split('\n').map((line) => {
    const t = line.trim().split(/\s+/);
    if (t.length < 3) return null;
    const m = /^(.+?)[-〜~](.+)$/.exec(t[1]);
    if (!m) return null;
    const s = parseClock(m[1]), e = parseClock(m[2]);
    const grp = (t[2] || '').toUpperCase();
    const n = t[3] !== undefined ? parseFloat(t[3]) : 1;
    if (s == null || e == null || e <= s || !['F', 'K', 'FK'].includes(grp) || !Number.isFinite(n) || n <= 0) return null;
    return { name: t[0], s, e, grp, n, days: parseDays(t[4]) };
  }).filter(Boolean);

  // パネルの表示行（キーは hourly オブジェクトの行キー）
  const HOURLY_COLS = [
    { rowLabel: 'LE',        head: LE_FIELD, cls: 'le' }, // 行名は客数フィールド名そのまま（配布用に分かりやすく）
    { rowLabel: 'REQ（F）',   head: 'REQ F',  cls: '' },
    { rowLabel: 'REQ（K）',   head: 'REQ K',  cls: '' },
    { rowLabel: 'REQ（SUM）', head: 'REQ計',  cls: 'sum' },
  ];
  // らくしふ実シフトの genre_id → F/K 分類（例: 2=フロア, 3=キッチン）。
  // ここに無い genre（社員・未使用枠など）はクルーREQの比較対象外
  const GENRES_F = csvInts(cfg.genresF);
  const GENRES_K = csvInts(cfg.genresK);
  // 正社員（この人のMGT/TRer/TRee時間は MGT H、その他の人のは CREW MGT H に計上）
  const REGULAR_STAFF = csvNames(cfg.regularStaff);
  // 塗りつぶし境界（|差分|がこれ未満は白地に色文字）と過剰警告のしきい値
  const FILL_TH = Math.max(0, numOr(cfg.fillTh, 1));
  const SURPLUS_WARN = Math.max(0.1, numOr(cfg.surplusWarn, 2));
  // ビューのON/OFF
  const SHOW = {
    heatbar: cfg.showHeatbar !== '0',
    reqRow: cfg.showReqRow !== '0',
    weekBadges: cfg.showWeekBadges !== '0',
  };
  // 業務割振タスク名 → カウント先（設定で変更可）。F/K/FK=振替、
  // Mgt系=OP Hに数えず MGT系へ（正社員→MGT、その他→cMGT）。末尾*は前方一致
  const taskMatcher = (src) => {
    const exact = new Set(), prefixes = [];
    for (const n of String(src || '').split(/[,、\n]/).map((x) => x.trim()).filter(Boolean)) {
      if (n.endsWith('*')) prefixes.push(n.slice(0, -1)); else exact.add(n);
    }
    return (name) => !!name && (exact.has(name) || prefixes.some((p) => p && name.startsWith(p)));
  };
  const isTaskF = taskMatcher(cfg.tasksF), isTaskK = taskMatcher(cfg.tasksK);
  const isTaskFK = taskMatcher(cfg.tasksFK), isTaskMgt = taskMatcher(cfg.tasksMgt);
  const moveGroup = (name, isRegular) => {
    if (isTaskF(name)) return 'F';
    if (isTaskK(name)) return 'K';
    if (isTaskFK(name)) return 'FK';
    if (isTaskMgt(name)) return isRegular ? 'MGT' : 'cMGT';
    return null;
  };
  const CONFIRM_POLL_MS = 5 * 60 * 1000; // 未確定チェックの間隔
  const URL_WATCH_MS = 1500;

  // ===== ユーティリティ =====
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseYmd = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
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
    $('#unconfirmed').innerHTML = '';
  }

  // ===== らくしふ客数方式: カスタム指標（修正客数など）→ LE/REQ 計算 =====
  // /typed/api/admin/metrics/custom_fields が name/term_mode:hour で時間帯別値を返す
  // (2026-07-18 実機検証済み。IDは会社依存のため名前でマッチ)
  let custFieldCache = {}; // ymd -> {フィールド名: {total, at(min)}}
  async function fetchCustomerFields(date) {
    const key = ymd(date);
    if (custFieldCache[key]) return custFieldCache[key];
    const p = new URLSearchParams(location.search);
    const storeId = p.get('s');
    if (!storeId) throw new Error('store_id 不明（URLに s= がありません）');
    // store_scope の指標なので genre はどれでも同値。表示中の先頭 genre を使う
    const genreId = p.getAll('g')[0] || String([...GENRES_F, ...GENRES_K][0] ?? 2);
    const q = new URLSearchParams({
      store_id: storeId, genre_id: genreId, from: key, to: key, display_mode: 'day',
    });
    const r = await fetch('/typed/api/admin/metrics/custom_fields?' + q, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`客数API HTTP ${r.status}`);
    const j = await r.json();
    const fields = {};
    for (const f of j.results || []) {
      const v = (f.values || [])[0];
      const map = {};
      for (const b of v?.breakdowns || []) {
        if (Number.isFinite(b.value)) map[b.start_minutes] = b.value;
      }
      fields[(f.name || '').trim()] = {
        total: v && v.value != null ? v.value : null,
        at: (min) => map[min] || 0,
      };
    }
    custFieldCache[key] = fields;
    return fields;
  }

  // 負担込み客数 = LE[h] + p1%×LE[h-1] + p2%×LE[h-2] + n1%×LE[h+1]、REQ = ÷y (小数1桁)
  function buildComputedHourly(fields, weekday) {
    // 対象日の曜日に該当する固定作業だけ（days=null は毎日）
    const activeFixed = FIXED.filter((t) => !t.days || t.days.has(weekday));
    const le = fields[LE_FIELD];
    if (!le) {
      console.warn('[客数予測パネル] 客数フィールドが見つかりません。利用可能:', Object.keys(fields));
      throw new Error(`「${LE_FIELD}」フィールドが見つかりません（設定で名前を確認）`);
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    const at = (h) => le.at(h * 60); // breakdowns は 6:00(360)〜30:00 の分キー・範囲外は0
    const req = (c) => HOURS.map((h) =>
      r1((at(h) + c.p1 / 100 * at(h - 1) + c.p2 / 100 * at(h - 2) + c.n1 / 100 * at(h + 1)) / c.y));
    const reqF = req(LOAD.F), reqK = req(LOAD.K);
    // REQ FK: 設定されたモードで算出
    let reqFK = null;
    if (FK_MODE === 'gap' && LOAD.T.y > 0) {
      // 全体REQ(独立計算)に対して F+K の合計が FK_GAP 人以上下回る時間帯に FK_COUNT 人
      const reqTot = req(LOAD.T);
      reqFK = HOURS.map((_, i) =>
        (reqTot[i] - (reqF[i] + reqK[i]) >= FK_GAP - 1e-9 ? FK_COUNT : 0));
    } else if (FK_MODE === 'th') {
      // 時間帯の修正客数が FK_TH_LE 名以上なら FK_COUNT 人
      reqFK = HOURS.map((h_, i) => (at(HOURS[i]) >= FK_TH_LE ? FK_COUNT : 0));
    } else if (FK_MODE === 'ratio' && LOAD.FK.y > 0) {
      // F/Kと同じ負担込み客数÷y
      reqFK = req(LOAD.FK);
    }
    const reqSum = HOURS.map((_, i) => r1(reqF[i] + reqK[i] + (reqFK ? reqFK[i] : 0)));
    // 行キーごとの {hours[], total} に詰めて描画側へ（0は空欄表示）
    const mk = (arr, total) => ({
      hours: arr.map((v) => (v === 0 ? '' : String(v))),
      total: total != null ? String(total) : String(r1(arr.reduce((a, b) => a + b, 0))),
    });
    const hourly = {
      'LE': mk(HOURS.map(at), le.total),
      'REQ（F）': mk(reqF),
      'REQ（K）': mk(reqK),
      'REQ（SUM）': mk(reqSum),
    };
    if (reqFK) hourly['REQ（FK）'] = mk(reqFK);
    // 固定作業を上乗せした「必要」行（判定はこちらを使う）。部分時間は比例配分
    if (activeFixed.length || reqFK) {
      const fF = HOURS.map(() => 0), fK = HOURS.map(() => 0), fFK = HOURS.map(() => 0);
      for (const t of activeFixed) {
        HOURS.forEach((h, i) => {
          const ov = Math.max(0, Math.min(t.e, h * 60 + 60) - Math.max(t.s, h * 60)) / 60;
          if (ov <= 0) return;
          const v = t.n * ov;
          if (t.grp === 'F') fF[i] += v;
          else if (t.grp === 'K') fK[i] += v;
          else fFK[i] += v; // FK=どちらのグループでも可 → 合計必要にのみ加算
        });
      }
      if (activeFixed.length) {
        hourly['FIXED'] = mk(HOURS.map((_, i) => r1(fF[i] + fK[i] + fFK[i])));
      }
      hourly['NEED（F）'] = mk(HOURS.map((_, i) => r1(reqF[i] + fF[i])));
      hourly['NEED（K）'] = mk(HOURS.map((_, i) => r1(reqK[i] + fK[i])));
      // 必要FK = 客数ベースREQ FK + FK固定作業（どちらでも人員の必要数）
      const needFK = HOURS.map((_, i) => r1((reqFK ? reqFK[i] : 0) + fFK[i]));
      if (needFK.some((v) => v > 0)) hourly['NEED（FK）'] = mk(needFK);
      hourly['NEED（SUM）'] = mk(HOURS.map((_, i) => r1(reqSum[i] + fF[i] + fK[i] + fFK[i])));
    }
    const chips = [];
    if (le.total != null) chips.push([LE_FIELD + '計', le.total]);
    const py = fields['前年客数'];
    if (py && py.total) {
      chips.push(['前年客数計', py.total]);
      if (le.total != null) chips.push(['前年比', `${r1((le.total / py.total) * 100)}%`]);
    }
    return { hourly, chips };
  }

  async function fetchComputed(date) {
    try {
      return buildComputedHourly(await fetchCustomerFields(date), date.getDay());
    } catch (e) {
      return { error: e.message };
    }
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
    const fallbackGenres = [...GENRES_F, ...GENRES_K].map(String);
    for (const g of (genreIds.length ? genreIds : fallbackGenres)) q.append('genre_ids[]', g);
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
  // 印刷時は週間アサインバッジを出さない（シフト表の印刷を汚さない）
  const printStyle = document.createElement('style');
  printStyle.textContent = '@media print { .rf-week-badge { display: none !important; } }';
  document.documentElement.appendChild(printStyle);
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
      .unconfirmed { display: flex; flex-wrap: wrap; gap: 4px; }
      .unconfirmed .day {
        background: #fdecec; color: #b02a2a; border: 1px solid #e8b4b4;
        border-radius: 5px; padding: 2px 7px;
      }
      .allok { color: #2c6e49; font-weight: 600; }
      .err { color: #b02a2a; }
      .muted { color: #888; font-size: 12px; }
    </style>
    <button id="toggle" title="客数予測パネル">📊<span class="badge" id="badge"></span></button>
    <div id="panel">
      <div class="nav">
        <b id="dateLabel">-</b>
        <button id="reload" class="accent">更新</button>
        <button id="openOpts" title="設定（負担率・係数など）">設定</button>
      </div>
      <div id="stats" class="stats"></div>
      <div id="tableWrap"></div>
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

  // 対象日はらくしふURLの from= に追従（パネル独自の日付移動は廃止）
  $('#reload').addEventListener('click', () => {
    custFieldCache = {};   // 修正客数も再取得
    renderSheet();
    renderUnconfirmed();
  });
  $('#openOpts').addEventListener('click', () => {
    if (!alive()) return contextLost();
    try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch {}
  });

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
    const wkFallback = [...GENRES_F, ...GENRES_K].map(String);
    for (const g of (p.getAll('g').length ? p.getAll('g') : wkFallback)) q.append('genre_ids[]', g);
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
        b.style.cssText = 'display:inline-block;margin-left:4px;font:700 10px/12px -apple-system,"Hiragino Sans",sans-serif;' +
          'color:#2c6e49;background:#eef4f0;border-radius:4px;padding:2px 4px;white-space:nowrap;flex:none;text-align:center;';
        nameEl.after(b);
      }
      // 上段: 週N日/Nh、下段: 出勤曜日（月〜日の並び）
      const dayChars = [...st.days].sort()
        .map((ds) => WEEKDAYS[(parseYmd(ds) || new Date()).getDay()]).join('');
      b.innerHTML = `週${st.days.size}日/${Math.round(st.mins / 6) / 10}h` +
        `<br><span style="font-weight:600;color:#4a7a5f;">${dayChars}</span>`;
      b.title = `この週(月〜日)のアサイン合計（休憩控除後・ヘルプ含む）`;
    }
  }

  // ===== らくしふ画面上の不足ヒートバー（フロア/キッチン別） =====
  // 各セクションの時間軸ヘッダー(.time-header)直下に、そのセクションの 実−REQ を行として差し込む。
  // フロアセクション=F、キッチンセクション=K。不足=赤、SURPLUS_WARN以上のプラス=オレンジ(浪費警告)。
  // 表示中の日とパネルの対象日が一致するOneDayのときだけ出す。
  let lastStrip = null; // {catDiffs, tip} Vue再描画後の張り直し用
  let lastReq = null;
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
          // |差分|<FILL_TH は軽微 → 塗りつぶさず白地に色文字。それ以上は塗りつぶしで強調
          if (d < 0) {
            cell.textContent = d;
            cell.style.cssText += d > -FILL_TH
              ? 'color:#d64545;'
              : 'background:#d64545;color:#fff;border-radius:3px;';
          } else if (d >= SURPLUS_WARN) {
            cell.textContent = `+${d}`;
            cell.style.cssText += 'background:#2e9e5b;color:#fff;border-radius:3px;';
          } else if (d > 0 && d < FILL_TH) {
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

  // ===== 修正客数行の下に必要人数行を注入（セクション別・v1.11.0移植） =====
  // フロアセクション=必要F(+必要FK) / キッチン=必要K(+必要FK)。FKは両方に重複表示。
  // reqPack = {f, k, fk?, sum} 各{hours[], total}（固定作業があれば固定込みのNEED値）
  function updateReqRows(reqPack) {
    document.querySelectorAll('.rf-req-row').forEach((e) => e.remove());
    lastReq = reqPack || null;
    if (!reqPack || !onOneDayTarget()) return;
    const labels = [...document.querySelectorAll('th.metrics-row-header')]
      .filter((th) => (th.textContent || '').includes(LE_FIELD));
    for (const th of labels) {
      const tr = th.closest('tr');
      if (!tr) continue;
      // 修正客数行のクローンにラベルと値を差し替えた行を作る
      const mkRow = (labelHtml, vals, color, tipFn) => {
        const clone = tr.cloneNode(true);
        clone.classList.add('rf-req-row');
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
      const sec = sectionOf(tr);
      let anchor = tr;
      const tipSum = reqPack.sum ? (i) => `必要計 ${reqPack.sum.hours[i] || '0'}` : null;
      const addReq = (label, row, color) => {
        if (!row) return;
        const r = mkRow(
          `<span style="font-weight:700;color:${color};">${label} (合計: ${row.total || '-'})</span>`,
          row.hours, color, tipSum);
        anchor.after(r);
        anchor = r;
      };
      if (sec === 'キッチン') {
        addReq('必要K', reqPack.k, '#2c6e49');
        addReq('必要FK', reqPack.fk, '#0e7490');
      } else if (sec === 'フロア') {
        addReq('必要F', reqPack.f, '#2c6e49');
        addReq('必要FK', reqPack.fk, '#0e7490');
      } else {
        addReq('OP全体必要人数', reqPack.sum, '#2c6e49'); // セクション判別不能時は計を出す
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
      custFieldCache = {}; // 画面での修正客数編集も拾う
      renderSheet();
    }, 800);
  });

  async function renderSheet() {
    $('#dateLabel').textContent =
      `${targetDate.getMonth() + 1}/${targetDate.getDate()} (${WEEKDAYS[targetDate.getDay()]})`;
    $('#stats').innerHTML = '<span class="muted">読込中…</span>';
    $('#tableWrap').innerHTML = '';

    const [res, actual] = await Promise.all([
      fetchComputed(targetDate),
      fetchActual(targetDate).catch((e) => ({ error: e.message })),
    ]);
    if (res.error) {
      $('#stats').innerHTML = `<span class="err">${res.error}</span>`;
      updateStrips(null);
      updateReqRows(null);
      return;
    }
    const hourly = res.hourly;
    $('#stats').innerHTML = (res.chips || [])
      .map(([l, v]) => `<span class="chip">${l} <b>${v}</b></span>`)
      .join('') || '<span class="muted">客数データなし</span>';

    // 時間を横軸に: 列 = 6:00〜23:00 + 計、行 = LE / REQ F / REQ K / REQ計
    const nowHour = new Date().getHours();
    const isToday = ymd(targetDate) === ymd(new Date());
    const nowCls = (h) => (isToday && h === nowHour ? ' now' : '');

    // 実人数 (らくしふ現シフト・休憩控除済) と必要人数の比較。マイナス＝不足
    // 固定作業があれば NEED（REQ+固定）を判定に使う。無ければ NEED=REQ
    const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
    const reqF = hourly['REQ（F）'], reqK = hourly['REQ（K）'];
    const needF = hourly['NEED（F）'] || reqF, needK = hourly['NEED（K）'] || reqK;
    const needFK = hourly['NEED（FK）'] || hourly['REQ（FK）'] || null;
    const req = hourly['NEED（SUM）'] || hourly['REQ（SUM）'];
    const hasActual = actual && !actual.error;
    const diffs = (hasActual && req)
      ? HOURS.map((h, i) => {
          if (!req.hours[i] && !actual.total[i]) return null; // 必要も実人数も無い時間帯は営業時間外
          return Math.round((actual.total[i] - num(req.hours[i])) * 10) / 10;
        })
      : null;
    // 時刻ヘッダーの赤塗りは不足FILL_TH以上のみ（軽微な不足では騒がない）
    const shortAt = (i) => diffs && diffs[i] !== null && diffs[i] <= -FILL_TH;

    const headRow =
      `<tr><th class="row-head"></th>` +
      HOURS.map((h, i) =>
        `<th class="${nowCls(h)}${shortAt(i) ? ' short-mark' : ''}">${h}</th>`).join('') +
      `<th class="total">計</th></tr>`;

    const cols = [...HOURLY_COLS];
    if (hourly['REQ（FK）']) { // REQ計 の直前に挿入
      cols.splice(cols.findIndex((c) => c.rowLabel === 'REQ（SUM）'), 0,
        { rowLabel: 'REQ（FK）', head: 'REQ FK', cls: '' });
    }
    if (hourly['FIXED']) { // 固定がある時だけ固定/必要計行（無ければ必要計=REQ計で重複するため）
      cols.push({ rowLabel: 'FIXED', head: '固定', cls: '' },
                { rowLabel: 'NEED（SUM）', head: '必要計', cls: 'sum' });
    }
    const bodyRows = cols.map((c) => {
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
        actRow(actual.F, needF, '実F', actual.sum.F, ' act-first') +
        actRow(actual.K, needK, '実K', actual.sum.K) +
        actRow(actual.FK, needFK, '実FK', actual.sum.FK) + // 必要FK(REQ FK+固定FK)を下回れば赤
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
            ? (d > -FILL_TH ? ' short-lite' : ' short')
            : d >= SURPLUS_WARN ? ' over'
            : (d > 0 && d < FILL_TH) ? ' over-lite' : '';
          return `<td class="${nowCls(h)}${cls}">${txt}</td>`;
        }).join('');
        const totalD = Math.round((actual.sum.total - num(req?.total)) * 10) / 10;
        diffRow = `<tr class="diff"><td class="row-head">不足</td>${cells}` +
          `<td class="total${totalD < 0 ? ' short' : ''}">${totalD < 0 ? totalD : `+${totalD}`}</td></tr>`;
      }
    }

    $('#tableWrap').innerHTML = `<table>${headRow}${bodyRows}${actualRows}${diffRow}</table>` +
      (actual?.error ? `<div class="err">実人数取得失敗: ${actual.error}</div>` : '');
    // 画面上のヒートバー: F/K別の差分（計はツールチップで見せる）
    const mkDiff = (arr, reqRow) => (hasActual && arr) ? HOURS.map((h, i) => {
      if (!reqRow?.hours?.[i] && !arr[i]) return null;
      return Math.round((arr[i] - num(reqRow?.hours?.[i])) * 10) / 10;
    }) : null;
    const catDiffs = hasActual ? {
      F: mkDiff(actual.F, needF), K: mkDiff(actual.K, needK),
    } : null;
    const tip = (i) =>
      `${HOURS[i]}時  F ${actual?.F?.[i] ?? '-'}/${needF?.hours?.[i] || '0'}` +
      ` ・ K ${actual?.K?.[i] ?? '-'}/${needK?.hours?.[i] || '0'}` +
      ` ・ FK ${actual?.FK?.[i] ?? '-'}${needFK ? `/${needFK.hours[i] || '0'}` : ''}` +
      ` ・ 計 ${actual?.total?.[i] ?? '-'}/${req?.hours?.[i] || '0'} (実/必要)`;
    updateStrips(SHOW.heatbar ? catDiffs : null, tip);
    // 画面の客数行の下に必要人数行をセクション別に注入（フロア=必要F+FK / キッチン=必要K+FK）
    updateReqRows((SHOW.reqRow && req && needF && needK)
      ? { f: needF, k: needK, fk: needFK, sum: req }
      : null);
    // 週間アサインバッジ（非同期・失敗しても本体表示に影響させない）
    if (SHOW.weekBadges) {
      fetchWeekStats(targetDate)
        .then((per) => { lastWeekStats = per; updateWeekBadges(per); })
        .catch(() => {});
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

  // 設定変更を検知して知らせる。自動リロードはしない（シフト編集中のデータ保護）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !Object.keys(changes).some((k) => k in DEFAULTS)) return;
      $('#stats').innerHTML =
        '<span class="err">設定が変更されました。ページを再読み込みすると反映されます</span>';
    });
  } catch {}

  // URL変化 (日付移動・ビュー切替) を監視してパネルの対象日を追従
  timers.push(setInterval(() => {
    if (!alive()) return contextLost();
    // Vueの再描画でバッジ/バー/必要人数行が消えた場合の張り直し（軽量）
    if (lastWeekStats) updateWeekBadges(lastWeekStats);
    if (lastStrip && !document.querySelector('.rf-heat-strip')) updateStrips(lastStrip.catDiffs, lastStrip.tip);
    if (lastReq && !document.querySelector('.rf-req-row')) updateReqRows(lastReq);
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
