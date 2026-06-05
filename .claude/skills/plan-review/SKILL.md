# /plan-review

plan.md を Codex CLI に渡して設計レビューさせるスキル。VERDICT ベースの反復レビューループに対応。

## 前提
- `codex` CLI が PATH に存在し、ログイン済みであること
- ルートに `plan.md` が存在すること

## 手順

1. **前提チェック**:
   - `which codex` で CLI の存在を確認。無ければ `npm install -g @openai/codex` の案内を表示して中止。
   - `plan.md` の存在を確認。無ければ「`/design-plan <題目>` で計画を作成してください」と案内して中止。

2. **反復レビューループ** (最大 5 ラウンド):

   各ラウンドで以下を実行:

   ### 2a. Codex 実行

   **ラウンド 1 (初回)**: plan.md を stdin pipe で渡す:

   ```bash
   {
     echo "以下の実装計画をレビューしてください。"
     echo "観点: トレードオフの見落とし・隠れた前提・代替案・リスク・実装漏れ・テスト不足。"
     echo "指摘は箇条書きで、重要度(高/中/低)を付けてください。"
     echo ""
     echo "VERDICT 判定基準:"
     echo "- 高・中の指摘が無ければ最後の行に: VERDICT: APPROVED"
     echo "- 高または中の指摘が残るなら最後の行に: VERDICT: NEEDS_WORK"
     echo "- 低の指摘のみの場合は APPROVED としてください (低は任意対応)"
     echo ""
     echo "---"
     echo ""
     cat plan.md
   } | codex exec -s read-only -o plan-review-result.md -
   ```

   **ラウンド 2 以降**: `codex exec resume --last` で前回セッションの文脈を引き継ぐ:

   ```bash
   {
     echo "plan.md を修正しました。前回 NEEDS_WORK で挙げた高・中の指摘が解消したか確認してください。"
     echo "確認観点:"
     echo "- 前回の高・中指摘が解消されているか"
     echo "- 本当に新規の重大な問題のみ指摘 (既に ## Codex レビュー反映 で却下/議論済みの点は蒸し返さない)"
     echo ""
     echo "VERDICT 判定基準 (再掲):"
     echo "- 高・中の指摘が無ければ: VERDICT: APPROVED"
     echo "- 高または中の指摘が残るなら: VERDICT: NEEDS_WORK"
     echo "- 低の指摘のみなら APPROVED"
     echo ""
     echo "---"
     echo ""
     cat plan.md
   } | codex exec resume --last -s read-only -o plan-review-result.md -
   ```

   - codex は AGENTS.md → @CLAUDE.md 経由でプロジェクト構造を理解する
   - `-s read-only` でコード変更を防止
   - `-o plan-review-result.md` でレビュー結果をファイル出力
   - resume で前回セッションの文脈 (既レビュー内容・却下理由) を保持

   ### 2b. 結果読み取りと VERDICT 判定

   `plan-review-result.md` を読み、末尾から `VERDICT:` 行を探す。

   - `VERDICT: APPROVED` → ループ終了 (ステップ 3 へ)
   - `VERDICT: NEEDS_WORK` → 高・中の指摘を plan.md に反映してから次ラウンドへ (ステップ 2c)
   - VERDICT 行が見つからない → `NEEDS_WORK` として扱う

   ### 2c. 指摘の反映 (NEEDS_WORK 時)

   レビュー結果の **高・中** の指摘を plan.md に反映 (低は任意):
   - 該当セクション (変更対象 / エッジケース / 未解決の論点) に追記
   - 反映内容のラウンド要約を `## Codex レビュー反映` セクションに追記:
     ```
     ### ラウンド N
     - [採用] <指摘要約> → <反映先セクション>に追記
     - [却下] <指摘要約> — 理由: <却下理由>
     ```
   - 反映完了後、次ラウンドへ戻る (2a)

   ### ループ打ち切り (5 ラウンド到達)

   5 回レビューしても APPROVED が出ない場合:
   - ループを停止
   - **環境分岐で報告先を切り替え**:
     * `SECRETARY_HOME` が設定されている (= Secretary System 配下) → secretary-report-up skill で secretary に報告:
       ```
       【要確認】plan-review が 5 ラウンドで収束しませんでした。
       plan.md の題目: <題目>
       残っている主要な指摘: <最終ラウンドの高/中指摘を列挙>
       人間の確認が必要です。
       ```
       + ユーザーに「5 回レビューで収束しませんでした。secretary 経由で報告済みです」と表示
     * `SECRETARY_HOME` が未設定 (= 単体プロジェクト) → 標準出力でユーザーに直接報告:
       ```
       5 回のレビューで収束しませんでした。plan.md を手動で確認してください。
       残っている主要な指摘:
       - <最終ラウンドの高/中指摘を列挙>
       ```

3. **完了 (APPROVED 時)**:
   - 「Codex 承認。N 回のレビューで収束しました」と表示
   - `plan-review-result.md` を削除

## エラー時
- `codex exec` が認証エラーで失敗 → `codex login` を案内
- タイムアウト → codex exec にはデフォルトのタイムアウトがある旨を表示
- codex の出力が空 → 「レビュー結果が空でした。codex のログイン状態を確認してください」
- `codex exec resume --last` がセッション見つからずエラー → 初回と同じ方式 (新規 exec) にフォールバック

## 注意
- plan.md は .gitignore に登録されており git には含まれない
- plan-review-result.md も一時ファイルとして扱い、git には含めない
- plans/ は .gitignore に登録されており git には含まれない
- この skill は環境分岐により単体プロジェクトでも Secretary System 配下でも動作する (汎用 skill)
