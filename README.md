# らくしふ 客数予測パネル

らくしふのシフト編集画面 (`/admin/v2/schedules`) に、スプレッドシート
「時間帯別客数予測 v2」の当日データを重ねて表示するChrome拡張。

## 表示内容

- **上部チップ**: LABOR% / LABOR H / SALES / SBP（シートヘッダー部）
- **時間帯テーブル** (6:00–23:00): LE(客数) / REQ F / REQ K / REQ計 ＋ 合計行
  - 今日を表示中は現在時刻の行をハイライト
- **月次タスク**: シート「月次タスク一覧」から対象日に該当するM-seriesタスクを表示
  （開始日〜終了日の窓、`3TUE`=第3火曜、`EOM`=月末最終日、`外部`=外部日程）
- **シフト確定 未処理日**: 今日〜月末で「シフト確定」がまだの日を赤チップで列挙。
  ツールバーの📊ボタン（画面右上）にも件数バッジ表示。5分ごとに自動更新。

対象日はらくしふURLの `from=` に自動追従。パネルの ◀ ▶ で独立して前後の日も見られる。

## ダウンロード

- `git clone https://github.com/AsukaIwanaga/RakushifuPanel.git`
- または GitHubページの **Code → Download ZIP** で取得して展開

## インストール（自分専用・ストア不要）

1. Chromeで `chrome://extensions` を開く
2. 右上「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダ (`~/RakushifuPanel`) を選択
4. らくしふの編集画面を開く（またはリロード）→ 右下に📊ボタンが出る

## 2台運用（Mac mini / MacBook）

データ元（LE Maker `:8788` とシフトAPI `:8765`）はどちらも **Mac mini上の1箇所**を
Tailscaleアドレスで参照する。コピーを持たないので、2台の表示は常に一致する。
→ MacBookで使うにはTailscaleが起動していること（Mac miniは常時起動設定済み）。

### MacBookでの初回セットアップ

```sh
git clone https://github.com/AsukaIwanaga/RakushifuPanel.git ~/RakushifuPanel
sh ~/RakushifuPanel/scripts/setup-macbook.sh   # 15分ごとの自動pullを登録
```

あとは下の「インストール」と同じ手順でChromeに読み込む。

### 更新のしかた

`scripts/auto-pull.sh` がlaunchdで15分ごとに `git pull` する（ファイルが新しくなるだけ）。
新版がディスクに来ると、パネル上部に **`⬆ vX.Y.Z に更新`** ボタンが出る。
押すと拡張とページを再読込して反映される。

自動では絶対に再読込しない。**シフト編集中に不意にページが飛ぶのを避けるため**、
いつ反映するかは押した人が決める（＝押すと編集中の内容は失われる）。

ログ: `scripts/auto-pull.log`。ローカルを直接編集していると `--ff-only` で
pullが止まるので、そのときはログにエラーが残る。

## 仕組み

- シート取得: `docs.google.com` の gviz CSVエンドポイントを、ブラウザのGoogleログイン
  Cookieで取得（APIキー不要）。シート名は `MMDD (曜)` 形式で当日分を特定。
- 行の特定はシートG列のラベル (`LE`, `REQ（F）` など)。表示項目を変えたいときは
  `content.js` 冒頭の `HOURLY_COLS` / `HEADER_LABELS` を編集。
- 未確定日: らくしふ内部API `shift_confirm_target_candidates` を利用。
  **レスポンス形式は防御的にパースしているため、初回は表示が実態と合っているか要確認。**
  生レスポンスはDevToolsコンソールに `[客数予測パネル]` プレフィックスで出力される。

## 既知の注意点

- Googleからログアウトすると「シート取得失敗」になる → Googleに再ログイン
- シートの列配置（G列ラベル・6:00開始・J列ヘッダー値）を変えるとパースが壊れる。
  その場合は `content.js` の `COL_*` 定数を調整。
- コードを変更したら `chrome://extensions` で ⟳（再読み込み）→ らくしふページもリロード
