/**
 * セーブ/ロードの境界 (plan.md §5):
 *
 *   VM の fileref 要求 → EmglkenEngine が DialogPort へ委譲 (UI 境界)
 *   ファイルの永続化は SaveStore (永続境界)
 *
 * EmglkenDialog は AsyncGlk の Dialog インターフェース実装で、
 * storyfile のメモリ供給と SaveStore への読み書きを仲介する。
 * DOM/IndexedDB に依存しない (Web 実装は SaveStore/DialogPort 側で注入)。
 */

/** UI 境界: セーブスロットの選択/命名 (キャンセルは null) */
export interface DialogPort {
  requestSaveSlot(mode: 'save' | 'restore', existing: string[]): Promise<string | null>;
}

/** 永続境界: セーブデータ KV */
export interface SaveStore {
  list(): Promise<string[]>;
  get(name: string): Promise<Uint8Array | undefined>;
  put(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

/** メモリ実装 (Node 検証・テスト用) */
export class MemorySaveStore implements SaveStore {
  private readonly map = new Map<string, Uint8Array>();
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async get(name: string): Promise<Uint8Array | undefined> {
    return this.map.get(name);
  }
  async put(name: string, data: Uint8Array): Promise<void> {
    this.map.set(name, data);
  }
  async delete(name: string): Promise<void> {
    this.map.delete(name);
  }
}

/** 自動応答 DialogPort (Node 検証用): 固定スロット名を返す */
export class AutoDialogPort implements DialogPort {
  constructor(private readonly slotName: string | null = 'autosave') {}
  async requestSaveSlot(): Promise<string | null> {
    return this.slotName;
  }
}

const STORY_DIR = '/story/';
const SAVE_DIR = '/saves'; // VM が `${working}/${名前}${拡張子}` を組み立てる (実機採取)

/**
 * AsyncGlk の Dialog インターフェース実装。
 * - storyfile はメモリ供給 (`/story/<name>`)
 * - セーブ類 (`/saves/...`) は SaveStore へ
 * 実機採取 (2026-06-06): write のデータは WASM ヒープのビューなので必ずコピーする。
 */
export class EmglkenDialog {
  readonly 'async' = true;
  private readonly story = new Map<string, Uint8Array>();

  constructor(private readonly saves: SaveStore) {}

  setStory(name: string, data: Uint8Array): string {
    const path = STORY_DIR + name;
    this.story.set(path, data);
    return path;
  }

  /** SaveStore 上の名前 ↔ Dialog パス */
  static savePath(name: string): string {
    return `${SAVE_DIR}/${name}`;
  }
  static saveName(path: string): string {
    return path.startsWith(`${SAVE_DIR}/`) ? path.slice(SAVE_DIR.length + 1) : path;
  }

  async init(): Promise<void> {}

  async delete(path: string): Promise<void> {
    await this.saves.delete(EmglkenDialog.saveName(path));
  }

  async exists(path: string): Promise<boolean> {
    if (this.story.has(path)) return true;
    return (await this.saves.get(EmglkenDialog.saveName(path))) !== undefined;
  }

  get_dirs(): Record<string, string> {
    return { storyfile: STORY_DIR, system_cwd: SAVE_DIR, temp: SAVE_DIR, working: SAVE_DIR };
  }

  /** fileref は GlkOte specialinput 側で処理するため、ここへは来ない想定 (来たらキャンセル) */
  prompt(_extension: string, _save: boolean): Promise<string | null> {
    return Promise.resolve(null);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const story = this.story.get(path);
    if (story !== undefined) return story;
    const save = await this.saves.get(EmglkenDialog.saveName(path));
    return save ?? null;
  }

  set_storyfile_dir(path: string): Record<string, string> {
    return { storyfile: path, working: SAVE_DIR };
  }

  async write(files: Record<string, Uint8Array>): Promise<void> {
    for (const [path, data] of Object.entries(files)) {
      // WASM ヒープのビュー対策で必ずコピー
      await this.saves.put(EmglkenDialog.saveName(path), new Uint8Array(data));
    }
  }
}
