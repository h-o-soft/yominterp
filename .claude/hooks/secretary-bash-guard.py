#!/usr/bin/env python3
"""secretary-system PreToolUse guard.

Province を `secretary trust`(bypassPermissions) で自律運用しても、「明らかに危険」な
Bash コマンドだけはブロックするための PreToolUse フック。

Claude Code 契約:
  - stdin に PreToolUse イベント JSON (tool_name, tool_input.command 等) が来る
  - deny したいとき: stdout に
      {"hookSpecificOutput":{"hookEventName":"PreToolUse",
       "permissionDecision":"deny","permissionDecisionReason":"..."}}
    を出力し exit 2
  - 許可: 何も出さず exit 0
  ※ PreToolUse フックは bypassPermissions モードでも実行されるため、
    「trust しつつ地雷だけ止める」が成立する。

設計方針:
  - 既定の deny パターンはこのファイルに内蔵（明らかに破壊的なものだけ・誤爆を避け、
    プロジェクト内の通常操作はブロックしない）
  - 追加したいパターンは $SECRETARY_HOME/config/bash-guard-denylist.txt に
    1 行 1 正規表現で書ける（コメント行 # と空行は無視。既定に *追加* される）
  - 解析失敗時は fail-open（exit 0）。これは trust の上に乗せる安全網であり、
    唯一の防壁ではない。フック自身が Province を壊さないことを優先する。
"""
from __future__ import annotations

import json
import os
import re
import sys

# (正規表現, 理由) — command 文字列全体に対して検索（re.search, IGNORECASE）
DEFAULT_DENY: list[tuple[str, str]] = [
    # --- ルート/ホーム破壊系の rm -rf（プロジェクト内の相対パス rm は通す） ---
    (r"\brm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b.*\s+(?:/|/\*|~|~/|\$HOME\b|\$\{HOME\})(?:\s|$|/)",
     "ルート/ホームを対象にした rm -rf は禁止です（破壊的すぎます）。"),
    (r"\brm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b.*\s+(?:/|/\*|~|~/|\$HOME\b|\$\{HOME\})(?:\s|$|/)",
     "ルート/ホームを対象にした rm -fr は禁止です（破壊的すぎます）。"),
    (r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b.*\s+/(?:etc|usr|bin|sbin|var|lib|System|Library|Applications|Users)\b",
     "システムディレクトリへの再帰削除は禁止です。"),

    # --- git 履歴破壊系 ---
    (r"\bgit\s+push\b(?=.*(?:--force(?!-with-lease)|\s-f\b))",
     "git push --force / -f は禁止です（履歴を破壊します。--force-with-lease を検討してください）。"),
    (r"\bgit\s+reset\s+--hard\b.*\b(?:origin/|upstream/|main|master)\b",
     "保護ブランチ系への git reset --hard は禁止です。"),
    (r"--no-verify\b",
     "--no-verify は禁止です（フック/検証を迂回しないでください）。"),
    (r"--no-gpg-sign\b",
     "--no-gpg-sign は禁止です（署名検証を迂回しないでください）。"),

    # --- ディスク/デバイス破壊系 ---
    (r"\bdd\b[^\n]*\bof=/dev/",
     "dd で /dev/ への書き込みは禁止です（ディスク破壊）。"),
    (r"\bmkfs(?:\.[a-z0-9]+)?\b",
     "mkfs（ファイルシステム作成）は禁止です。"),
    (r">\s*/dev/(?:sd|disk|nvme|rdisk|hd)",
     "ブロックデバイスへのリダイレクトは禁止です。"),

    # --- システム全体への危険な権限変更 ---
    (r"\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?0?777\s+(?:/|~|\$HOME)(?:\s|/|$)",
     "ルート/ホームへの chmod 777 は禁止です。"),
    (r"\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\b.*\s+/(?:\s|$)",
     "ルートへの再帰 chown は禁止です。"),

    # --- ネット → シェル直流し ---
    (r"\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b",
     "ネットからの取得をシェルに直接パイプする実行は禁止です（curl|sh パターン）。"),

    # --- fork bomb ---
    (r":\s*\(\s*\)\s*\{[^}]*\|\s*:\s*&[^}]*\}\s*;\s*:",
     "fork bomb は禁止です。"),

    # --- SSH 鍵・秘密鍵の破壊/持ち出し ---
    (r"\brm\b[^\n]*(?:\.ssh/|/\.ssh\b|id_rsa|id_ed25519)",
     "SSH 鍵ディレクトリ/秘密鍵の削除は禁止です。"),
    (r"\b(?:curl|wget|scp|nc|ncat)\b[^\n]*(?:id_rsa|id_ed25519|\.pem\b|\.key\b)",
     "秘密鍵らしきファイルの外部送信は禁止です。"),
]


def load_extra_patterns() -> list[tuple[str, str]]:
    home = os.environ.get("SECRETARY_HOME") or os.path.expanduser("~/secretary")
    path = os.path.join(home, "config", "bash-guard-denylist.txt")
    out: list[tuple[str, str]] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                out.append((line, f"カスタム denylist にマッチしました: {line}"))
    except OSError:
        pass
    return out


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[secretary-bash-guard] {reason}",
        }
    }, ensure_ascii=False))
    sys.exit(2)


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0  # fail-open: フック自身が Province を壊さない

    if event.get("tool_name") != "Bash":
        return 0
    command = (event.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        return 0

    patterns = DEFAULT_DENY + load_extra_patterns()
    for pat, reason in patterns:
        try:
            if re.search(pat, command, re.IGNORECASE):
                deny(reason)  # exit 2
        except re.error:
            continue  # 壊れた正規表現はスキップ

    return 0


if __name__ == "__main__":
    sys.exit(main())
