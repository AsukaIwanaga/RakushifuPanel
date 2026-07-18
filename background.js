// スプレッドシート取得は cross-origin なので service worker 側で行う。
// ブラウザの Google ログイン Cookie をそのまま使う（credentials: 'include'）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return;
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
