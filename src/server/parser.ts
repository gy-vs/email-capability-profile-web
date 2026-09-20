import type {
  AttrNode,
  DeclNode,
  DocumentNode,
  DomNode,
  ElementNode,
  MediaNode,
  MediaTerm,
  RuleNode,
  StyleNode,
} from '../shared/types';

// --- Stable nid allocation. n0 for the document, then every token in parse order. ---

export class IdAllocator {
  private seq = 0;
  next(): string {
    this.seq += 1;
    return `n${this.seq}`;
  }
  current(): number {
    return this.seq;
  }
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['style', 'script']);

export interface ParsedDocument {
  root: DocumentNode;
  allocator: IdAllocator;
}

/**
 * Small HTML tokenizer/parser. Node identity is assigned in strict parse order,
 * so parsing the same template twice always yields identical nids.
 */
export function parseDocument(html: string): ParsedDocument {
  const allocator = new IdAllocator();
  const root: DocumentNode = { nid: allocator.next(), kind: 'document', children: [] };
  const stack: (DocumentNode | ElementNode)[] = [root];
  let i = 0;

  const current = (): DocumentNode | ElementNode => stack[stack.length - 1];
  const isElement = (v: DocumentNode | ElementNode): v is ElementNode => v.kind === 'element';

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(root, allocator, html.slice(i));
      break;
    }
    if (lt > i) pushText(current(), allocator, html.slice(i, lt));

    // Comment
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const close = end === -1 ? html.length : end + 3;
      const text = html.slice(lt + 4, end === -1 ? html.length : end);
      current().children.push({ nid: allocator.next(), kind: 'comment', text });
      i = close;
      continue;
    }
    // Doctype
    if (html[lt + 1] === '!') {
      const end = html.indexOf('>', lt);
      const close = end === -1 ? html.length : end + 1;
      const text = html.slice(lt + 2, end === -1 ? html.length : end).trim();
      current().children.push({ nid: allocator.next(), kind: 'doctype', text });
      i = close;
      continue;
    }
    // Closing tag
    if (html[lt + 1] === '/') {
      const end = findTagEnd(html, lt);
      const close = end === -1 ? html.length : end + 1;
      const tag = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        const frame = stack[s];
        if (isElement(frame) && frame.tag === tag) stack.length = s;
      }
      i = close;
      continue;
    }
    // Opening / self-closing tag
    const end = findTagEnd(html, lt);
    const close = end === -1 ? html.length : end + 1;
    const raw = html.slice(lt + 1, end === -1 ? html.length : end);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const { tag, attrs } = parseTagBody(body, allocator);
    const el: ElementNode = { nid: allocator.next(), kind: 'element', tag, attrs, children: [] };
    attachSpecialized(el, allocator);
    current().children.push(el);

    const isVoid = VOID_TAGS.has(tag);
    if (!isVoid && !selfClosing) {
      stack.push(el);
      if (RAW_TEXT_TAGS.has(tag)) {
        const closeTag = `</${tag}`;
        const endTag = html.toLowerCase().indexOf(closeTag, close);
        const rawEnd = endTag === -1 ? html.length : endTag;
        const text = html.slice(close, rawEnd);
        el.children.push({ nid: allocator.next(), kind: 'text', text });
        if (tag === 'style') el.sheet = parseSheet(text, allocator);
        if (endTag === -1) {
          i = html.length;
          stack.length = 1;
          break;
        }
        stack.pop();
        const finalClose = html.indexOf('>', endTag);
        i = finalClose === -1 ? html.length : finalClose + 1;
        continue;
      }
    }
    i = close;
  }
  return { root, allocator };
}

function pushText(parent: DocumentNode | ElementNode, allocator: IdAllocator, text: string) {
  if (text.length > 0) parent.children.push({ nid: allocator.next(), kind: 'text', text });
}

function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([^\s=\/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+)))?/g;

function parseTagBody(body: string, allocator: IdAllocator): { tag: string; attrs: AttrNode[] } {
  const ws = body.search(/\s/);
  const tag = (ws === -1 ? body : body.slice(0, ws)).toLowerCase();
  const attrs: AttrNode[] = [];
  if (ws !== -1) {
    const source = body.slice(ws + 1);
    for (const match of source.matchAll(ATTR_RE)) {
      const value = match[3] ?? match[4] ?? match[5] ?? null;
      attrs.push({ nid: allocator.next(), name: match[1].toLowerCase(), value });
    }
  }
  return { tag, attrs };
}

