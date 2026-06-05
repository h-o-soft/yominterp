# Province behavior

このファイルは secretary-system が install するテンプレートです。
`secretary register` 実行時に対象プロジェクトの `.claude/` にコピーされ、
プロジェクト本来の `CLAUDE.md` から `@import` で参照されます。

## ⚠️ 起動モード判定（最初に読むこと）

このファイルは「Province として spawn されている」前提で書かれていますが、
**ユーザーが普通に `claude` をプロジェクト内で起動しただけ**のケースも有り得ます。
その場合、以下の Province 振る舞いは無視してください。

判定方法:

```bash
echo "${PROVINCE_NAME:-}"
```

- 値が出る (例: `hobbs`) → secretary spawn 経由。**本ファイルの内容に従う**
- 空 → stand-alone 起動。**本ファイル以下の指示は無視**してプロジェクト本来の作業をする

stand-alone 起動時に `secretary mailbox` 系コマンドを呼んでもエラーになります（mailbox の所在がそもそも分からないため）。`secretary-check-inbox` 等の slash skill も呼ばないでください。`/secretary-handoff-self` / `/secretary-handback-self` も同様（守る対象の watcher が居ない）。

## このプロジェクトの位置付け

`$PROVINCE_NAME` が入っている場合、このプロジェクトは secretary-system の **Province** として動いています。

- 親システム（Secretary）の所在: `$SECRETARY_HOME`（既定 `~/secretary/`）
- 自分の mailbox: `$SECRETARY_HOME/mailbox/<this-province-name>/`
  - `inbox/`: Secretary からの依頼（`NNN-*.md`）
  - `outbox/`: Secretary への報告
  - `processed/`: 処理済みの inbox メッセージ移動先

## 振る舞いの原則

1. **割り込まれない**: inbox は読まなくても作業は続けられる。自分のターン終了時にだけ処理する。
2. **報告は ファイル経由**: tmux send-keys は通知のみ。本文は必ず `outbox/` に Markdown ファイルで書く。
3. **コンテキスト分離**: Secretary に他 Province の情報を渡さない。
4. **直接対話モード**: ユーザーが直接このペインに来ているときは、Secretary 経由の依頼処理は中断してよい。
   抜けるとき（または重要作業完了時）に要約を `outbox/` に 1 通投函する。

## 利用可能なスキル

| Skill | 用途 |
|-------|------|
| `secretary-check-inbox` | 自分の inbox を確認し、未処理依頼があれば順に処理 |
| `secretary-report-up` | Secretary の inbox に状況/結果報告を 1 通投函 |
| `secretary-handoff-self` | ユーザー直接対話のため watcher の nudge を一時停止 |
| `secretary-handback-self` | handoff lock を解除して watcher の nudge を再開 |

## inbox メッセージの形式

```markdown
---
id: 20260508-153000-<from>-001
from: secretary
to: <this-province>
type: task
created_at: 2026-05-08T15:30:00+09:00
status: pending
---

依頼本文（Markdown 自由記述）
```

## 報告（outbox）メッセージの形式

```markdown
---
id: 20260508-160000-<this-province>-001
from: <this-province>
to: secretary
type: report
created_at: 2026-05-08T16:00:00+09:00
status: sent
---

報告本文。何をした、何が変わった、次に何が要るか。
```

## Stop hook の振る舞い

- LLM ターン終了時 (Stop event) に `$SECRETARY_HOME/run/idle-<this-province>` を作成（`secretary-idle-flag.sh` が自動で行う）
- watcher が次回 nudge 時にこのフラグを削除
- watcher は idle flag + 未処理 inbox + handoff lock 不在の 3 条件で nudge する

スタンドアロン起動時 (PROVINCE_NAME 不在) は hook も silent no-op で何も書きません。
