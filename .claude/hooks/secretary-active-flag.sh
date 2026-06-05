#!/usr/bin/env bash
# secretary-system UserPromptSubmit hook (v2)
#
# ターン開始（プロンプト送信）時に idle flag を消す。
# Stop hook が「停止＝idle」で set、こちらが「開始＝busy」で clear することで、
# idle flag を「現在 idle かどうか」の正確な状態にする。
# これにより send 時ワンショット nudge / handback の判定が「今 idle か」を
# 正しく見られる（ビジー中の Province に割り込まない）。
#
# 失敗は非致命: env 不在や書込失敗時は静かに exit 0。
set -u
NAME="${PROVINCE_NAME:-}"
SH="${SECRETARY_HOME:-}"
[ -n "$NAME" ] && [ -n "$SH" ] || exit 0
rm -f "$SH/run/idle-$NAME" 2>/dev/null || true
exit 0
