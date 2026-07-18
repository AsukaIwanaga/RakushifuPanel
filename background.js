// スプレッドシート取得は cross-origin なので service worker 側で行う。
// ブラウザの Google ログイン Cookie をそのまま使う（credentials: 'include'）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchSheetCsv') {
    const url =
      `https://docs.google.com/spreadsheets/d/${msg.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(msg.sheetName)}`;
    fetch(url, { credentials: 'include' })
      .then((r) => r.text().then((text) => sendResponse({ ok: r.ok, status: r.status, text })))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期で sendResponse するため
  }
});
