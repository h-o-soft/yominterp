import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages (サブパス) でも動くよう相対パス
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  // emglken の wasm は import.meta.url 経由で解決される (Vite が asset 化する)
});
