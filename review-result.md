**高**
- [src/web/main.ts:727](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:727) の `wireSettings()` が `<option>` 生成後に `langSelect.value = settings.language` を初期化していません。`settings.language=fr` で起動すると [applyUiLanguage](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:718) は UI を fr にしますが、select はブラウザ既定で先頭の ja を選びます。さらに [auto-open](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:979) は設定ボタンの click handler を通らないため、報告の「UI=fr なのにセレクタ表示が日本語」はこの経路で再現します。close/change 時の [commit](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:744) がその ja を保存してしまう点も危険です。  
  推奨: `syncSettingsFormFromState()` を作り、option 生成直後、設定ボタン open 前、auto-open 前に必ず呼ぶ。`langSelect.value` だけでなく baseUrl/model/apiKey/persist も同時に hydrate してください。

- [src/web/main.ts:744](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:744) で言語変更を即 `settings.language` に反映し UI を切り替えますが、実際の entry/exit/session はゲーム開始時の [settings.language](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:646) を捕捉したままです。つまりゲーム中に ja から fr に変えると、UI/placeholder/save dialog は fr、本文翻訳・入力変換・キャッシュ名前空間は ja のままになり得ます。注意書きの「次に開くゲームから反映」と実装が矛盾しています。  
  推奨: `pendingLanguage` と `activeLanguage` を分けるか、ゲーム中の言語変更は次ゲームまで UI にも適用しない。即時適用するなら entry/exit/session/cache を作り直す必要があります。

**中**
- 非 ja 経路に日本語固定プロンプト/文言が残っています。[retry instruction](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/translate/entry.ts:244)、[retranslate instruction](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/translate/entry.ts:273)、[selectMenuOption system](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/translate/entry.ts:307)、Web の [メニュー終了語/エラー](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:579) が該当します。entry/exit のメイン prompt は fail closed ですが、補助プロンプトが日本語なので非 ja の自己修正・メニュー選択品質が落ちます。  
  推奨: これらも `LanguageProfile` または prompt fragment/message catalog 化する。

- `TurnError.source` 分離自体は入っており、Web/CLI も source で翻訳要否を判定しています。ただし app error は [session.ts:185](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/session.ts:185) に日本語文字列として埋め込まれ、非 ja でも翻訳されません。  
  推奨: core は `{ source:'app', code:'noCommands' }` のようなコードを返し、Web/CLI 側で `t()` する。

- i18n 適用漏れがあります。`nameLabel` は catalog にあるのに [index.html:95](/Users/ogino/ghq/github.com/ogino/zmachine-llm/index.html:95) の「名前」ラベルへ適用されていません。また [src/web/main.ts:590](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:590) は `noSuchChoice` を使わず日本語直書きです。  
  推奨: `data-i18n`/`tr('noSuchChoice')` を使い、DOM 上の `data-i18n*` 全キーを走査するテストを追加する。

**低**
- 出口翻訳キャッシュキーは [language + promptHash + model + glossaryHash](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/translate/exit.ts:171) で、言語混在対策としては概ね十分です。ただし glossary 構築キャッシュ [exit-glossary](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/core/translate/exit.ts:103) は `GLOSSARY_SYSTEM` の hash を含まないため、glossary prompt 改訂時に古い用語集を再利用します。  
  推奨: glossary cache key に glossary prompt hash も含める。

- 非 ja few-shot は ja よりかなり薄く、es/de/pt-BR は文脈参照、yes/no、数字列、meta、固有名詞の例が不足しています。META_INTENT も de の `zurück` など、移動の「戻る」と undo が衝突し得る語があります。  
  推奨: 言語別の golden/eval と meta guard テストを増やす。

- URL から開く経路は [任意 URL を fetch](/Users/ogino/ghq/github.com/ogino/zmachine-llm/src/web/main.ts:817) して全量 `arrayBuffer()` にしています。ユーザー操作起点なので重大ではありませんが、サイズ上限と拡張子/magic byte の早期チェックは入れた方が安全です。API key は既定 in-memory で、localStorage 永続化が opt-in なのは妥当です。

**観点3の根本原因**
起動順は `settings = loadSettings()`、`wireSettings()`、`applyUiLanguage()`、`showWelcome()` です。`wireSettings()` は option だけ作り、select の値を設定しません。そのため保存済み `fr` でも select は先頭の `ja` になります。その後 `applyUiLanguage()` が `settings.language=fr` で UI を fr 化するため、「UI は fr、セレクタは 日本語」が成立します。特に `settings.model === ''` の auto-open は設定ボタン click の初期化処理を通らないため、このずれが露出します。close/change commit が走ると、ずれた ja が保存されるので、タイミング次第でゲーム開始時の適用言語まで変わります。

**総評**
core の言語レジストリ、entry/exit prompt の fail closed、出口キャッシュの言語分離、`TurnError.source` の方向性は良いです。ja prompt/few-shot 自体は差分なしです。ただし Web の言語セレクタ初期化と active/pending language の不整合はマージ前に直すべきです。このままのマージは見送りが妥当です。

検証: 関連 vitest を実行しようとしましたが、読み取り専用環境で Vite が `node_modules/.vite-temp` に書けず `EPERM` で起動前失敗しました。