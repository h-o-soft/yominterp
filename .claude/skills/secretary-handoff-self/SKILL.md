---
name: secretary-handoff-self
description: When the user is interacting with this Province pane directly, silence the secretary watcher's nudges so the user can type freely.
---

# /secretary-handoff-self

ユーザーがこの Province ペインに切り替えてきて直接対話したいときに使います。watcher が `/secretary-check-inbox` を打ち込んでこなくなり、ユーザーの入力に被らずに済みます。

## 何をするか

```bash
secretary handoff
```

引数を省略すると `$PROVINCE_NAME`（spawn 時に env で渡されている自分の名前）に対して handoff lock を立てます。`~/secretary/run/handoff-<self>` というフラグファイルが作られ、watcher はそれを見ている間、自分への nudge を抑制します。

## いつ使うか

- ユーザーが Province ペインに切り替えてきて「ちょっと直接話そう」と言ったとき
- 長い対話モードに入る前（タスクの仕様詰めなど、watcher にコマンド注入されると邪魔なとき）

明示的にユーザーから「handoff モードに入って」「watcher 止めて」のような指示があったときに実行してください。**勝手に自己 handoff しないこと**（mailbox の自動処理が止まってしまう）。

## 解除

ユーザーとの直接対話が終わったら必ず `/secretary-handback-self` で解除してください。忘れると watcher が永久に黙ったまま、新着メッセージが処理されなくなります。
