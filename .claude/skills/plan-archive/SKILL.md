# /plan-archive <slug>

完了・不要になった plan.md を plans/ にアーカイブするスキル。

## 手順

1. **plan.md チェック**: ルートに `plan.md` が存在するか確認。無ければ「アーカイブする計画がありません」と表示して中止。

2. **slug チェック**: 引数 `<slug>` が指定されているか確認。無ければ「`/plan-archive <slug>` のように短い識別名を指定してください (例: fix-test-hang, add-sfx-support)」と案内して中止。

3. **移動先を決定**: `plans/YYYYMMDD-<slug>.md` (YYYYMMDD は当日の日付)。

4. **plans/ ディレクトリ作成**: `plans/` が存在しなければ `mkdir -p plans` で作成。

5. **移動**: `plan.md` → `plans/YYYYMMDD-<slug>.md` にコピーし、元の `plan.md` を削除。
   - Bash の `mv` を使う

6. **完了メッセージ**:
```
plan.md → plans/YYYYMMDD-<slug>.md にアーカイブしました。
コミットは保留方針です（おぽさん判断待ち）。
```

## 注意
- commit はしない (方針保留中)。ファイル移動のみ行う
- plans/ は .gitignore に登録されており git には含まれない
- plan.md は .gitignore に登録されており git には含まれない
- この skill は Secretary System 非依存。単体プロジェクトでもそのまま動作する (汎用 skill)
