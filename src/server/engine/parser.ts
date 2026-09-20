import type {
  CapabilityProfile,
  CssDeclaration,
  CssMedia,
  CssNode,
  CssOtherAt,
  HtmlDoc,
  HtmlElement,
  HtmlNode,
  HtmlText,
  MediaFeature,
} from './ast';

const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr',
]);
const RAW_TAGS = new Set(['style', 'script', 'title', 'textarea']);

// 全局稳定 id：h/html, t/text, s/style表, r/规则, m/媒体, c/声明, o/其它at规则
export class IdGen {
  private n = 0;
  next(prefix: string) { return `${prefix}${++this.n}`; }
}

const ATTR_RE = /([a-zA-Z_:][-\w:.:]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string) {
  const attrs: HtmlElement['attrs'] = [];
  for (const m of raw.matchAll(ATTR_RE)) attrs.push({name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null});
  return attrs;
}

function parseInlineStyle(raw: string, ownerId: string, idg: IdGen): CssDeclaration[] {
  return parseDeclarations(raw, ownerId, idg, null);
}

export function parseHtml(source: string): HtmlDoc {
  const idg = new IdGen();
  const rootNodes: HtmlNode[] = [];
  const index = new Map<string, CssNode | CssDeclaration | HtmlNode>();
  // 栈中只放元素；根内容写入 rootNodes
  const stack: HtmlElement[] = [];

  const pushNode = (node: HtmlNode) => {
    index.set(node.id, node);
    const top = stack[stack.length - 1];
    if (top) { top.children.push(node); node.parent = top; } else { rootNodes.push(node); }
  };

  const finishRawElement = (el: HtmlElement) => {
    if (el.tag !== 'style') return;
    const text = el.children.filter(c => c.kind === 'text').map(c => (c as HtmlText).value).join('');
    el.sheet = parseCss(text, el.id, idg);
    for (const n of walkCss(el.sheet)) index.set(n.id, n);
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      if (i < source.length) {
        const t: HtmlText = {kind: 'text', id: idg.next('t'), value: source.slice(i), parent: null, detached: false};
        pushNode(t);
      }
      break;
    }
    if (lt > i) {
      const t: HtmlText = {kind: 'text', id: idg.next('t'), value: source.slice(i, lt), parent: null, detached: false};
      pushNode(t);
    }
    // 注释 / doctype / 声明
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      const stop = end === -1 ? source.length : end + 3;
      const t: HtmlText = {kind: 'text', id: idg.next('t'), value: source.slice(lt, stop), parent: null, detached: false};
      pushNode(t);
      i = stop;
      continue;
    }
    if (source[lt + 1] === '!') {
      const gt = source.indexOf('>', lt);
      const stop = gt === -1 ? source.length : gt + 1;
      const t: HtmlText = {kind: 'text', id: idg.next('t'), value: source.slice(lt, stop), parent: null, detached: false};
      pushNode(t);
      i = stop;
      continue;
    }
    const gt = source.indexOf('>', lt + 1);
    if (gt === -1) {
      const t: HtmlText = {kind: 'text', id: idg.next('t'), value: source.slice(lt), parent: null, detached: false};
      pushNode(t);
      i = source.length;
      break;
    }
    const inner = source.slice(lt + 1, gt);
    const isClose = inner.startsWith('/');
    const tagText = isClose ? inner.slice(1).trim() : inner.endsWith('/') ? inner.slice(0, -1).trim() : inner.trim();
    const tag = tagText.split(/[\s/]/)[0]?.toLowerCase() ?? '';
    i = gt + 1;

    if (!isClose && tag) {
      const selfClose = inner.trimEnd().endsWith('/');
      const el: HtmlElement = {
        kind: 'element', id: idg.next('h'), tag,
        attrs: parseAttrs(tagText.slice(tag.length)),
        children: [], parent: null, detached: false,
        void: VOID_TAGS.has(tag) || selfClose,
        rawText: RAW_TAGS.has(tag),
        style: null, sheet: null,
      };
      const styleAttr = el.attrs.find(a => a.name === 'style' && a.value != null);
      if (styleAttr?.value) el.style = parseInlineStyle(styleAttr.value, el.id, idg);
      pushNode(el);
      if (!el.void) stack.push(el);
      if (!el.void && el.rawText) {
        // 原始文本元素：读到对应闭合标签为止，不解析其中的 <
        const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
        const rest = source.slice(i);
        const m = rest.match(closeRe);
        const rawEnd = m ? m.index! : -1;
        const text = rawEnd === -1 ? rest : rest.slice(0, rawEnd);
        if (text) {
          const t: HtmlText = {kind: 'text', id: idg.next('t'), value: text, parent: null, detached: false};
          el.children.push(t); index.set(t.id, t); t.parent = el;
        }
        if (rawEnd === -1) { i = source.length; stack.pop(); finishRawElement(el); continue; }
        i += rawEnd + m![0].length;
        stack.pop();
        finishRawElement(el);
        continue;
      }
      continue;
    }
    if (isClose && tag) {
      // 弹出到匹配标签
      for (let d = stack.length - 1; d >= 0; d--) {
        if (stack[d].tag === tag) {
          const el = stack[d];
          if (el.tag === 'style') {
            const text = el.children.filter(c => c.kind === 'text').map(c => (c as HtmlText).value).join('');
            el.sheet = parseCss(text, el.id, idg);
            for (const n of walkCss(el.sheet)) index.set(n.id, n);
          }
          stack.length = d;
          break;
        }
      }
    }
  }

  // 未闭合的 style 也尝试解析
  for (const el of stack) {
    if (el.tag === 'style' && !el.sheet) {
      const text = el.children.filter(c => c.kind === 'text').map(c => (c as HtmlText).value).join('');
      el.sheet = parseCss(text, el.id, idg);
      for (const n of walkCss(el.sheet)) index.set(n.id, n);
    }
  }

  return {nodes: rootNodes, index};
}

