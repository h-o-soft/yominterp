/**
 * UI メッセージカタログ (フェーズC)。core の外 (Web 専用)。
 *
 * - キー → 各言語の文字列。{placeholder} は t() の params で差し込む。
 * - 既定 ja は既存の文言をそのまま (回帰ゼロ)。
 * - 未訳 (キー欠落) は **英語風のキー名を可視表示** して気づけるようにする
 *   (静かな日本語フォールバックはしない)。
 */
import type { LanguageCode } from '../../core/i18n/language.js';

export type MessageKey =
  | 'moreBar'
  | 'keyWaitBar'
  | 'scoreLabel'
  | 'movesLabel'
  | 'endConversation'
  | 'enterEndsConversation'
  | 'conversationEnded'
  | 'inputPlaceholder'
  | 'inputPlaceholderExample'
  | 'inputPlaceholderMenu'
  | 'yes'
  | 'no'
  | 'send'
  | 'gameOverBanner'
  | 'loadNewGameHint'
  | 'thinking'
  | 'corrected'
  | 'abortedRest'
  | 'noSuchChoice'
  | 'welcomeSubtitle'
  | 'welcomeHint'
  | 'rawCommandHint'
  | 'menuOpen'
  | 'menuRaw'
  | 'menuSave'
  | 'menuRestore'
  | 'menuSettings'
  | 'menuTitle'
  | 'statusTitle'
  | 'docTitle'
  | 'settingsTitle'
  | 'llmConnection'
  | 'baseUrlLabel'
  | 'apiKeyLabel'
  | 'apiKeyPersist'
  | 'modelLabel'
  | 'connectionTest'
  | 'checking'
  | 'gameSection'
  | 'openFile'
  | 'openUrl'
  | 'formatSupport'
  | 'playLanguage'
  | 'languageLabel'
  | 'betaNotice'
  | 'otherSection'
  | 'downloadLog'
  | 'aboutText'
  | 'close'
  | 'urlPrompt'
  | 'saveTitle'
  | 'loadTitle'
  | 'nameLabel'
  | 'ok'
  | 'cancel'
  | 'noSaves'
  | 'overwrite'
  | 'error'
  | 'translateError'
  | 'loadGameFirst'
  | 'gameEnded'
  | 'glulxNotReady'
  | 'dictExtractFail'
  | 'glossaryPreparing'
  | 'llmConnectFail'
  | 'settingsHint'
  | 'startError'
  | 'startingGame'
  | 'urlLoadFail'
  | 'connectOk'
  | 'connectOkChat'
  | 'connectNg'
  | 'appNoCommands';

type Catalog = Record<MessageKey, string>;

