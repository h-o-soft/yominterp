# yominterp

英語のインタラクティブフィクション (Z-machine 製) を、**LLM 翻訳層を挟んで日本語で遊ぶ**ためのプロジェクト。
読み: ヨミンタープ (yomin = Enchanter の「心を読む」呪文 + interp(reter))。

**▶ 遊ぶ: https://h-o-soft.github.io/yominterp/**

- 入口: 日本語の意図 → ゲームのパーサが受理する正規英コマンド (intent 変換 + 自己修正ループ)
- 出口: ゲームの英語出力 → 日本語 (固有名詞グロッサリで表記一貫)
- ゲーム本体 (story file) もインタプリタも無改造。手持ちの `.z3/.z5/.z8/.zblorb` を読み込んで遊べます

## Web プレイヤー (段階2a)

ブラウザだけで動く静的アプリです。VM は [emglken](https://github.com/curiousdannii/emglken) (Bocfel, WASM) を埋め込み、LLM はお手持ちの OpenAI 互換 endpoint (BYO) に接続します。

```bash
npm install
npm run build:web        # dist/ を生成
npx vite preview         # ローカルで配信 (または GitHub Pages へデプロイ)
```

1. 画面右上「設定」で LLM 接続先を設定 (例: LM Studio `http://127.0.0.1:1234/v1`)
2. 「接続テスト」で疎通を確認 (モデル一覧 → 失敗時は chat 疎通にフォールバック)
3. サンプル (Dark Pit, MIT) を起動するか、手持ちの story file を読み込む
4. 日本語で指示 (「周りを見る」「老人と話す」…)。送信された英コマンドは薄色で常時表示され、「原文」ボタンで英語原文を併記できます。会話メニューはボタンで選択できます

### LLM 接続と CORS

ブラウザから LLM サーバーへ直接続するため、サーバー側で CORS を許可する必要があります。

| 接続先 | CORS 設定 | 確認状況 |
|---|---|---|
| LM Studio | Settings → Developer → **Enable CORS** | CORS 無効時は下記 proxy で動作確認済み |
| Ollama | 環境変数 `OLLAMA_ORIGINS=*` (または対象 origin) | 未実測 (公式仕様) |
| llama.cpp server | 既定で CORS 許可 | 未実測 (公式仕様) |
| OpenAI / OpenRouter 等クラウド | サービス側で許可済みのことが多い | 未実測。**高額キーのブラウザ利用は非推奨** |

**Chrome をお使いの場合**: 公開サイト (https) からローカル LLM (http://127.0.0.1) への初回接続時に「ローカルネットワークへのアクセス」許可を求められます。「許可」を選んでください。

CORS を有効にできない場合は同梱の中継 CLI を使ってください:

```bash
npm run proxy -- --target http://127.0.0.1:1234
# 表示された Base URL (トークン入り) をアプリの設定に貼り付ける
```

中継は 127.0.0.1 のみ bind し、起動毎のランダムトークンを必須にし、転送先は起動時に固定されます (踏み台化防止)。API key は保存・注入せず素通しします。許可 origin は localhost/127.0.0.1 と公式 Pages (https://h-o-soft.github.io) が既定で、その他は `--origin` で追加します。

### API key の取り扱い

- API key は既定で**メモリ保持のみ** (リロードで消えます)。保存はチェックボックスで明示 opt-in
- 静的サイトのため、key が第三者サーバーへ送られることはありません (接続先はあなたが設定した endpoint のみ)
- 高額なクラウド key の利用は非推奨です (ローカル LLM か使い捨て key を推奨)

### セーブ

ゲーム内 `save`/`restore` (画面の「保存」「再開」ボタン) は、ブラウザの IndexedDB にゲーム別 (SHA-256) で保存されます。

## CLI 版 (段階1) と検証

```bash
brew install frotz       # dfrotz 同梱
cp config.example.json config.json
npm run play             # 日本語で対話プレイ (dfrotz)
npm test                 # vitest (refs/ や LM Studio が無いテストはスキップ)
npm run verify -- --engine emglken   # transcript 検証 (要 refs/ + fixtures)
npx tsx src/verify/engine-parity.ts  # dfrotz vs emglken の移植パリティ検証
npm run e2e              # Playwright ブラウザ煙テスト (要 npm run build:web)
```

詳細は CLAUDE.md を参照。

## ライセンス

本プロジェクトは MIT License。バンドルする VM (Bocfel / Glulxe / AsyncGlk / RemGlk-rs) はすべて MIT です (GPL のエンジンはバンドルしません — CI で検査)。同梱サンプル Dark Pit は Andy Kosela 作 (MIT、`public/games/` に license 同梱)。ゲームファイルの著作権は各作者に帰属します。
