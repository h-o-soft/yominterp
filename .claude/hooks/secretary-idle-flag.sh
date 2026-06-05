#!/usr/bin/env bash
# secretary-system Stop hook (v2: self-pull)
#
# ターン終了(Stop)時に、未処理 inbox があれば自分で /secretary-check-inbox を
# 実行して自走する（watcher への依存をなくす）。PoC 実証済みの契約に基づく:
#   - stdout に {"decision":"block","reason":"..."} を出すと停止が抑止され
#     reason がモデルに渡って継続する。
#   - 入力 JSON の stop_hook_active を見てループガードする。
#
# 自己処理する条件（すべて満たすとき block）:
#   - 未処理 inbox が 1 件以上ある
#   - handoff ロックが無い（ユーザー直接対話中は割り込まない）
#   - stop_hook_active が偽（block 起因の継続中ではない）
# それ以外は通常停止し、そのとき初めて idle flag を立てる（= idle は「現在 idle」を表す）。
#
# poison 対策: pending が片付かないまま self-pull を繰り返す事故を防ぐサーキット
# ブレーカー（run/selfpull-<name>）。pending が 0 になればリセット。上限で park。
#
# 失敗は非致命: env 不在や書込失敗時は静かに exit 0（Claude Code を絶対に止めない）。

set -u

NAME="${PROVINCE_NAME:-}"
SH="${SECRETARY_HOME:-}"
# Province として spawn されていなければ何もしない（スタンドアロン起動）
[ -n "$NAME" ] && [ -n "$SH" ] || exit 0

RUN="$SH/run"
INBOX="$SH/mailbox/$NAME/inbox"
idle_file="$RUN/idle-$NAME"
handoff_file="$RUN/handoff-$NAME"
bc_file="$RUN/selfpull-$NAME"
MAX_SELFPULL=5

mkdir -p "$RUN" 2>/dev/null || exit 0

input="$(cat 2>/dev/null || true)"
stop_active=0
case "$input" in
  *'"stop_hook_active": true'*|*'"stop_hook_active":true'*) stop_active=1 ;;
esac

# 未処理 inbox 件数
pending=0
for f in "$INBOX"/*.md; do
  [ -f "$f" ] && pending=$((pending + 1))
done

# pending が片付いたらブレーカーをリセット
[ "$pending" -eq 0 ] && rm -f "$bc_file" 2>/dev/null

# 自己処理（block）すべきか
if [ "$pending" -gt 0 ] && [ ! -f "$handoff_file" ] && [ "$stop_active" -eq 0 ]; then
  strikes="$(cat "$bc_file" 2>/dev/null || echo 0)"
  case "$strikes" in ''|*[!0-9]*) strikes=0 ;; esac
  if [ "$strikes" -ge "$MAX_SELFPULL" ]; then
    # poison: 何度 self-pull しても pending が減らない → park（停止を許可して idle に）
    touch "$idle_file" 2>/dev/null || true
    exit 0
  fi
  echo $((strikes + 1)) > "$bc_file" 2>/dev/null || true
  # block して継続指示を注入（idle flag は立てない＝継続中）
  printf '{"decision":"block","reason":"未処理の依頼が %s 件あります。/secretary-check-inbox を実行し、各依頼を処理して outbox に報告・ack（processed へ移動）してください。"}\n' "$pending"
  exit 0
fi

# 通常停止: ここで初めて idle flag を立てる（idle は「現在 idle」を表す）
touch "$idle_file" 2>/dev/null || true
exit 0
