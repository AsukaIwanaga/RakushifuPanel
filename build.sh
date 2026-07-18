#!/bin/bash
# 配布用ZIPを作る。実行ファイル＋導入手順書を「らくしふ客数予測パネル-配布版」フォルダに
# まとめ、dist/ に ...-vX.Y.Z.zip として出力する。
# 使い方: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

# 拡張に含める実行ファイル（開発用の docs/ README/ build.sh などは入れない）
RUNTIME=(manifest.json content.js background.js page_hook.js options.html options.js)

VERSION=$(node -e "process.stdout.write(require('./manifest.json').version)")
FOLDER="らくしふ客数予測パネル-配布版"
STAGE="dist/$FOLDER"
ZIP="dist/${FOLDER}-v${VERSION}.zip"

# 前回分を掃除して土台を作る
rm -rf "dist"
mkdir -p "$STAGE/icons"

# 実行ファイルをコピー
for f in "${RUNTIME[@]}"; do cp "$f" "$STAGE/"; done
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"

# 導入手順書（テンプレのバージョンを差し替えて同梱）
sed "s/{{VERSION}}/${VERSION}/g" "packaging/はじめにお読みください.txt" > "$STAGE/はじめにお読みください.txt"

# ZIP化（Finder解凍で余計な __MACOSX/.DS_Store を作らない）
( cd dist && zip -r -X "$(basename "$ZIP")" "$FOLDER" -x '*.DS_Store' >/dev/null )

echo "作成しました: $ZIP"
echo "同梱ファイル:"
( cd "$STAGE" && find . -type f | sed 's|^\./|  |' | sort )
