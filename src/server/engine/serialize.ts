import type {CssDeclaration, CssMedia, CssNode, HtmlDoc, HtmlNode} from './ast';

export interface Range {start: number; end: number}
export type RangeMap = Map<string, Range>;

export interface SerializedHtml {
  html: string;
  ranges: RangeMap;
  /** id -> 所在 <style> 内的局部范围（对 CSS 节点） */
  sheetRanges: Map<string, {sheetId: string; ranges: RangeMap}>;
  /** 内联样式：元素 id -> 声明 id -> 局部范围 */
  inlineRanges: Map<string, Map<string, Range>>;
}

class Writer {
  private parts: string[] = [];
  private pos = 0;
  constructor(private ranges: RangeMap) {}
  get position() { return this.pos; }
  text(s: string) { this.parts.push(s); this.pos += s.length; }
  /** 写入并把整段输出区间记到 id 上 */
  mark(id: string, fn: () => void) {
    const start = this.pos;
    fn();
    this.ranges.set(id, {start, end: this.pos});
  }
  get out() { return this.parts.join(''); }
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function hasPrintable(nodes: CssNode[]): boolean {
  for (const n of nodes) {
    if (n.detached) continue;
    if (n.kind === 'rule') {
      if (n.declarations.some(d => !d.detached)) return true;
    } else if (n.kind === 'media') {
      if (hasPrintable(n.children)) return true;
    } else {
      return true;
    }
  }
  return false;
}

function serializeSheet(nodes: CssNode[], ranges: RangeMap): string {
  const parts: string[] = [];
  let pos = 0;
  const push = (s: string) => { parts.push(s); pos += s.length; };
  const writeRule = (node: Extract<CssNode, {kind: 'rule'}>, indent: string) => {
    const start = pos;
    push(`${indent}${node.selector} {\n`);
    for (const d of node.declarations) {
      if (d.detached) continue;
      push(indent + '  ');
      const ds = pos;
      push(`${d.property}: ${d.value}${d.important ? ' !important' : ''};`);
      ranges.set(d.id, {start: ds, end: pos});
      push('\n');
    }
    push(`${indent}}`);
    ranges.set(node.id, {start, end: pos});
  };
  const writeMedia = (node: CssMedia, indent: string) => {
    const start = pos;
    push(`${indent}@media ${node.query} {\n`);
    writeChildren(node.children, indent + '  ');
    push(`${indent}}`);
    ranges.set(node.id, {start, end: pos});
  };
  const writeOther = (node: Extract<CssNode, {kind: 'other-at'}>, indent: string) => {
    const start = pos;
    push(`${indent}@${node.name} ${node.prelude} {\n${node.body}\n${indent}}`);
    ranges.set(node.id, {start, end: pos});
  };
  const writeChildren = (children: CssNode[], indent: string) => {
    for (const n of children) {
      if (n.detached) continue;
      // 提升后可能产生空媒体块（所有子节点被移走），跳过
      if (n.kind === 'media' && !hasPrintable(n.children)) continue;
      if (n.kind === 'rule') writeRule(n, indent);
      else if (n.kind === 'media') writeMedia(n, indent);
      else writeOther(n, indent);
      push('\n');
    }
  };
  writeChildren(nodes, '');
  return parts.join('').trimEnd() + '\n';
}

/** 计算内联 style 文本与各声明的局部范围 */
export function serializeInline(decls: CssDeclaration[]): {text: string; ranges: Map<string, Range>} {
  const ranges = new Map<string, Range>();
  const kept = decls.filter(d => !d.detached);
  let s = '';
  kept.forEach((d, i) => {
    const start = s.length;
    const piece = `${i > 0 ? ' ' : ''}${d.property}: ${d.value}${d.important ? ' !important' : ''};`;
    s += piece;
    ranges.set(d.id, {start, end: s.length});
  });
  return {text: s, ranges};
}

export function serializeHtml(doc: HtmlDoc, annotate = false): SerializedHtml {
  const ranges = new Map<string, Range>();
  const sheetRanges = new Map<string, {sheetId: string; ranges: RangeMap}>();
  const inlineRanges = new Map<string, Map<string, Range>>();

  const emitNode = (node: HtmlNode, w: Writer) => {
    if (node.detached) return;
    if (node.kind === 'text') {
      w.mark(node.id, () => w.text(node.value));
      return;
    }
    const el = node;
    w.mark(el.id, () => {
      w.text('<' + el.tag);
      for (const a of el.attrs) {
        if (a.name === 'style' && el.style) {
          const {text, ranges: ir} = serializeInline(el.style);
          inlineRanges.set(el.id, ir);
          if (text) w.text(` style="${escapeAttr(text)}"`);
          continue;
        }
        if (a.value === null) w.text(` ${a.name}`);
        else w.text(` ${a.name}="${escapeAttr(a.value)}"`);
      }
      if (annotate && el.tag !== 'html') w.text(` data-nid="${el.id}"`);
      if (el.void) { w.text(' />'); return; }
      w.text('>');
      if (el.sheet) {
        const local = new Map<string, Range>();
        const css = serializeSheet(el.sheet, local);
        w.text('\n');
        const cssOffset = w.position;
        // 记录相对整个 HTML 输出的全局区间，供代码视图精确定位
        const global = new Map<string, Range>();
        for (const [id, lr] of local) global.set(id, {start: cssOffset + lr.start, end: cssOffset + lr.end});
        sheetRanges.set(el.id, {sheetId: el.id, ranges: global});
        w.text(css);
      } else {
        for (const c of el.children) emitNode(c, w);
      }
      w.text(`</${el.tag}>`);
    });
  };

  const w = new Writer(ranges);
  for (const n of doc.nodes) emitNode(n, w);
  return {html: w.out, ranges, sheetRanges, inlineRanges};
}
