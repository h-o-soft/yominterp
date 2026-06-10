/**
 * セーブの永続化 (SaveStore の IndexedDB 実装) とスロット選択 UI (DialogPort 実装)。
 * キー = storyId (SHA-256 + 形式) + スロット名 (plan.md 段階2 §5)。
 */
import type { LanguageCode } from '../core/i18n/language.js';
import { t } from './i18n/messages.js';
import { del as idbDel, get as idbGet, keys as idbKeys, set as idbSet } from 'idb-keyval';
import type { DialogPort, SaveStore } from './engine/dialog.js';

export class IdbSaveStore implements SaveStore {
  constructor(private readonly storyId: string) {}

  private prefix(): string {
    return `save:${this.storyId}:`;
  }

  async list(): Promise<string[]> {
    const all = (await idbKeys()) as string[];
    return all
      .filter((k) => typeof k === 'string' && k.startsWith(this.prefix()))
      .map((k) => k.slice(this.prefix().length));
  }

  async get(name: string): Promise<Uint8Array | undefined> {
    return (await idbGet<Uint8Array>(this.prefix() + name)) ?? undefined;
  }

  async put(name: string, data: Uint8Array): Promise<void> {
    await idbSet(this.prefix() + name, data);
  }

  async delete(name: string): Promise<void> {
    await idbDel(this.prefix() + name);
  }
}

/** <dialog> ベースのスロット選択 (save: 名前入力+既存上書き / restore: 既存から選択) */
export class ModalDialogPort implements DialogPort {
  /** 現在の UI 言語を返す関数 (言語変更に追従) */
  constructor(private readonly getLang: () => LanguageCode = () => 'ja') {}

  requestSaveSlot(mode: 'save' | 'restore', existing: string[]): Promise<string | null> {
    const dialog = document.getElementById('save-dialog') as HTMLDialogElement;
    const title = document.getElementById('save-title')!;
    const slots = document.getElementById('save-slots')!;
    const nameRow = document.getElementById('save-name-row') as HTMLElement;
    const nameInput = document.getElementById('save-name') as HTMLInputElement;
    const okButton = document.getElementById('save-ok') as HTMLButtonElement;

    const lang = this.getLang();
    title.textContent = mode === 'save' ? t(lang, 'saveTitle') : t(lang, 'loadTitle');
    nameRow.hidden = mode === 'restore';
    okButton.hidden = mode === 'restore';
    slots.innerHTML = '';

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        dialog.close();
        resolve(value);
      };

      if (mode === 'restore' && existing.length === 0) {
        slots.textContent = t(lang, 'noSaves');
      }
      for (const name of existing) {
        const b = document.createElement('button');
        b.type = 'button';
        // 保存名は拡張子付き (例: slot1.glksave) — 表示は拡張子なし
        const display = name.replace(/\.(glksave|qzl|sav)$/i, '');
        b.textContent = mode === 'save' ? t(lang, 'overwrite', { name: display }) : display;
        b.addEventListener('click', () => settle(display));
        slots.appendChild(b);
      }
      if (mode === 'save') {
        nameInput.value = `slot${existing.length + 1}`;
        okButton.onclick = (e) => {
          e.preventDefault();
          const v = nameInput.value.trim().replace(/[^\w-]/g, '');
          if (v !== '') settle(v);
        };
      }
      dialog.addEventListener('close', () => settle(null), { once: true });
      dialog.showModal();
      if (mode === 'save') nameInput.focus();
    });
  }
}
