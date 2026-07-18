// スプレッドシート取得は cross-origin なので service worker 側で行う。
// ブラウザの Google ログイン Cookie をそのまま使う（credentials: 'include'）。
// WorkLogWebサーバ (Tailscaleアドレス限定バインド) への中継。
// content script からは mixed content で直接叩けないため SW 経由にする。
const SHIFT_API_BASE = 'http://100.103.183.30:8765';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'shiftApi') {
    fetch(SHIFT_API_BASE + msg.path, msg.payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload) }
      : {})
      .then((r) => r.json().then((data) => sendResponse({ ok: r.ok, data })))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'fetchSheetCsv') {
    // sheetName（シート名）か gid のどちらかで対象シートを指定
    const sel = msg.gid != null ? `gid=${msg.gid}` : `sheet=${encodeURIComponent(msg.sheetName)}`;
    const url =
      `https://docs.google.com/spreadsheets/d/${msg.sheetId}/gviz/tq?tqx=out:csv&${sel}`;
    fetch(url, { credentials: 'include' })
      .then((r) => r.text().then((text) => sendResponse({ ok: r.ok, status: r.status, text })))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期で sendResponse するため
  }
});