// ---------------- CSS 解析 ----------------

export function* walkCss(nodes: CssNode[]): Generator<CssNode | CssDeclaration> {
  for (const n of nodes) {
    yield n;
    if (n.kind === 'media') { yield* walkCss(n.children); }
    if (n.kind === 'rule') { yield* n.declarations; }
  }
}

function skipWsCss(s: string, i: number): number {
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function parseDeclarations(body: string, ownerId: string, idg: IdGen, parent: CssMedia | null): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  let depth = 0, cur = '', inStr: string | null = null;
  const flush = () => {
    const part = cur.trim();
    if (!part) return;
    const m = part.match(/^([-\w]+)\s*:\s*([\s\S]+?)\s*(!important)?\s*$/i);
    if (m) {
      out.push({
        kind: 'declaration', id: idg.next('c'),
        property: m[1].toLowerCase(),
        value: (m[3] ? m[2] : m[2]).trim(),
        important: Boolean(m[3]),
        detached: false, parent, ownerId,
      });
    }
  };
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i] ?? '';
    if (inStr) { cur += ch; if (ch === inStr && body[i - 1] !== '\\') inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ';' || i === body.length) && depth === 0) { flush(); cur = ''; continue; }
    cur += ch;
  }
  return out;
}

export function parseFeature(raw: string): MediaFeature {
  const m = raw.trim().match(/^\(?\s*([-\w]+)\s*(?::\s*([^)]+?)\s*)?\)?$/);
  const name = (m?.[1] ?? raw).toLowerCase();
  const value = (m?.[2] ?? '').toLowerCase();
  const kind = name === 'prefers-color-scheme' ? 'dark'
    : ['width','min-width','max-width'].includes(name) ? 'width' : 'other';
  return {raw: raw.trim(), name, value, kind};
}

function parseFeatures(prelude: string): MediaFeature[] {
  // 支持 and 连接；逗号(OR)在 parseBlock 层拆分为多个候选 query
  const parts = prelude.split(/\s+and\s+/i);
  return parts.map(p => p.trim()).filter(Boolean).map(parseFeature);
}

