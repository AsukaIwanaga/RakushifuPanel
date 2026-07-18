// 設定画面: chrome.storage.sync に保存。content.js の DEFAULTS とキーを揃えること。
const TEXT_FIELDS = ['leFieldName', 'fixedTasks', 'tasksF', 'tasksK', 'tasksFK', 'tasksMgt',
                     'genresF', 'genresK', 'regularStaff'];
const NUM_FIELDS = ['fP2', 'fP1', 'fN1', 'fY', 'kP2', 'kP1', 'kN1', 'kY', 'fillTh', 'surplusWarn'];
const CHECK_FIELDS = ['showHeatbar', 'showReqRow', 'showWeekBadges'];
const DEFAULTS = {
  leFieldName: '修正客数',
  fP2: '0', fP1: '50', fN1: '0', fY: '20',
  kP2: '0', kP1: '50', kN1: '0', kY: '20',
  fixedTasks: '', genresF: '2', genresK: '3', regularStaff: '',
  fillTh: '1', surplusWarn: '2',
  tasksF: 'F', tasksK: 'K, BU*', tasksFK: 'FK', tasksMgt: 'MGT, TRer, TRee',
  showHeatbar: '1', showReqRow: '1', showWeekBadges: '1',
};

const $ = (id) => document.getElementById(id);

const fill = (cfg) => {
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) $(f).value = cfg[f] ?? '';
  for (const f of CHECK_FIELDS) $(f).checked = cfg[f] !== '0';
};

chrome.storage.sync.get(DEFAULTS, fill);

$('save').addEventListener('click', () => {
  const status = $('status');
  const numOr = (id, d) => {
    const v = parseFloat($(id).value);
    return String(Number.isFinite(v) ? v : d);
  };
  const cfg = {};
  for (const f of TEXT_FIELDS) cfg[f] = $(f).value.trim();
  cfg.leFieldName = cfg.leFieldName || '修正客数';
  cfg.genresF = cfg.genresF || '2';
  cfg.genresK = cfg.genresK || '3';
  for (const f of NUM_FIELDS) cfg[f] = numOr(f, DEFAULTS[f]);
  if (parseFloat(cfg.fY) < 1) cfg.fY = '1';
  if (parseFloat(cfg.kY) < 1) cfg.kY = '1';
  if (parseFloat(cfg.fillTh) < 0) cfg.fillTh = '0';
  if (parseFloat(cfg.surplusWarn) < 0.5) cfg.surplusWarn = '0.5';
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked ? '1' : '0';
  chrome.storage.sync.set(cfg, () => {
    fill(cfg); // 補正後の値を反映して保存内容を見せる
    status.textContent = '保存しました。らくしふのページを再読み込みしてください';
    status.className = 'ok';
  });
});
