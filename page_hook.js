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

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (isWrite(method, url)) p.then(notify, () => {});
    } catch { /* noop */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__rfWrite = isWrite(method, url); } catch { /* noop */ }
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__rfWrite) this.addEventListener('loadend', notify);
    return origSend.apply(this, arguments);
  };
})();
