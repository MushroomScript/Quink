// 引用笔记块的内联渲染（v-html 用）。
// 老笔记里 label 可能带前缀 "📌"，新笔记不再带，渲染时统一剥掉再加 phosphor 图标，
// 避免出现"两个图标"的情况。
//
// 注意分两步：markdown 阶段先生成不带图标的 span，md2html 之后再用 injectRefLinkIcons
// 把 SVG 注入进去。直接把 SVG 写进 markdown，Vditor (lute) 解析器会把 span 的
// class/data-ref 一起破坏掉，导致全局 click 监听找不到 .note-ref-link、引用预览弹不出。

const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="0.75em" height="0.75em" fill="currentColor" style="display:inline-block;vertical-align:-0.125em;margin-right:0.25em;pointer-events:none"><path d="M235.33,104l-53.47,53.65c4.56,12.67,6.45,33.89-13.19,60A15.93,15.93,0,0,1,157,224c-.38,0-.75,0-1.13,0a16,16,0,0,1-11.32-4.69L96.29,171,53.66,213.66a8,8,0,0,1-11.32-11.32L85,159.71l-48.3-48.3A16,16,0,0,1,38,87.63c25.42-20.51,49.75-16.48,60.4-13.14L152,20.7a16,16,0,0,1,22.63,0l60.69,60.68A16,16,0,0,1,235.33,104Z"/></svg>';

export const REF_LINK_REGEX = /\[([\s\S]*?)\]\((\/?[?&]ref=[^)]+)\)/g;

export function renderRefLink(label: string, href: string, maxLen = 30): string {
  const clean = label
    .replace(/^📌\s*/, '')
    .replace(/[\n\r#*`\[\]!>~]/g, ' ')
    .trim()
    .slice(0, maxLen) || '引用笔记';
  return `<span class="note-ref-link" data-ref="${href}">${clean}</span>`;
}

// md2html 之后调用，把图钉 SVG 注入到 span 里。
export function injectRefLinkIcons(html: string): string {
  return html.replace(
    /(<span class="note-ref-link" data-ref="[^"]+">)/g,
    `$1${PIN_SVG}`
  );
}
