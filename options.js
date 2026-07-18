// 設定画面: chrome.storage.sync に保存。content.js の DEFAULTS とキーを揃えること。
const TEXT_FIELDS = ['leFieldName', 'tasksF', 'tasksK', 'tasksFK', 'tasksMgt',
                     'genresF', 'genresK', 'regularStaff'];
const NUM_FIELDS = ['fP2', 'fP1', 'fN1', 'fY', 'kP2', 'kP1', 'kN1', 'kY',
                    'totP2', 'totP1', 'totN1', 'totY',
                    'fkGap', 'fkThLe', 'fkCount', 'fkP2', 'fkP1', 'fkN1', 'fkY',
                    'fillTh', 'surplusWarn'];
const CHECK_FIELDS = ['showHeatbar', 'showReqRow', 'showWeekBadges'];
const FK_MODES = ['gap', 'th', 'ratio', 'off'];
const DEFAULTS = {
  leFieldName: '修正客数',
  fP2: '0', fP1: '30', fN1: '0', fY: '20',
  kP2: '0', kP1: '20', kN1: '0', kY: '20',
  totP2: '0', totP1: '50', totN1: '0', totY: '10',
  fkMode: 'gap', fkGap: '1', fkThLe: '60', fkCount: '1',
  fkP2: '0', fkP1: '0', fkN1: '0', fkY: '40',
  fixedTasks: '', genresF: '2', genresK: '3', regularStaff: '',
  fillTh: '1', surplusWarn: '2',
  tasksF: 'F', tasksK: 'K, BU*', tasksFK: 'FK', tasksMgt: 'MGT, TRer, TRee',
  showHeatbar: '1', showReqRow: '1', showWeekBadges: '1',
};

const $ = (id) => document.getElementById(id);

// ===== 固定作業の行エディタ =====
// 保存形式は content.js と同じテキスト（1行1件「名前 HH:MM-HH:MM F|K|FK 人数 [曜日]」）
// 曜日は 日月火水木金土 を連結。省略=毎日
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAYS_ORDER = ['月', '火', '水', '木', '金', '土', '日']; // 表示・保存の並び順
const pad2 = (n) => String(n).padStart(2, '0');
const toHHMM = (t) => { // "6:00"/"6" → time input用 "06:00"
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  return m ? `${pad2(m[1])}:${m[2] || '00'}` : '';
};

function parseFixedTasks(src) {
  return String(src || '').split('\n').map((line) => {
    const t = line.trim().split(/\s+/);
    if (t.length < 3) return null;
    const m = /^(.+?)[-〜~](.+)$/.exec(t[1]);
    if (!m) return null;
    const grp = (t[2] || '').toUpperCase();
    if (!['F', 'K', 'FK'].includes(grp)) return null;
    const days = (t[4] || '').split('').filter((ch) => WEEKDAYS.includes(ch));
    return { name: t[0], s: toHHMM(m[1]), e: toHHMM(m[2]), grp, n: t[3] || '1', days };
  }).filter(Boolean);
}

function addFixedRow(task = { name: '', s: '', e: '', grp: 'F', n: '1', days: [] }) {
  const div = document.createElement('div');
  div.className = 'fixed-row';
  const dayBtns = WEEKDAYS_ORDER.map((ch) =>
    `<label class="fx-day"><input type="checkbox" value="${ch}">${ch}</label>`).join('');
  div.innerHTML =
    `<div class="fx-main">` +
    `<input type="text" class="fx-name" placeholder="作業名（締め 等）">` +
    `<input type="time" class="fx-s" step="1800">` +
    `<span>〜</span>` +
    `<input type="time" class="fx-e" step="1800">` +
    `<select class="fx-grp">` +
    `  <option value="F">フロア</option>` +
    `  <option value="K">キッチン</option>` +
    `  <option value="FK">どちらでも</option>` +
    `</select>` +
    `<input type="number" class="fx-n" step="0.5" min="0.5" title="人数">` +
    `<span>人</span>` +
    `<button type="button" class="fx-del" title="この行を削除">✕ 削除</button>` +
    `</div>` +
    `<div class="fx-days"><span class="lbl">曜日</span>` +
    `<label class="fx-alldays"><input type="checkbox" class="fx-all">毎日</label>` +
    dayBtns + `</div>`;
  div.querySelector('.fx-name').value = task.name;
  div.querySelector('.fx-s').value = task.s;
  div.querySelector('.fx-e').value = task.e;
  div.querySelector('.fx-grp').value = task.grp;
  div.querySelector('.fx-n').value = task.n;
  div.querySelector('.fx-del').addEventListener('click', () => div.remove());

  // 曜日チェックの見た目・「毎日」連動
  const dayBoxes = [...div.querySelectorAll('.fx-day input')];
  const allBox = div.querySelector('.fx-all');
  const refresh = () => {
    dayBoxes.forEach((b) => b.closest('label').classList.toggle('on', b.checked));
    // 全曜日チェック or 全部未チェック（=毎日）のとき「毎日」をオン表示
    const allOn = dayBoxes.every((b) => b.checked);
    const noneOn = dayBoxes.every((b) => !b.checked);
    allBox.checked = allOn || noneOn;
    allBox.closest('label').classList.toggle('on', allBox.checked);
  };
  for (const b of dayBoxes) b.addEventListener('change', refresh);
  allBox.addEventListener('change', () => {
    // 「毎日」を押したら全曜日クリア（=毎日扱い）
    dayBoxes.forEach((b) => { b.checked = false; });
    refresh();
  });
  const set = new Set(task.days || []);
  if (set.size && set.size < 7) dayBoxes.forEach((b) => { b.checked = set.has(b.value); });
  refresh();
  $('fixedList').appendChild(div);
}