const ja: Catalog = {
  moreBar: '—— [More] クリックまたはキーで続き ——',
  keyWaitBar: '—— キーを押して続行 ——',
  scoreLabel: '得点',
  movesLabel: '手数',
  endConversation: '会話を終える',
  enterEndsConversation: '  (空 Enter: 会話を終える)',
  conversationEnded: '(会話を終える)',
  inputPlaceholder: '日本語で指示してください',
  inputPlaceholderExample: '日本語で指示してください (例: 周りを見る)',
  inputPlaceholderMenu: '番号/文字で選択、または日本語で指示',
  yes: 'はい',
  no: 'いいえ',
  send: '送信',
  gameOverBanner: '―― ゲーム終了 ――',
  loadNewGameHint: '設定から新しいゲームを読み込めます',
  thinking: '考え中…',
  corrected: '(自己修正)',
  abortedRest: '(途中で失敗したため残りの動作は中止しました)',
  noSuchChoice: 'その選択肢はありません ({keys})',
  welcomeSubtitle: '英語のインタラクティブフィクションを日本語で遊ぶ',
  rawCommandHint: '英語のコマンドは行頭に > を付けると、翻訳せず直接入力できます。',
  welcomeHint: '右上の ☰ メニュー →「開く」でゲームを読み込み、「設定」で LLM 接続先を指定してください',
  menuOpen: '📂 開く…',
  menuRaw: '原文の表示',
  menuSave: 'セーブ',
  menuRestore: 'ロード',
  menuSettings: '設定…',
  menuTitle: 'メニュー',
  statusTitle: 'ステータス行 (場所名・得点・手数 等)',
  docTitle: 'yominterp — 英語IFを遊ぶ',
  settingsTitle: '設定',
  llmConnection: 'LLM 接続 (OpenAI 互換)',
  baseUrlLabel: 'Base URL',
  apiKeyLabel: 'API Key',
  apiKeyPersist: 'このブラウザに保存する (既定はメモリのみ。共有PCでは保存しないでください)',
  modelLabel: 'モデル',
  connectionTest: '接続テスト',
  checking: '確認中…',
  gameSection: 'ゲーム',
  openFile: 'ファイルを開く…',
  openUrl: 'URLから開く…',
  formatSupport: '対応: .z3 .z4 .z5 .z8 .zblorb (Glulx は今後対応予定)',
  playLanguage: 'プレイ言語',
  languageLabel: '言語',
  betaNotice:
    '⚠ 多言語は実験的機能です。翻訳の品質は使う LLM のモデルに大きく依存します。既定は日本語。日本語以外を選ぶと入力・ゲーム表示がその言語になります。変更は次に開くゲームから反映されます。',
  otherSection: 'その他',
  downloadLog: 'ログをダウンロード',
  aboutText:
    'VM: emglken (Bocfel/Glulxe — MIT)。本アプリは MIT ライセンスで、ゲームファイルはユーザーが用意します。',
  close: '閉じる',
  urlPrompt: 'ストーリーファイルの URL (.z3/.z5/.z8 等):',
  saveTitle: 'セーブ',
  loadTitle: 'ロード',
  nameLabel: '名前',
  ok: '決定',
  cancel: 'キャンセル',
  noSaves: '(セーブデータがありません)',
  overwrite: '上書き: {name}',
  error: 'エラー: {err}',
  translateError: '翻訳エラー: {err} — 原文を表示します',
  loadGameFirst: '先に設定からゲームを読み込んでください',
  gameEnded: 'ゲームは終了しています。設定から新しいゲームを読み込んでください',
  glulxNotReady: 'Glulx 対応は準備中です。Z-code (.z3/.z5/.z8/.zblorb) をご利用ください',
  dictExtractFail: '辞書抽出に失敗しました (辞書なしで続行): {err}',
  glossaryPreparing: '固有名詞の用語集を準備中…',
  llmConnectFail: 'LLM に接続できません (原文表示で続行): {err}',
  settingsHint: '右上の「設定」→ 接続テストで接続を確認できます',
  startError: '起動エラー: {err}',
  startingGame: '{filename} を起動中…',
  urlLoadFail: 'URL からの読み込みに失敗: {err} (配信元が CORS を許可している必要があります)',
  connectOk: '接続 OK (モデル {n} 件)',
  connectOkChat: '接続 OK (chat 疎通)',
  connectNg: '{err}',
  appNoCommands: 'LLM がコマンドを生成できませんでした。別の言い方を試してください。',
};

