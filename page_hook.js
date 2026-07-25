// らくしふページ本体のシフト保存 (GET以外の /ajax 通信) を検知して
// content script へ通知する。MAIN world で実行されページのXHR/fetchをフックする。
(() => {
  'use strict';
  const notify = () => window.postMessage({ __rfPanel: 'dataChanged' }, location.origin);
  const isWrite = (method, url) => {
    try {
      return method && method.toUpperCase() !== 'GET' && String(url).includes('/ajax');
    } catch { return false; }
  };
  // タスク割当(ポジション/固定作業)の保存通信を1回採取するための対象判定。
  // 正確なURL・メソッド・ボディを特定して「中身の反映」を作るのに使う（採取のみ）。
  const isCapture = (method, url) => {
    try {
      const u = String(url);
      return method && method.toUpperCase() !== 'GET'
        && (u.includes('task_assign') || u.includes('/schedules'));
    } catch { return false; }
  };
  const capture = (method, url, body) => {
    let b = body;
    try { if (typeof b !== 'string') b = JSON.stringify(b); } catch { b = String(b); }
    if (b && b.length > 4000) b = b.slice(0, 4000) + '…(切詰)';
    // eslint-disable-next-line no-console
    console.log('%c[rf-capture]', 'color:#0e7490;font-weight:700',
      (method || '').toUpperCase(), String(url), '\nbody:', b);
    window.postMessage({ __rfCapture: { method: (method || '').toUpperCase(), url: String(url), body: b } }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url);
    const method = (init && init.method) || (input && input.method) || 'GET';
    try { if (isCapture(method, url)) capture(method, url, init && init.body); } catch { /* noop */ }
    const p = origFetch.apply(this, arguments);
    try { if (isWrite(method, url)) p.then(notify, () => {}); } catch { /* noop */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__rfWrite = isWrite(method, url); this.__rfCap = isCapture(method, url);
      this.__rfM = method; this.__rfU = url; } catch { /* noop */ }
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try { if (this.__rfCap) capture(this.__rfM, this.__rfU, body); } catch { /* noop */ }
    if (this.__rfWrite) this.addEventListener('loadend', notify);
    return origSend.apply(this, arguments);
  };
})();
