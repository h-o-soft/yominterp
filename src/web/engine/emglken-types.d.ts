/** emglken 0.7.2 の最小型宣言 (パッケージに .d.ts が無いため) */
declare module 'emglken' {
  export interface EmglkenVMStartOptions {
    arguments: string[];
    GlkOte: unknown;
    Dialog: unknown;
  }
  export interface EmglkenVM {
    start(options: EmglkenVMStartOptions): void;
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

/**
 * エンジン個別の直接 import 用宣言。
 * 注意: バンドルでは必ずこちらを使う — 'emglken' (index) を import すると
 * GPL の tads/scare を含む全 wasm が dist に混入する (Vite ビルドで実測)。
 */
declare module 'emglken/build/bocfel.js' {
  import type { VMFactory } from 'emglken';
  const factory: VMFactory;
  export default factory;
}
declare module 'emglken/build/glulxe.js' {
  import type { VMFactory } from 'emglken';
  const factory: VMFactory;
  export default factory;
}
declare module 'emglken/build/git.js' {
  import type { VMFactory } from 'emglken';
  const factory: VMFactory;
  export default factory;
}
