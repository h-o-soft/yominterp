# zmachine-llm

Z-machine 製インタラクティブフィクション(IF)を、**LLM 翻訳層を挟むことで多言語(まず日本語)でプレイできる**ようにするプロジェクト。

ZORK 等の古典 IF や現代 Inform 製 IF は Z-machine という仮想機械上で動く。Z-machine のパーサは「固定辞書＋限定文法のパターンマッチ」であり自然言語理解ではないため、そのままでは英語の限定コマンドしか受け付けない。そこに LLM を「入口(日本語→ゲームが受理する正規英コマンド)／出口(英語出力→日本語)」の通訳として挟み、ゲーム本体(ストーリーファイル)もインタプリタも改造せずに多言語化する。

## アーキテクチャの基本方針

- **VM(インタプリタ)とストーリーデータは分離したまま**使う。`.z5` 等は「データアセット」として読むだけ。これは IF 配布の業界標準(Lectrote / Parchment / Spatterlight 等も同形)。
- LLM は**透過プロキシ**として挟む:
  ```
  ユーザー日本語
    → [LLM 入口: 文脈＋ゲーム辞書＋few-shot で "意図→正規英コマンド列" へ変換]
    → インタプリタ(Z-machine)
    → 英語出力
    → [LLM 出口: 日本語へ翻訳]
    → ユーザー
  ```
- **入口は "翻訳" ではなく "intent → 限定コマンド変換"** が肝。自然な英語ではなくゲーム辞書内の語彙・文法に寄せる。複合動作は `take lamp. go north` のように複数コマンドへ分解。固有名詞・魔法の言葉(例: xyzzy)はそのまま通す。
- **自己修正ループ**: パーサが `I don't know the word "..."` 等を返したら、その出力を LLM に食わせて言い直させる(裏で数回リトライ)。弱いモデルを補い、堅牢性を上げる中核機構。
- LLM への入力材料: (a) ストーリーファイルから抽出した辞書＋オブジェクト名、(b) 直近のゲーム出力(代名詞・省略・その場参照の解決用)、(c) 公式 transcript からの few-shot 例。

## LLM 接続

- **OpenAI 互換 API** (`/v1/chat/completions`) を喋るクライアントを主設計とする。`base_url ＋ api_key ＋ model 名` を設定で持たせ、ローカル(Ollama / LM Studio / llama.cpp server 等)もクラウドも同一コードで差し替え可能にする。
- 開発時の既定接続先: **LM Studio `http://127.0.0.1:1234`**。利用可能モデル例: `gemma-4-e4b-it-ud-japanese-imatrix`(日本語チューニング・軽量)、`gemma-4-26b-a4b-it-mlx`(大きめ)。
- アプリ内に小型 LLM を同梱する embedded モードは将来検討(サイズ/速度/品質のトレードオフ有り)。まず OpenAI 互換クライアントを作る。

## 段階計画

- **段階1(まず価値検証 / CLI)**: `dfrotz`(Frotz の dumb モード)を子プロセスで起動し `ghosts.z5` をロード。OpenAI 互換クライアント(LM Studio)で入口/出口翻訳＋自己修正ループを実装。`game.transcript` の手順を日本語でなぞって「同じ進行になるか」を自動検証し、"LLM 翻訳層が実用になるか"を見極める。**この段階は CLI テキストでよい。**
- **段階2(配布 / Web エンジン)**: 検証済みの翻訳コア＋設定UI(接続先/モデル選択)を **Web スタック(Electron/Tauri 想定)** に載せ、インタプリタは **プロセス内に埋め込む**(JS 製 VM = ifvms.js/ZVM、または emglken=VM の WASM 化)。Z-machine 風 UI(等幅テキスト＋ステータス行)で仕上げる。配布版では dfrotz を別プロセス同梱する形は採らない。

## サンプル素材 (refs/)

- `refs/ghosts_R14/ghosts.z5` — "The Ghosts of Blackwood Manor"(Stefan Vogt, 2023, Inform6/PunyInform 製, Z-machine **v5**)。動作確認用の本体。
- `refs/ghosts_R14/game.transcript` — 作者公式の good-ending 最短手順。**LLM 翻訳層のテストオラクル**として使う。
- `refs/ghosts_R14/` 内の `.d64/.dsk/.adf` 等は ozmoo 製の 8bit 実機向けビルド成果物(本プロジェクトでは未使用)。

**重要(著作権)**: ghosts.z5 は商用作品。**ローカルでのテスト素材としてのみ使用**し、リポジトリへのコミットや配布はしない。製品化時のストーリーファイルは自作 / 許諾済み / フリーライセンス(IF Archive 等)のものを別途用意する。インタプリタ側もライセンス確認が必要(Frotz は GPL、Glulxe/Quixe は MIT 寄り 等)。

## 設計プロセス

- 詳細設計は `/design-plan <題目>` で `plan.md` に策定 → `/plan-review` で Codex CLI による反復レビュー(最大5ラウンド, VERDICT: APPROVED まで) → 完了した plan は `/plan-archive <slug>` で `plans/` へ。
- `plan.md` / `plan-review-result.md` / `plans/` は `.gitignore` 管理(git に含めない)。
