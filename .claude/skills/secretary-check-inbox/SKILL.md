---
name: secretary-check-inbox
description: Check this Province's inbox in $SECRETARY_HOME/mailbox/<self>/inbox/ and process pending messages from the Secretary one by one.
---

# secretary-check-inbox

このスキルは、自分の inbox を読んで未処理依頼を順に処理するためのものです。

## 自分の Province 名を取得

`$PROVINCE_NAME` 環境変数に設定されています（`secretary spawn` が起動時に設定）。
未設定の場合、ユーザーに「あなたはどの Province として動いていますか？」と確認してください。

```bash
echo "I am Province: ${PROVINCE_NAME:-(unset)}"
```

## 未処理メッセージを列挙

```bash
secretary mailbox list "$PROVINCE_NAME"
```

- 出力なし → inbox は空。終了します。
- 1 行 1 ファイルパスが出力されます。古い順 (microsecond 精度の作成順)。

## 各メッセージの処理ループ

各 path に対して以下:

1. **読む**: `secretary mailbox show <path>`
   - frontmatter で `from` / `type` / `id` を確認
   - body が依頼内容
2. **理解**: 依頼内容を読み取り、自分のプロジェクトの文脈で判断
3. **作業**: 必要なファイルの読み書き、コマンド実行など
4. **報告**: 結果を Secretary の inbox に投函（次の skill 参照）
   ```bash
   secretary mailbox put secretary --from "$PROVINCE_NAME" --type report --reply-to <その依頼の id> -m "結果のサマリ"
   ```
   または `secretary-report-up` skill を使う。
5. **ack**: 処理済みに移動
   ```bash
   secretary mailbox ack <path>
   ```

## 処理しきれない場合

- 依頼が大きすぎる/不明瞭/権限外 → ack せず、`status: deferred` の report を送り返す
- エラーが発生 → ack せず、`type: error` の report を送り返す（人間が処理を判断する材料）

## 重要: 必ず「空になるまでループ」

処理中に新しいメッセージが到着することがあります（Secretary が連続で `/secretary-dispatch`
した場合など）。**1 周だけ処理すると新着が次のターンまで放置される** ので、
inbox が完全に空になるまで繰り返してください。

## 例

```bash
SELF="$PROVINCE_NAME"
while true; do
  PENDING=$(secretary mailbox list "$SELF")
  [ -z "$PENDING" ] && { echo "inbox empty"; break; }
  # while-read で改行区切り処理 (パスにスペースが入っても安全)
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    echo "=== $path ==="
    secretary mailbox show "$path"
    # ... 作業 ...
    secretary mailbox put secretary --from "$SELF" --type report -m "Done: $(basename "$path")"
    secretary mailbox ack "$path"
  done <<< "$PENDING"
done
```

ループは「ack 後に再度 list」して、その間に届いた新着を拾います。
全件 ack 済みになるまで Province の責務として処理しきってください。

## 起動条件

- ユーザー手動: `/secretary-check-inbox`
- (フェーズ3) Stop hook 経由で自動
- (フェーズ4) Secretary からの `/secretary-dispatch` 直後に Province の Stop hook が拾う流れ
