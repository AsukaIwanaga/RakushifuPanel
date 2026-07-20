// スプレッドシート取得は cross-origin なので service worker 側で行う。
// ブラウザの Google ログイン Cookie をそのまま使う（credentials: 'include'）。
// WorkLogWebサーバ (Tailscaleアドレス限定バインド) への中継。
// content script からは mixed content で直接叩けないため SW 経由にする。
const SHIFT_API_BASE = 'http://100.103.183.30:8765';
// SLS/LBR LE Maker (apps/KyakusuYosoku・LE/REQのデータ元)。Mac mini常駐 0.0.0.0:8788。
// Tailscaleアドレスで参照する（Mac mini自身からも到達可能）。
// これにより同じコードのままMacBookからもMac mini上の同一データを見る＝データは常に一致する。
const LEMAKER_BASE = 'http://100.103.183.30:8788';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 自己更新（MacBook運用）: launchdのgit pullでファイルだけ新しくなった状態を検出する。
  // ディスク上のmanifest.json（=pull後の版）と、実行中の版を比べる。
  if (msg.type === 'extVersion') {
    fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now())
      .then((r) => r.json())
      .then((m) => sendResponse({
        ok: true, disk: m.version, running: chrome.runtime.getManifest().version,
      }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // 未パッケージ拡張のreloadはディスクから読み直すので、pull済みの新版が有効になる
  if (msg.type === 'extReload') { chrome.runtime.reload(); return false; }
  if (msg.type === 'leMaker') {
    fetch(LEMAKER_BASE + msg.path)
      .then((r) => r.text().then((text) => sendResponse({ ok: r.ok, status: r.status, text })))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
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
