#!/bin/sh
# RakushifuPanel を最新に保つ（MacBook用・launchdから定期実行）。
#
# ファイルを更新するだけで、Chromeへの反映はしない（できない）。
# 反映はパネルに出る「⬆ vX に更新」ボタンを押したとき。
# シフト編集中に勝手にページが再読込されるのを避けるため、この分担にしている。
set -eu

REPO="${RAKUSHIFU_REPO:-$HOME/RakushifuPanel}"
cd "$REPO"

# --ff-only: ローカルに手を入れていた場合は黙って上書きせず、ここで失敗させる
/usr/bin/git fetch --quiet origin main
/usr/bin/git merge --ff-only --quiet origin/main

echo "$(date '+%Y-%m-%d %H:%M:%S') ok $(/usr/bin/git rev-parse --short HEAD)"
