// 設定画面: chrome.storage.sync に保存。content.js の DEFAULTS とキーを揃えること。
const TEXT_FIELDS = ['leFieldName', 'genresF', 'genresK', 'regularStaff'];
const NUM_FIELDS = ['fP2', 'fP1', 'fN1', 'fY', 'kP2', 'kP1', 'kN1', 'kY'];
const DEFAULTS = {
  leFieldName: '修正客数',
  fP2: '0', fP1: '50', fN1: '0', fY: '20',
  kP2: '0', kP1: '50', kN1: '0', kY: '20',
  genresF: '2', genresK: '3', regularStaff: '',
};

const $ = (id) => document.getElementById(id);

const fill = (cfg) => {
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) $(f).value = cfg[f] ?? '';
};

chrome.storage.sync.get(DEFAULTS, fill);

$('save').addEventListener('click', () => {
  const status = $('status');
  const numOr = (id, d) => {
    const v = parseFloat($(id).value);
    return String(Number.isFinite(v) ? v : d);
  };
  const cfg = {
    leFieldName: $('leFieldName').value.trim() || '修正客数',
    genresF: $('genresF').value.trim() || '2',
    genresK: $('genresK').value.trim() || '3',
    regularStaff: $('regularStaff').value.trim(),
  };
  for (const f of NUM_FIELDS) cfg[f] = numOr(f, DEFAULTS[f]);
  if (parseFloat(cfg.fY) < 1) cfg.fY = '1';
  if (parseFloat(cfg.kY) < 1) cfg.kY = '1';
  chrome.storage.sync.set(cfg, () => {
    fill(cfg); // 補正後の数値を反映して保存内容を見せる
    status.textContent = '保存しました。らくしふのページを再読み込みしてください';
    status.className = 'ok';
  });
});
