// libheif-js 没发布官方 TS types. 我们只用 wasm-bundle 入口 + decoder.decode() / image.display() 两个方法,
// 用 minimal shape 声明替代 implicit-any. 实际用法参见 utils/heicThumb.ts
declare module 'libheif-js/wasm-bundle' {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      buffer: { data: Uint8ClampedArray; width: number; height: number },
      callback: (display: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
    ): void;
  }
  interface HeifDecoder {
    decode(buffer: Buffer | Uint8Array): HeifImage[];
  }
  const libheif: {
    HeifDecoder: new () => HeifDecoder;
  };
  export default libheif;
}