function attachSpecialized(el: ElementNode, allocator: IdAllocator) {
  const styleAttr = el.attrs.find((a) => a.name === 'style');
  if (styleAttr?.value) el.inline = parseDeclarations(styleAttr.value, allocator);
}

// --- CSS parser. Supports ordinary rules and nested @media rules only. ---

export function parseSheet(css: string, allocator: IdAllocator): StyleNode[] {
  const nodes: StyleNode[] = [];
  let i = 0;
  const stripped = stripComments(css);
  while (i < stripped.length) {
    i = skipWs(stripped, i);
    if (i >= stripped.length) break;
    if (stripped.startsWith('@media', i) && /\s/.test(stripped[i + 6] ?? '')) {
      const parsed = parseMedia(stripped, i, allocator);
      nodes.push(parsed.node);
      i = parsed.next;
    } else {
      const open = stripped.indexOf('{', i);
      if (open === -1) break;
      const selector = stripped.slice(i, open).trim();
      const parsed = parseBlock(stripped, open, allocator);
      nodes.push({
        nid: allocator.next(),
        kind: 'rule',
        selector,
        decls: parseDeclarations(parsed.body, allocator),
      });
      i = parsed.next;
    }
  }
  return nodes;
}

function parseMedia(css: string, start: number, allocator: IdAllocator): { node: MediaNode; next: number } {
  const nodeNid = allocator.next();
  const open = css.indexOf('{', start);
  const condition = normalizeMediaCondition(css.slice(start + 6, open).trim());
  const features = parseMediaFeatures(condition);
  const children: StyleNode[] = [];
  let i = open + 1;
  let depth = 1;
  const bodyStart = i;
  // Find matching close first; contents are parsed independently by re-using parseSheet.
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  const body = css.slice(bodyStart, i - 1);
  const subAllocator = allocator;
  let j = 0;
  const stripped = stripComments(body);
  while (j < stripped.length) {
    j = skipWs(stripped, j);
    if (j >= stripped.length) break;
    if (stripped.startsWith('@media', j) && /\s/.test(stripped[j + 6] ?? '')) {
      const parsed = parseMedia(stripped, j, subAllocator);
      children.push(parsed.node);
      j = parsed.next;
    } else {
      const brace = stripped.indexOf('{', j);
      if (brace === -1) break;
      const selector = stripped.slice(j, brace).trim();
      const parsed = parseBlock(stripped, brace, subAllocator);
      children.push({
        nid: subAllocator.next(),
        kind: 'rule',
        selector,
        decls: parseDeclarations(parsed.body, subAllocator),
      });
      j = parsed.next;
    }
  }
  return {
    node: { nid: allocator.next(), kind: 'media', condition, features, children },
    next: i,
  };
}

function parseBlock(css: string, open: number, _allocator: IdAllocator): { body: string; next: number } {
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return { body: css.slice(open + 1, i - 1), next: i };
}

export function parseDeclarations(body: string, allocator: IdAllocator): DeclNode[] {
  const decls: DeclNode[] = [];
  for (const part of stripComments(body).split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (!prop || !/^[-\w]+$/.test(prop)) continue;
    let value = part.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important\s*$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important\s*$/i, '').trim();
    }
    if (!value) continue;
    decls.push({ nid: allocator.next(), kind: 'decl', prop, value, important });
  }
  return decls;
}

function normalizeMediaCondition(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\(\s*([-\w]+)\s*:\s*/g, '($1: ')
    .replace(/\s*\)/g, ')');
}

function parseMediaFeatures(condition: string): MediaTerm[] {
  const terms: MediaTerm[] = [];
  for (const raw of condition.split(/\s*,\s*/)) {
    const m = raw.match(/\(\s*([-\w]+)\s*(?::[^)]*)?\)/);
    if (m) terms.push({ feature: m[1].toLowerCase(), raw: raw.trim() });
  }
  return terms;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}
