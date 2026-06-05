---
name: secretary-handback-self
description: Release this Province's own handoff lock so the secretary watcher resumes nudging when new messages arrive.
---

# /secretary-handback-self

`/secretary-handoff-self` で立てた handoff lock を解除します。watcher が再び mailbox の新着を見て nudge してくれるようになります。

## 何をするか

```bash
secretary handback
```

引数を省略すると `$PROVINCE_NAME` の lock を外します（`~/secretary/run/handoff-<self>` を削除）。

## いつ使うか

- ユーザーとの直接対話モードを終えたとき（detach する直前など）
- 「watcher また動かして」「handback して」のような指示があったとき

ユーザーが detach した気配があるが明示的な指示がない場合は、**まずユーザーに確認**してください（detach 検知は確実ではないため、勝手に handback して watcher が割り込むのは避けたい）。

## 状態確認

handoff flag が残っているかどうかは:

```bash
ls "$SECRETARY_HOME/run/handoff-$PROVINCE_NAME" 2>/dev/null
```

flag があれば handoff 中、無ければ通常モード。