function serializeFixedTasks() {
  const rows = [];
  for (const row of document.querySelectorAll('#fixedList .fixed-row')) {
    const name = row.querySelector('.fx-name').value.trim().replace(/\s+/g, '_');
    const s = row.querySelector('.fx-s').value;
    const e = row.querySelector('.fx-e').value;
    const grp = row.querySelector('.fx-grp').value;
    const n = parseFloat(row.querySelector('.fx-n').value);
    if (!name || !s || !e) continue; // 未入力の行は保存しない
    const checked = [...row.querySelectorAll('.fx-day input')].filter((b) => b.checked).map((b) => b.value);
    // 0個 or 全曜日 = 毎日 → 曜日トークンを省略。それ以外は月〜日の順で連結
    const days = (checked.length === 0 || checked.length === 7)
      ? '' : WEEKDAYS_ORDER.filter((ch) => checked.includes(ch)).join('');
    rows.push({ s, line: `${name} ${s}-${e} ${grp} ${Number.isFinite(n) && n > 0 ? n : 1}${days ? ` ${days}` : ''}` });
  }
  // 保存時に開始時刻順で並べ替え
  rows.sort((a, b) => a.s.localeCompare(b.s));
  return rows.map((r) => r.line).join('\n');
}

$('addFixed').addEventListener('click', () => addFixedRow());

// ===== REQ FK 計算方法の切替（選択に応じてパラメータ欄を出し分け） =====
const fkModeValue = () =>
  document.querySelector('input[name="fkMode"]:checked')?.value || 'gap';
function updateFkVis() {
  const mode = fkModeValue();
  $('fkOptGap').style.display = mode === 'gap' ? '' : 'none';
  $('fkOptTh').style.display = mode === 'th' ? '' : 'none';
  $('fkOptRatio').style.display = mode === 'ratio' ? '' : 'none';
  $('fkCountWrap').style.display = (mode === 'gap' || mode === 'th') ? '' : 'none';
}
for (const r of document.querySelectorAll('input[name="fkMode"]')) {
  r.addEventListener('change', updateFkVis);
}

// ===== 読み込み・保存 =====
const fill = (cfg) => {
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) $(f).value = cfg[f] ?? '';
  for (const f of CHECK_FIELDS) $(f).checked = cfg[f] !== '0';
  const mode = FK_MODES.includes(cfg.fkMode) ? cfg.fkMode : 'gap';
  document.querySelector(`input[name="fkMode"][value="${mode}"]`).checked = true;
  updateFkVis();
  $('fixedList').innerHTML = '';
  parseFixedTasks(cfg.fixedTasks).forEach(addFixedRow);
};

chrome.storage.sync.get(DEFAULTS, fill);

$('save').addEventListener('click', () => {
  const status = $('status');
  const numOr = (id, d) => {
    const v = parseFloat($(id).value);
    return String(Number.isFinite(v) ? v : d);
  };
  const cfg = { fixedTasks: serializeFixedTasks() };
  for (const f of TEXT_FIELDS) cfg[f] = $(f).value.trim();
  cfg.leFieldName = cfg.leFieldName || '修正客数';
  cfg.genresF = cfg.genresF || '2';
  cfg.genresK = cfg.genresK || '3';
  for (const f of NUM_FIELDS) cfg[f] = numOr(f, DEFAULTS[f]);
  if (parseFloat(cfg.fY) < 1) cfg.fY = '1';
  if (parseFloat(cfg.kY) < 1) cfg.kY = '1';
  cfg.fkMode = fkModeValue();
  if (parseFloat(cfg.totY) < 0) cfg.totY = '0';
  if (parseFloat(cfg.fkGap) < 0.5) cfg.fkGap = '0.5';
  if (parseFloat(cfg.fkThLe) < 1) cfg.fkThLe = '1';
  if (parseFloat(cfg.fkCount) < 0.5) cfg.fkCount = '0.5';
  if (parseFloat(cfg.fkY) < 1) cfg.fkY = '1';

  if (parseFloat(cfg.fillTh) < 0) cfg.fillTh = '0';
  if (parseFloat(cfg.surplusWarn) < 0.5) cfg.surplusWarn = '0.5';
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked ? '1' : '0';
  chrome.storage.sync.set(cfg, () => {
    fill(cfg); // 補正後の値を反映して保存内容を見せる
    status.textContent = '保存しました。らくしふのページを再読み込みしてください';
    status.className = 'ok';
  });
});
