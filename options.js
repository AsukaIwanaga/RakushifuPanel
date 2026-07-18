// 設定画面: chrome.storage.sync に保存。content.js の DEFAULTS とキーを揃えること。
const FIELDS = ['sheetId', 'taskSheetId', 'taskSheetGid', 'genresF', 'genresK', 'regularStaff'];
const DEFAULTS = { sheetId: '', taskSheetId: '', taskSheetGid: '0', genresF: '2', genresK: '3', regularStaff: '' };

const $ = (id) => document.getElementById(id);

// スプレッドシートのURLが貼られたらIDだけ取り出す
const toSheetId = (s) => {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return (m ? m[1] : s).trim();
};

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  for (const f of FIELDS) $(f).value = cfg[f] ?? '';
});

$('save').addEventListener('click', () => {
  const status = $('status');
  const cfg = {
    sheetId: toSheetId($('sheetId').value),
    taskSheetId: toSheetId($('taskSheetId').value),
    taskSheetGid: ($('taskSheetGid').value.trim() || '0'),
    genresF: $('genresF').value.trim() || '2',
    genresK: $('genresK').value.trim() || '3',
    regularStaff: $('regularStaff').value.trim(),
  };
  if (!cfg.sheetId) {
    status.textContent = '客数予測シートは必須です';
    status.className = 'err';
    return;
  }
  chrome.storage.sync.set(cfg, () => {
    // 抽出後のIDをフィールドに反映して保存内容を見せる
    for (const f of FIELDS) $(f).value = cfg[f];
    status.textContent = '保存しました。らくしふのページを再読み込みしてください';
    status.className = 'ok';
  });
});
