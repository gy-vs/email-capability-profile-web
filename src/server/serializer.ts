import type {
  DeclNode,
  DocumentNode,
  DomNode,
  ElementNode,
  MediaNode,
  RuleNode,
  StyleNode,
} from '../shared/types';

/** Serialize the transformed tree. Nodes marked removed are skipped. */
export function serialize(root: DocumentNode): string {
  return root.children.map(serializeNode).join('');
}

function serializeNode(node: DomNode): string {
  switch (node.kind) {
    case 'document':
      return node.children.map(serializeNode).join('');
    case 'text':
      return node.text;
    case 'comment':
      return `<!--${node.text}-->`;
    case 'doctype': {
      const body = /^doctype\b/i.test(node.text) ? node.text : `doctype ${node.text}`;
      return `<!${body}>`;
    }
    case 'element':
      return serializeElement(node);
  }
}

function serializeElement(el: ElementNode): string {
  if (el.status === 'removed') return '';
  if (el.tag === 'style') return serializeStyle(el);

  const childrenHtml = el.children.map(serializeNode).join('');

  // A <picture> whose wrapper is removed unwraps directly to its chosen candidate.
  if (el.unwrap) return childrenHtml;

  const attrs = liveAttrs(el).map(serializeAttr).join('');
  const open = `<${el.tag}${attrs}>`;
  const close = needsCloseTag(el) ? `</${el.tag}>` : '';
  return open + childrenHtml + close;
}

function needsCloseTag(el: ElementNode): boolean {
  const voidTags = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  return !voidTags.has(el.tag);
}

export function liveAttrs(el: ElementNode) {
  const changed = new Map(el.attrChanges?.map((c) => [c.attrNid, c]) ?? []);
  const inlineCss = el.inline ? serializeInline(el) : null;
  return el.attrs
    .filter((attr) => !removedAttrNids(el).has(attr.nid))
    .map((attr) => {
      const change = changed.get(attr.nid);
      if (change) return {nid: attr.nid, name: change.name, value: change.to as string | null};
      // style="..." is re-serialized from the transformed declaration list.
      if (inlineCss !== null && attr.name === 'style') {
        return inlineCss ? {nid: attr.nid, name: 'style', value: inlineCss} : null;
      }
      return attr;
    })
    .filter((attr): attr is {nid: string; name: string; value: string | null} => attr !== null);
}

export function markAttrRemoved(el: ElementNode, attrNid: string) {
  const set = new Set(el.removedAttrNids ?? []);
  set.add(attrNid);
  el.removedAttrNids = [...set];
}

export function removedAttrNids(el: ElementNode): Set<string> {
  return new Set(el.removedAttrNids ?? []);
}

function serializeAttr(attr: { nid: string; name: string; value: string | null }): string {
  if (attr.value === null) return ` ${attr.name}`;
  return ` ${attr.name}="${escapeAttr(attr.value)}"`;
}

export function serializeInline(el: ElementNode): string {
  if (!el.inline) return '';
  return el.inline
    .filter((d) => d.status !== 'removed')
    .map(serializeDecl)
    .join('; ');
}

function serializeDecl(decl: DeclNode): string {
  const important = decl.important ? ' !important' : '';
  return `${decl.prop}: ${decl.value}${important}`;
}

function serializeStyle(el: ElementNode): string {
  const attrs = el.attrs
    .filter((attr) => !removedAttrNids(el).has(attr.nid))
    .map(serializeAttr)
    .join('');
  const open = `<style${attrs}>`;
  if (!el.sheet) return `${open}${el.children.map(serializeNode).join('')}</style>`;
  const css = serializeSheet(el.sheet, 0);
  return `${open}${css.length ? `\n${css}\n` : ''}</style>`;
}

/** Serialize stylesheet nodes honoring removed/flattened status and depth lifting. */
export function serializeSheet(nodes: StyleNode[], depth: number): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'media') {
      if (node.status === 'removed') continue;
      if (node.status === 'flattened') {
        lines.push(serializeSheet(node.children, depth));
      } else {
        const body = serializeSheet(node.children, depth + 1);
        lines.push(`${indent(depth)}@media ${node.condition} {`);
        if (body) lines.push(body);
        lines.push(`${indent(depth)}}`);
      }
    } else {
      if (node.status === 'removed') continue;
      const decls = node.decls.filter((d) => d.status !== 'removed');
      if (decls.length === 0) continue;
      lines.push(`${indent(depth)}${node.selector} {`);
      for (const decl of decls) lines.push(`${indent(depth + 1)}${serializeDecl(decl)};`);
      lines.push(`${indent(depth)}}`);
    }
  }
  return lines.filter((l) => l.length > 0).join('\n');
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- Node lookup ---

export function findNode(root: DocumentNode, nid: string): DomNode | null {
  let found: DomNode | null = null;
  walk(root, (node) => {
    if (!found && node.nid === nid) found = node;
  });
  return found;
}

export function walk(root: DocumentNode | ElementNode, visit: (node: DomNode) => void): void {
  for (const child of root.children) {
    visit(child);
    if (child.kind === 'element') {
      walk(child, visit);
    }
  }
}

/** All stylesheet nodes across the document, in document order. */
export function collectSheets(root: DocumentNode): { el: ElementNode; nodes: StyleNode[] }[] {
  const out: { el: ElementNode; nodes: StyleNode[] }[] = [];
  walk(root, (node) => {
    if (node.kind === 'element' && node.tag === 'style' && node.sheet) {
      out.push({ el: node, nodes: node.sheet });
    }
  });
  return out;
}

export function walkRules(
  nodes: StyleNode[],
  visit: (rule: RuleNode, path: MediaNode[]) => void,
  path: MediaNode[] = [],
): void {
  for (const node of nodes) {
    if (node.kind === 'rule') visit(node, path);
    else if (node.status === 'flattened') walkRules(node.children, visit, path);
    else walkRules(node.children, visit, [...path, node]);
  }
}