const fr: Catalog = {
  moreBar: '—— [Plus] cliquez ou appuyez sur une touche ——',
  keyWaitBar: '—— Appuyez sur une touche pour continuer ——',
  scoreLabel: 'Score',
  movesLabel: 'Coups',
  endConversation: 'Terminer la conversation',
  enterEndsConversation: '  (Entrée vide : terminer la conversation)',
  conversationEnded: '(terminer la conversation)',
  inputPlaceholder: 'Donnez un ordre en français',
  inputPlaceholderExample: 'Donnez un ordre en français (ex. : regarder autour)',
  inputPlaceholderMenu: 'Choisissez par numéro/lettre, ou donnez un ordre',
  yes: 'oui',
  no: 'non',
  send: 'Envoyer',
  gameOverBanner: '―― Fin de la partie ――',
  loadNewGameHint: 'Vous pouvez charger une nouvelle partie depuis les réglages',
  thinking: 'Réflexion…',
  corrected: '(corrigé)',
  abortedRest: '(échec en cours de route : les actions restantes ont été annulées)',
  noSuchChoice: "Ce choix n'existe pas ({keys})",
  welcomeSubtitle: 'Jouez à la fiction interactive anglaise dans votre langue',
  rawCommandHint: 'Une commande anglaise peut être envoyée telle quelle en la faisant précéder de >.',
  welcomeHint:
    'Menu ☰ en haut à droite → « Ouvrir » pour charger une partie, « Réglages » pour le LLM',
  menuOpen: '📂 Ouvrir…',
  menuRaw: "Afficher l'original",
  menuSave: 'Sauvegarder',
  menuRestore: 'Charger',
  menuSettings: 'Réglages…',
  menuTitle: 'Menu',
  statusTitle: 'Ligne d’état (lieu, score, coups…)',
  docTitle: 'yominterp — jouer aux fictions interactives anglaises',
  settingsTitle: 'Réglages',
  llmConnection: 'Connexion LLM (compatible OpenAI)',
  baseUrlLabel: 'URL de base',
  apiKeyLabel: 'Clé API',
  apiKeyPersist:
    'Enregistrer dans ce navigateur (par défaut en mémoire seulement ; ne pas enregistrer sur un PC partagé)',
  modelLabel: 'Modèle',
  connectionTest: 'Tester la connexion',
  checking: 'Vérification…',
  gameSection: 'Jeu',
  openFile: 'Ouvrir un fichier…',
  openUrl: 'Ouvrir une URL…',
  formatSupport: 'Pris en charge : .z3 .z4 .z5 .z8 .zblorb (Glulx à venir)',
  playLanguage: 'Langue de jeu',
  languageLabel: 'Langue',
  betaNotice:
    '⚠ Le multilingue est une fonction expérimentale. La qualité dépend fortement du modèle LLM utilisé. Par défaut : japonais. Choisir une autre langue change la saisie et l’affichage du jeu. Le changement s’applique à la prochaine partie ouverte.',
  otherSection: 'Autres',
  downloadLog: 'Télécharger le journal',
  aboutText:
    'VM : emglken (Bocfel/Glulxe — MIT). Application sous licence MIT ; les fichiers de jeu sont fournis par l’utilisateur.',
  close: 'Fermer',
  urlPrompt: 'URL du fichier de jeu (.z3/.z5/.z8, etc.) :',
  saveTitle: 'Sauvegarder',
  loadTitle: 'Charger',
  nameLabel: 'Nom',
  ok: 'Valider',
  cancel: 'Annuler',
  noSaves: '(aucune sauvegarde)',
  overwrite: 'Écraser : {name}',
  error: 'Erreur : {err}',
  translateError: 'Erreur de traduction : {err} — affichage de l’original',
  loadGameFirst: 'Chargez d’abord une partie depuis les réglages',
  gameEnded: 'La partie est terminée. Chargez une nouvelle partie depuis les réglages',
  glulxNotReady: 'La prise en charge de Glulx est en préparation. Utilisez du Z-code (.z3/.z5/.z8/.zblorb)',
  dictExtractFail: 'Échec de l’extraction du dictionnaire (poursuite sans) : {err}',
  glossaryPreparing: 'Préparation du glossaire des noms propres…',
  llmConnectFail: 'Connexion au LLM impossible (poursuite avec l’original) : {err}',
  settingsHint: '« Réglages » en haut à droite → Tester la connexion',
  startError: 'Erreur de démarrage : {err}',
  startingGame: 'Démarrage de {filename}…',
  urlLoadFail: 'Échec du chargement de l’URL : {err} (la source doit autoriser le CORS)',
  connectOk: 'Connexion OK ({n} modèles)',
  connectOkChat: 'Connexion OK (chat)',
  connectNg: '{err}',
  appNoCommands: 'Le LLM n’a pas pu générer de commande. Essayez une autre formulation.',
};