function parseBlockList(css: string, ownerId: string, idg: IdGen, parent: CssMedia | null): CssNode[] {
  const nodes: CssNode[] = [];
  let i = 0;
  while (true) {
    i = skipWsCss(css, i);
    if (i >= css.length) break;
    if (css[i] === '@') {
      // at-rule 头
      let j = i + 1;
      while (j < css.length && /[-\w]/.test(css[j])) j++;
      const name = css.slice(i + 1, j).toLowerCase();
      // prelude 直到 { 或 ;
      let depth = 0, inStr: string | null = null, k = j;
      for (; k < css.length; k++) {
        const ch = css[k];
        if (inStr) { if (ch === inStr && css[k - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth === 0 && (ch === '{' || ch === ';')) break;
      }
      const prelude = css.slice(j, k).trim();
      if (css[k] === ';') { i = k + 1; continue; }
      if (css[k] !== '{') break;
      // 配平花括号取 body
      let d = 1, p = k + 1; inStr = null;
      for (; p < css.length && d > 0; p++) {
        const ch = css[p];
        if (inStr) { if (ch === inStr && css[p - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') d++;
        if (ch === '}') d--;
      }
      const body = css.slice(k + 1, p - 1);
      if (name === 'media') {
        // 逗号分隔的多个 query：展开为多个同构 media 节点（保持确定顺序）
        for (const alt of prelude.split(',').map(s => s.trim()).filter(Boolean)) {
          const node: CssMedia = {
            kind: 'media', id: idg.next('m'),
            query: alt, features: parseFeatures(alt),
            children: [], detached: false, parent, ownerId, mergedFromNested: false,
          };
          node.children = parseBlockList(body, ownerId, idg, node);
          nodes.push(node);
        }
      } else {
        const node: CssOtherAt = {
          kind: 'other-at', id: idg.next('o'),
          name, prelude, body, detached: false, parent, ownerId,
        };
        nodes.push(node);
      }
      i = p;
    } else {
      // 合格规则：selector { ... }
      let depth = 0, inStr: string | null = null, k = i;
      for (; k < css.length; k++) {
        const ch = css[k];
        if (inStr) { if (ch === inStr && css[k - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') break;
        if (ch === '}') break;
      }
      if (css[k] !== '{') break;
      const selector = css.slice(i, k).trim();
      let d = 1, p = k + 1; inStr = null;
      for (; p < css.length && d > 0; p++) {
        const ch = css[p];
        if (inStr) { if (ch === inStr && css[p - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') d++;
        if (ch === '}') d--;
      }
      const body = css.slice(k + 1, p - 1);
      const decls = parseDeclarations(body, ownerId, idg, parent);
      const node: CssNode = {
        kind: 'rule', id: idg.next('r'),
        selector, declarations: decls, detached: false, parent, ownerId,
      };
      nodes.push(node);
      i = p;
    }
  }
  return nodes;
}

export function parseCss(css: string, ownerId: string, idg: IdGen): CssNode[] {
  return parseBlockList(css, ownerId, idg, null);
}

// ---------------- 媒体查询能力判断 ----------------

/** 查询在该能力配置下是否“可应用”：dark 开关 + 每个特性受支持 */
export function querySupported(features: MediaFeature[], p: CapabilityProfile): boolean {
  for (const f of features) {
    if (f.kind === 'dark') {
      if (!p.darkMode) return false;
      continue;
    }
    if (f.kind === 'width') {
      if (!p.css.supportedMediaFeatures.includes('width')) return false;
      continue;
    }
    if (!p.css.supportedMediaFeatures.includes(f.name)) return false;
  }
  return true;
}

/** 合并嵌套查询：父特性 + 子特性 */
export function featuresToQuery(features: MediaFeature[]): string {
  return features.map(f => f.raw).join(' and ');
}
