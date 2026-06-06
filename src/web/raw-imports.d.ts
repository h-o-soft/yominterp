/** Vite の ?raw import (ビルド時に文字列として埋め込み) の型宣言 */
declare module '*?raw' {
  const content: string;
  export default content;
}

/** Vite の ?url import (アセット URL) の型宣言 */
declare module '*?url' {
  const url: string;
  export default url;
}
