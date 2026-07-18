// 設定画面を開くリクエストの中継のみ（content script からは openOptionsPage を直接呼べない）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});