const es: Catalog = {
  moreBar: '—— [Más] haz clic o pulsa una tecla ——',
  keyWaitBar: '—— Pulsa una tecla para continuar ——',
  scoreLabel: 'Puntos',
  movesLabel: 'Jugadas',
  endConversation: 'Terminar la conversación',
  enterEndsConversation: '  (Intro vacío: terminar la conversación)',
  conversationEnded: '(terminar la conversación)',
  inputPlaceholder: 'Da una orden en español',
  inputPlaceholderExample: 'Da una orden en español (ej.: mirar alrededor)',
  inputPlaceholderMenu: 'Elige por número/letra, o da una orden',
  yes: 'sí',
  no: 'no',
  send: 'Enviar',
  gameOverBanner: '―― Fin de la partida ――',
  loadNewGameHint: 'Puedes cargar una partida nueva desde los ajustes',
  thinking: 'Pensando…',
  corrected: '(corregido)',
  abortedRest: '(fallo a mitad: se cancelaron las acciones restantes)',
  noSuchChoice: 'Esa opción no existe ({keys})',
  welcomeSubtitle: 'Juega a la ficción interactiva en inglés en tu idioma',
  rawCommandHint: 'Puedes enviar un comando en inglés tal cual anteponiendo >.',
  welcomeHint:
    'Menú ☰ arriba a la derecha → «Abrir» para cargar una partida, «Ajustes» para el LLM',
  menuOpen: '📂 Abrir…',
  menuRaw: 'Mostrar el original',
  menuSave: 'Guardar',
  menuRestore: 'Cargar',
  menuSettings: 'Ajustes…',
  menuTitle: 'Menú',
  statusTitle: 'Línea de estado (lugar, puntos, jugadas…)',
  docTitle: 'yominterp — juega ficción interactiva en inglés',
  settingsTitle: 'Ajustes',
  llmConnection: 'Conexión LLM (compatible con OpenAI)',
  baseUrlLabel: 'URL base',
  apiKeyLabel: 'Clave API',
  apiKeyPersist:
    'Guardar en este navegador (por defecto solo en memoria; no guardar en un PC compartido)',
  modelLabel: 'Modelo',
  connectionTest: 'Probar conexión',
  checking: 'Comprobando…',
  gameSection: 'Juego',
  openFile: 'Abrir archivo…',
  openUrl: 'Abrir URL…',
  formatSupport: 'Compatibles: .z3 .z4 .z5 .z8 .zblorb (Glulx próximamente)',
  playLanguage: 'Idioma de juego',
  languageLabel: 'Idioma',
  betaNotice:
    '⚠ El multilingüe es una función experimental. La calidad depende mucho del modelo LLM. Por defecto: japonés. Elegir otro idioma cambia la entrada y la pantalla del juego. El cambio se aplica a la próxima partida.',
  otherSection: 'Otros',
  downloadLog: 'Descargar registro',
  aboutText:
    'VM: emglken (Bocfel/Glulxe — MIT). App con licencia MIT; los archivos de juego los aporta el usuario.',
  close: 'Cerrar',
  urlPrompt: 'URL del archivo de juego (.z3/.z5/.z8, etc.):',
  saveTitle: 'Guardar',
  loadTitle: 'Cargar',
  nameLabel: 'Nombre',
  ok: 'Aceptar',
  cancel: 'Cancelar',
  noSaves: '(sin partidas guardadas)',
  overwrite: 'Sobrescribir: {name}',
  error: 'Error: {err}',
  translateError: 'Error de traducción: {err} — se muestra el original',
  loadGameFirst: 'Primero carga una partida desde los ajustes',
  gameEnded: 'La partida ha terminado. Carga una nueva desde los ajustes',
  glulxNotReady: 'La compatibilidad con Glulx está en preparación. Usa Z-code (.z3/.z5/.z8/.zblorb)',
  dictExtractFail: 'Error al extraer el diccionario (se continúa sin él): {err}',
  glossaryPreparing: 'Preparando el glosario de nombres propios…',
  llmConnectFail: 'No se puede conectar al LLM (se continúa con el original): {err}',
  settingsHint: '«Ajustes» arriba a la derecha → Probar conexión',
  startError: 'Error de inicio: {err}',
  startingGame: 'Iniciando {filename}…',
  urlLoadFail: 'Error al cargar la URL: {err} (la fuente debe permitir CORS)',
  connectOk: 'Conexión OK ({n} modelos)',
  connectOkChat: 'Conexión OK (chat)',
  connectNg: '{err}',
  appNoCommands: 'El LLM no pudo generar un comando. Prueba con otra formulación.',
};

