/** emglken 0.7.2 の最小型宣言 (パッケージに .d.ts が無いため) */
declare module 'emglken' {
  export interface EmglkenVMStartOptions {
    arguments: string[];
    GlkOte: unknown;
    Dialog: unknown;
  }
  export interface EmglkenVM {
    start(options: EmglkenVMStartOptions): Promise<void>;
  }
  /** 各エンジンは Emscripten モジュールファクトリ (await で VM インスタンス) */
  export type VMFactory = () => Promise<EmglkenVM>;
  export const Bocfel: VMFactory;
  export const BocfelNoZ6: VMFactory;
  export const Git: VMFactory;
  export const Glulxe: VMFactory;
  export const Hugo: VMFactory;
  export const Scare: VMFactory;
  export const TADS: VMFactory;
}
