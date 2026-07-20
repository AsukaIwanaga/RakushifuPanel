#!/bin/sh
# MacBookで1回だけ実行: 15分ごとの自動pullをlaunchdに登録する。
#   sh ~/RakushifuPanel/scripts/setup-macbook.sh
# 何度実行しても同じ状態になる（登録済みなら入れ直す）。
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.iwanaga.rakushifu-pull"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|REPO_PATH|$REPO|g" "$REPO/scripts/$LABEL.plist" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "登録しました: $DEST"
echo "リポジトリ  : $REPO"
echo "ログ        : $REPO/scripts/auto-pull.log"
echo
echo "動作確認（数秒後にokの行が出れば成功）:"
echo "  cat $REPO/scripts/auto-pull.log"
