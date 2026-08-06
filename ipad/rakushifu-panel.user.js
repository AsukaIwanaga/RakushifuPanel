// ==UserScript==
// @name         らくしふパネル (iPad Safari)
// @description  RakushifuPanel拡張をiPad Safariで動かすローダー。Mac mini(8790)から本体を取得し、chrome APIをシムで代替する。閲覧用途（反映系は非対応）。
// @version      1.0.0
// @match        https://sken-rakushifu-mg.go.akamai-access.com/admin/v2/schedules*
// @grant        GM.xmlHttpRequest
// @run-at       document-end
// ==/UserScript==

// 使い方（初回のみ）:
// 1. iPadにApp Storeの「Userscripts」を入れ、設定→Safari→機能拡張で有効化
// 2. このファイルを Userscripts のフォルダに保存（iCloud Drive/Userscripts）
// 3. らくしふを開き、Safariの拡張アイコン→Userscripts→このスクリプトを許可
// 前提: iPadのTailscaleがON（Mac mini 100.103.183.30 に到達できること）

(function () {
  'use strict';
  const MINI = 'http://100.103.183.30';
  const BASES = { leMaker: `${MINI}:8788`, draftApi: `${MINI}:8790`, shiftApi: `${MINI}:8765` };

  // GM.xmlHttpRequest = Userscriptsのネイティブ層fetch。
  // httpsページからhttpのMac miniへ届く（mixed content制限を受けない）＝これがこの方式の核。
  const gmFetch = (url, opts) => new Promise((resolve) => {
    GM.xmlHttpRequest({
      method: (opts && opts.method) || 'GET',
      url,
      headers: (opts && opts.headers) || {},
      data: opts && opts.body,
      onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
      onerror: () => resolve({ ok: false, status: 0, text: '' }),
      ontimeout: () => resolve({ ok: false, status: 0, text: '' }),
    });
  });

  // 拡張の chrome.runtime.sendMessage(5種) を同じ応答形式で代替するシム
  const handlers = {
    leMaker: async (msg) => {
      const r = await gmFetch(BASES.leMaker + msg.path);
      return { ok: r.ok, status: r.status, text: r.text };
    },
    draftApi: async (msg) => {
      const r = await gmFetch(BASES.draftApi + msg.path, msg.payload
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload) }
        : undefined);
      let data = null;
      try { data = JSON.parse(r.text); } catch { /* 非JSON応答 */ }
      return { ok: r.ok, data };
    },
    shiftApi: async (msg) => handlers.draftApi({ ...msg, type: 'shiftApi', path: msg.path, payload: msg.payload }, BASES.shiftApi)
      // ↑共通化すると読みにくいので実体は下で上書き
    ,
    fetchSheetCsv: async (msg) => {
      // 注意: GM.xmlHttpRequestはSafariのGoogleログインCookieを送らないため、
      // 認証必須のシートは取れない（タスク一覧が空になるだけ・他機能に影響なし）
      const sel = msg.gid != null ? `gid=${msg.gid}` : `sheet=${encodeURIComponent(msg.sheetName)}`;
      const r = await gmFetch(`https://docs.google.com/spreadsheets/d/${msg.sheetId}/gviz/tq?tqx=out:csv&${sel}`);
      return { ok: r.ok, status: r.status, text: r.text };
    },
    extVersion: async () => ({ ok: true, disk: 'ipad', running: 'ipad' }),
    extReload: async () => { location.reload(); return { ok: true }; },
  };
  handlers.shiftApi = async (msg) => {
    const r = await gmFetch(BASES.shiftApi + msg.path, msg.payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload) }
      : undefined);
    let data = null;
    try { data = JSON.parse(r.text); } catch { /* 非JSON応答 */ }
    return { ok: r.ok, data };
  };

  const chromeShim = {
    runtime: {
      id: 'rakushifu-panel-ipad',
      getManifest: () => ({ version: 'ipad' }),
      sendMessage: (msg, cb) => {
        const h = handlers[msg && msg.type];
        Promise.resolve()
          .then(() => (h ? h(msg) : { ok: false, error: `iPad未対応: ${msg && msg.type}` }))
          .catch((e) => ({ ok: false, error: String(e) }))
          .then((res) => { if (cb) cb(res); });
      },
    },
  };

  // 本体(engine.js→content.js)をMac miniから取得して注入。
  // 常に最新版が配信される（拡張リポの実ファイル・no-cache）ので、iPad側の更新作業は不要。
  (async () => {
    const eng = await gmFetch(`${BASES.draftApi}/ext/engine.js?t=${Date.now()}`);
    const cjs = await gmFetch(`${BASES.draftApi}/ext/content.js?t=${Date.now()}`);
    if (!eng.ok || !cjs.ok) {
      console.warn('[rf-ipad] 本体取得失敗', eng.status, cjs.status,
        '（TailscaleがON か・Mac miniの8790が生きているか確認）');
      return;
    }
    try {
      // chromeシムを引数として渡す（ページのグローバルを汚さない）
      new Function('chrome', `${eng.text}\n;\n${cjs.text}`)(chromeShim);
      console.info('[rf-ipad] injected');
    } catch (e) {
      console.error('[rf-ipad] 注入失敗', e);
    }
  })();
})();
