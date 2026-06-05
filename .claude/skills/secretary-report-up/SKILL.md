---
name: secretary-report-up
description: Send a status/result report to the Secretary's inbox.
---

# secretary-report-up

このスキルは、Secretary の inbox に状況/結果報告を 1 通投函するためのものです。

## 使い方

```bash
secretary mailbox put secretary --from "$PROVINCE_NAME" --type report -m "報告本文"
```

## body に書くべきこと

3〜10 行程度に収めます。Secretary は多数の Province からの報告を集約するので、長文は避けてください。

- **何をしたか** (1〜3 行)
- **何が変わったか** (1〜2 行、ユーザーへの影響)
- **次のアクション要否** (Secretary が次の依頼を組むときの判断材料)

例:
```text
ログインバグの修正を完了。auth.py の token 検証ロジックを 5 行修正。
これで失効済み token が拒否されるようになった。
追加作業の依頼はなし。
```

## frontmatter のオプション

- `--type report` (既定): 通常の状況報告
- `--type error`: エラー発生時。Secretary が人間判断を求めるトリガになる
- `--type ack`: 「依頼受領、これから着手」の単純な ack
- `--reply-to <id>`: 依頼への応答であれば、元依頼の id を指定（突き合わせの手がかり）

## 起動タイミング

- 重要作業完了時（手動）
- セッション終了時 (フェーズ3 で SessionEnd hook 経由)
- `secretary-check-inbox` スキルが処理した依頼の応答として
- ユーザーが直接対話モードで作業した後（detach 前）

## 例

```bash
secretary mailbox put secretary --from "$PROVINCE_NAME" --type report -m "$(cat <<EOF
ユーザーが直接対話モードで作業: 2 ファイル変更、テスト pass。
今後 30 分は idle 想定。
EOF
)"
```