const de: Catalog = {
  moreBar: '—— [Mehr] klicken oder Taste drücken ——',
  keyWaitBar: '—— Taste drücken, um fortzufahren ——',
  scoreLabel: 'Punkte',
  movesLabel: 'Züge',
  endConversation: 'Gespräch beenden',
  enterEndsConversation: '  (Leere Eingabe: Gespräch beenden)',
  conversationEnded: '(Gespräch beenden)',
  inputPlaceholder: 'Gib einen Befehl auf Deutsch ein',
  inputPlaceholderExample: 'Gib einen Befehl auf Deutsch ein (z. B.: umschauen)',
  inputPlaceholderMenu: 'Per Nummer/Buchstabe wählen oder einen Befehl eingeben',
  yes: 'ja',
  no: 'nein',
  send: 'Senden',
  gameOverBanner: '―― Spielende ――',
  loadNewGameHint: 'Du kannst in den Einstellungen ein neues Spiel laden',
  thinking: 'Denke nach…',
  corrected: '(korrigiert)',
  abortedRest: '(Fehler unterwegs: restliche Aktionen abgebrochen)',
  noSuchChoice: 'Diese Auswahl gibt es nicht ({keys})',
  welcomeSubtitle: 'Spiele englische Interactive Fiction in deiner Sprache',
  rawCommandHint: 'Englische Befehle lassen sich mit vorangestelltem > direkt eingeben.',
  welcomeHint:
    'Menü ☰ oben rechts → „Öffnen" zum Laden eines Spiels, „Einstellungen" für das LLM',
  menuOpen: '📂 Öffnen…',
  menuRaw: 'Original anzeigen',
  menuSave: 'Speichern',
  menuRestore: 'Laden',
  menuSettings: 'Einstellungen…',
  menuTitle: 'Menü',
  statusTitle: 'Statuszeile (Ort, Punkte, Züge…)',
  docTitle: 'yominterp — englische Interactive Fiction spielen',
  settingsTitle: 'Einstellungen',
  llmConnection: 'LLM-Verbindung (OpenAI-kompatibel)',
  baseUrlLabel: 'Basis-URL',
  apiKeyLabel: 'API-Schlüssel',
  apiKeyPersist:
    'In diesem Browser speichern (standardmäßig nur im Speicher; auf gemeinsam genutzten PCs nicht speichern)',
  modelLabel: 'Modell',
  connectionTest: 'Verbindung testen',
  checking: 'Prüfe…',
  gameSection: 'Spiel',
  openFile: 'Datei öffnen…',
  openUrl: 'URL öffnen…',
  formatSupport: 'Unterstützt: .z3 .z4 .z5 .z8 .zblorb (Glulx folgt)',
  playLanguage: 'Spielsprache',
  languageLabel: 'Sprache',
  betaNotice:
    '⚠ Mehrsprachigkeit ist eine experimentelle Funktion. Die Qualität hängt stark vom LLM-Modell ab. Standard: Japanisch. Eine andere Sprache ändert Eingabe und Spielanzeige. Die Änderung gilt ab dem nächsten geöffneten Spiel.',
  otherSection: 'Sonstiges',
  downloadLog: 'Protokoll herunterladen',
  aboutText:
    'VM: emglken (Bocfel/Glulxe — MIT). App unter MIT-Lizenz; Spieldateien stellt der Nutzer bereit.',
  close: 'Schließen',
  urlPrompt: 'URL der Spieldatei (.z3/.z5/.z8 usw.):',
  saveTitle: 'Speichern',
  loadTitle: 'Laden',
  nameLabel: 'Name',
  ok: 'OK',
  cancel: 'Abbrechen',
  noSaves: '(keine Spielstände)',
  overwrite: 'Überschreiben: {name}',
  error: 'Fehler: {err}',
  translateError: 'Übersetzungsfehler: {err} — Original wird angezeigt',
  loadGameFirst: 'Lade zuerst ein Spiel über die Einstellungen',
  gameEnded: 'Das Spiel ist beendet. Lade über die Einstellungen ein neues',
  glulxNotReady: 'Glulx-Unterstützung in Vorbereitung. Bitte Z-code (.z3/.z5/.z8/.zblorb) verwenden',
  dictExtractFail: 'Wörterbuch-Extraktion fehlgeschlagen (ohne fortgesetzt): {err}',
  glossaryPreparing: 'Eigennamen-Glossar wird vorbereitet…',
  llmConnectFail: 'Keine Verbindung zum LLM (mit Original fortgesetzt): {err}',
  settingsHint: '„Einstellungen" oben rechts → Verbindung testen',
  startError: 'Startfehler: {err}',
  startingGame: 'Starte {filename}…',
  urlLoadFail: 'Laden der URL fehlgeschlagen: {err} (die Quelle muss CORS erlauben)',
  connectOk: 'Verbindung OK ({n} Modelle)',
  connectOkChat: 'Verbindung OK (Chat)',
  connectNg: '{err}',
  appNoCommands: 'Das LLM konnte keinen Befehl erzeugen. Versuche eine andere Formulierung.',
};

