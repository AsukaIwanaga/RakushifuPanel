// 設定画面: chrome.storage.sync に保存。content.js の DEFAULTS とキーを揃えること。
const TEXT_FIELDS = ['leFieldName', 'sheetId', 'taskSheetId', 'taskSheetGid', 'genresF', 'genresK', 'regularStaff'];
const NUM_FIELDS = ['fP2', 'fP1', 'fN1', 'fY', 'kP2', 'kP1', 'kN1', 'kY'];
const DEFAULTS = {
  calcMode: 'rakushifu', leFieldName: '修正客数',
  fP2: '0', fP1: '50', fN1: '0', fY: '20',
  kP2: '0', kP1: '50', kN1: '0', kY: '20',
  sheetId: '', taskSheetId: '', taskSheetGid: '0',
  genresF: '2', genresK: '3', regularStaff: '',
};

const $ = (id) => document.getElementById(id);

// スプレッドシートのURLが貼られたらIDだけ取り出す
const toSheetId = (s) => {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return (m ? m[1] : s).trim();
};

const fill = (cfg) => {
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) $(f).value = cfg[f] ?? '';
  ($(cfg.calcMode === 'sheet' ? 'calcModeSheet' : 'calcModeRakushifu')).checked = true;
};

chrome.storage.sync.get(DEFAULTS, fill);

$('save').addEventListener('click', () => {
  const status = $('status');
  const numOr = (id, d) => {
    const v = parseFloat($(id).value);
    return String(Number.isFinite(v) ? v : d);
  };
  const cfg = {
    calcMode: $('calcModeSheet').checked ? 'sheet' : 'rakushifu',
    leFieldName: $('leFieldName').value.trim() || '修正客数',
    sheetId: toSheetId($('sheetId').value),
    taskSheetId: toSheetId($('taskSheetId').value),
    taskSheetGid: ($('taskSheetGid').value.trim() || '0'),
    genresF: $('genresF').value.trim() || '2',
    genresK: $('genresK').value.trim() || '3',
    regularStaff: $('regularStaff').value.trim(),
  };
  for (const f of NUM_FIELDS) cfg[f] = numOr(f, DEFAULTS[f]);
  if (parseFloat(cfg.fY) < 1) cfg.fY = '1';
  if (parseFloat(cfg.kY) < 1) cfg.kY = '1';
  if (cfg.calcMode === 'sheet' && !cfg.sheetId) {
    status.textContent = 'シート方式では客数予測シートが必須です';
    status.className = 'err';
    return;
  }
  chrome.storage.sync.set(cfg, () => {
    fill(cfg); // 抽出後のID・補正後の数値を反映して保存内容を見せる
    status.textContent = '保存しました。らくしふのページを再読み込みしてください';
    status.className = 'ok';
  });
});