const ptBR: Catalog = {
  moreBar: '—— [Mais] clique ou pressione uma tecla ——',
  keyWaitBar: '—— Pressione uma tecla para continuar ——',
  scoreLabel: 'Pontos',
  movesLabel: 'Jogadas',
  endConversation: 'Encerrar a conversa',
  enterEndsConversation: '  (Enter vazio: encerrar a conversa)',
  conversationEnded: '(encerrar a conversa)',
  inputPlaceholder: 'Dê um comando em português',
  inputPlaceholderExample: 'Dê um comando em português (ex.: olhar ao redor)',
  inputPlaceholderMenu: 'Escolha por número/letra, ou dê um comando',
  yes: 'sim',
  no: 'não',
  send: 'Enviar',
  gameOverBanner: '―― Fim de jogo ――',
  loadNewGameHint: 'Você pode carregar um novo jogo nas configurações',
  thinking: 'Pensando…',
  corrected: '(corrigido)',
  abortedRest: '(falha no meio: as ações restantes foram canceladas)',
  noSuchChoice: 'Essa opção não existe ({keys})',
  welcomeSubtitle: 'Jogue ficção interativa em inglês no seu idioma',
  rawCommandHint: 'Comandos em inglês podem ser enviados direto com > no início.',
  welcomeHint:
    'Menu ☰ no canto superior direito → "Abrir" para carregar um jogo, "Configurações" para o LLM',
  menuOpen: '📂 Abrir…',
  menuRaw: 'Mostrar o original',
  menuSave: 'Salvar',
  menuRestore: 'Carregar',
  menuSettings: 'Configurações…',
  menuTitle: 'Menu',
  statusTitle: 'Linha de status (local, pontos, jogadas…)',
  docTitle: 'yominterp — jogue ficção interativa em inglês',
  settingsTitle: 'Configurações',
  llmConnection: 'Conexão LLM (compatível com OpenAI)',
  baseUrlLabel: 'URL base',
  apiKeyLabel: 'Chave de API',
  apiKeyPersist:
    'Salvar neste navegador (padrão: apenas na memória; não salve em um PC compartilhado)',
  modelLabel: 'Modelo',
  connectionTest: 'Testar conexão',
  checking: 'Verificando…',
  gameSection: 'Jogo',
  openFile: 'Abrir arquivo…',
  openUrl: 'Abrir URL…',
  formatSupport: 'Suporte: .z3 .z4 .z5 .z8 .zblorb (Glulx em breve)',
  playLanguage: 'Idioma do jogo',
  languageLabel: 'Idioma',
  betaNotice:
    '⚠ O multilíngue é um recurso experimental. A qualidade depende muito do modelo de LLM. Padrão: japonês. Escolher outro idioma muda a entrada e a exibição do jogo. A mudança vale a partir do próximo jogo aberto.',
  otherSection: 'Outros',
  downloadLog: 'Baixar registro',
  aboutText:
    'VM: emglken (Bocfel/Glulxe — MIT). App sob licença MIT; os arquivos de jogo são fornecidos pelo usuário.',
  close: 'Fechar',
  urlPrompt: 'URL do arquivo de jogo (.z3/.z5/.z8, etc.):',
  saveTitle: 'Salvar',
  loadTitle: 'Carregar',
  nameLabel: 'Nome',
  ok: 'Confirmar',
  cancel: 'Cancelar',
  noSaves: '(sem jogos salvos)',
  overwrite: 'Sobrescrever: {name}',
  error: 'Erro: {err}',
  translateError: 'Erro de tradução: {err} — exibindo o original',
  loadGameFirst: 'Primeiro carregue um jogo nas configurações',
  gameEnded: 'O jogo terminou. Carregue um novo nas configurações',
  glulxNotReady: 'Suporte a Glulx em preparação. Use Z-code (.z3/.z5/.z8/.zblorb)',
  dictExtractFail: 'Falha ao extrair o dicionário (continuando sem ele): {err}',
  glossaryPreparing: 'Preparando o glossário de nomes próprios…',
  llmConnectFail: 'Não foi possível conectar ao LLM (continuando com o original): {err}',
  settingsHint: '"Configurações" no canto superior direito → Testar conexão',
  startError: 'Erro de inicialização: {err}',
  startingGame: 'Iniciando {filename}…',
  urlLoadFail: 'Falha ao carregar a URL: {err} (a origem precisa permitir CORS)',
  connectOk: 'Conexão OK ({n} modelos)',
  connectOkChat: 'Conexão OK (chat)',
  connectNg: '{err}',
  appNoCommands: 'O LLM não conseguiu gerar um comando. Tente outra formulação.',
};

const CATALOGS: Record<LanguageCode, Catalog> = { ja, es, fr, de, 'pt-BR': ptBR };

/**
 * UI 文言を引く。params で {placeholder} を差し込む。
 * 未訳 (キー欠落) は英語風キー名を [ ] で可視表示し、静かな ja フォールバックをしない。
 */
export function t(
  lang: LanguageCode,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const raw = CATALOGS[lang]?.[key];
  if (raw === undefined) return `[${key}]`; // 未訳が見えるように
  if (params === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));
}

/** index.html の data-i18n / data-i18n-title / data-i18n-placeholder を一括適用 */
export function applyDomI18n(lang: LanguageCode, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(lang, el.dataset.i18n as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(lang, el.dataset.i18nTitle as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(lang, el.dataset.i18nPlaceholder as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(lang, el.dataset.i18nAria as MessageKey));
  }
}
