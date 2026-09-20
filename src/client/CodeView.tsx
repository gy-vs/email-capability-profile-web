import {useEffect, useRef} from 'react';
import type {
  DeclNode,
  DocumentNode,
  DomNode,
  ElementNode,
  MediaNode,
  RuleNode,
  StyleNode,
} from '../shared/types';
import {removedAttrNids} from '../server/serializer';

interface CodeViewProps {
  root: DocumentNode;
  transformed: boolean;
  activeNid?: string | null;
  relatedNids?: string[];
}

interface Line {
  nid?: string;
  html: string;
  cls?: string;
  indent: number;
}

/** Side-by-side pretty HTML view. Both sides render the *same* node tree so
 *  original and transformed lines line up by stable nid. */
export default function CodeView({root, transformed, activeNid, relatedNids = []}: CodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeNid || !containerRef.current) return;
    const target = containerRef.current.querySelector(`[data-nid="${cssEscape(activeNid)}"]`);
    target?.scrollIntoView({block: 'center', behavior: 'smooth'});
  }, [activeNid]);

  const lines: Line[] = [];
  renderChildren(root.children, 0, lines, transformed);

  const related = new Set(relatedNids);
  return (
    <div className="codeview" ref={containerRef}>
      {lines.map((line, index) => {
        const cls = [
          'code-line',
          line.cls ?? '',
          line.nid === activeNid ? 'is-active' : '',
          line.nid && related.has(line.nid) ? 'is-related' : '',
        ].join(' ');
        return (
          <div
            className={cls}
            key={line.nid ?? `l${index}`}
            data-nid={line.nid}
            style={{paddingLeft: 12 + line.indent * 14}}
          >
            {line.html}
          </div>
        );
      })}
    </div>
  );
}

function renderChildren(children: DomNode[], depth: number, lines: Line[], transformed: boolean) {
  for (const node of children) {
    if (node.kind === 'text') {
      const text = node.text.trim();
      if (text) lines.push({indent: depth, html: escapeHtml(text)});
      continue;
    }
    if (node.kind === 'comment') {
      lines.push({nid: node.nid, indent: depth, html: `<span class="tk-com">&lt;!--${escapeHtml(node.text)}--&gt;</span>`, cls: 'node-comment'});
      continue;
    }
    if (node.kind === 'doctype') {
      lines.push({nid: node.nid, indent: depth, html: `<span class="tk-com">&lt;!DOCTYPE ${escapeHtml(node.text)}&gt;</span>`});
      continue;
    }
    if (node.kind === 'element') renderElement(node, depth, lines, transformed);
  }
}

function isRemoved(node: ElementNode) {
  return node.status === 'removed';
}

function renderElement(el: ElementNode, depth: number, lines: Line[], transformed: boolean) {
  const removed = transformed && isRemoved(el);
  const cls = removed ? 'is-removed' : '';
  if (el.tag === 'style') {
    renderStyle(el, depth, lines, transformed);
    return;
  }
  if (transformed && el.unwrap) {
    lines.push({
      nid: el.nid, indent: depth, cls: 'is-unwrapped',
      html: `<span class="tk-pun">&lt;${el.tag}</span> <span class="tk-note">/* wrapper unwrapped, fallback candidate promoted */</span><span class="tk-pun">&gt;</span>`,
    });
    renderChildren(el.children, depth + 1, lines, transformed);
    lines.push({indent: depth, cls: 'is-unwrapped', html: `<span class="tk-pun">&lt;/${el.tag}&gt;</span>`});
    return;
  }

  const attrs = renderAttrs(el, transformed);
  const open = `<span class="tk-pun">&lt;</span><span class="tk-tag">${el.tag}</span>${attrs}<span class="tk-pun">&gt;</span>`;
  lines.push({nid: el.nid, indent: depth, html: open, cls});

  renderChildren(el.children, depth + 1, lines, transformed);

  if (!VOID.has(el.tag)) {
    lines.push({indent: depth, html: `<span class="tk-pun">&lt;/</span><span class="tk-tag">${el.tag}</span><span class="tk-pun">&gt;</span>`, cls});
  }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function renderAttrs(el: ElementNode, transformed: boolean): string {
  const removedSet = removedAttrNids(el);
  const parts: string[] = [];
  for (const attr of el.attrs) {
    const removed = transformed && removedSet.has(attr.nid);
    let value: string | null = attr.value;
    let mark = '';
    if (attr.name === 'style' && el.inline) {
      // inline styles are represented via their declarations, skip raw attr
      continue;
    }
    const attrHtml = `<span class="tk-attr">${attr.name}</span>${value === null ? '' : `=<span class="tk-str">"${escapeHtml(value)}"</span>`}`;
    parts.push(` <span class="attr-wrap${removed ? ' is-removed' : ''}" data-nid="${attr.nid}">${attrHtml}${mark}</span>`);
  }
  if (el.inline) parts.push(renderInline(el, transformed));
  return parts.join('');
}

function renderInline(el: ElementNode, transformed: boolean): string {
  const decls = el.inline ?? [];
  const inner = decls
    .map((decl) => {
      const cls = transformed && decl.status === 'removed' ? 'is-removed' : transformed && decl.status === 'fallback' ? 'is-fallback' : '';
      const note = transformed && decl.originalValue ? ` <span class="tk-note">/* was ${escapeHtml(decl.originalValue)} */</span>` : '';
      return `<span class="decl ${cls}" data-nid="${decl.nid}"><span class="tk-prop">${decl.prop}</span>: <span class="tk-val">${escapeHtml(decl.value)}</span>${decl.important ? ' !important' : ''};</span>${note}`;
    })
    .join(' ');
  return ` <span class="attr-wrap"><span class="tk-attr">style</span>=<span class="tk-str">"${inner}"</span></span>`;
}

function renderStyle(el: ElementNode, depth: number, lines: Line[], transformed: boolean) {
  const removed = transformed && isRemoved(el);
  const attrs = el.attrs.map((a) => ` <span class="tk-attr">${a.name}</span>=<span class="tk-str">"${escapeHtml(a.value ?? '')}"</span>`).join('');
  lines.push({
    nid: el.nid, indent: depth, cls: removed ? 'is-removed' : '',
    html: `<span class="tk-pun">&lt;</span><span class="tk-tag">style</span>${attrs}<span class="tk-pun">&gt;</span>`,
  });
  if (el.sheet) renderSheet(el.sheet, depth + 1, lines, transformed);
  lines.push({indent: depth, html: `<span class="tk-pun">&lt;/</span><span class="tk-tag">style</span><span class="tk-pun">&gt;</span>`, cls: removed ? 'is-removed' : ''});
}

function renderSheet(nodes: StyleNode[], depth: number, lines: Line[], transformed: boolean) {
  for (const node of nodes) {
    if (node.kind === 'media') {
      if (transformed && node.status === 'flattened') {
        lines.push({
          nid: node.nid, indent: depth, cls: 'is-flattened',
          html: `<span class="tk-at">@media</span> <span class="tk-val">${escapeHtml(node.condition)}</span> <span class="tk-note">/* flattened, condition dropped */</span> {`,
        });
        renderSheet(node.children, depth, lines, transformed);
        lines.push({indent: depth, cls: 'is-flattened', html: '}'});
        continue;
      }
      const removed = transformed && node.status === 'removed';
      lines.push({
        nid: node.nid, indent: depth, cls: removed ? 'is-removed' : '',
        html: `<span class="tk-at">@media</span> <span class="tk-val">${escapeHtml(node.condition)}</span> {`,
      });
      renderSheet(node.children, depth + 1, lines, transformed);
      lines.push({indent: depth, html: '}', cls: removed ? 'is-removed' : ''});
    } else {
      renderRule(node, depth, lines, transformed);
    }
  }
}

function renderRule(rule: RuleNode, depth: number, lines: Line[], transformed: boolean) {
  const removed = transformed && rule.status === 'removed';
  lines.push({
    nid: rule.nid, indent: depth, cls: removed ? 'is-removed' : '',
    html: `<span class="tk-sel">${escapeHtml(rule.selector)}</span> {`,
  });
  for (const decl of rule.decls) lines.push(renderDeclLine(decl, depth + 1, transformed));
  lines.push({indent: depth, html: '}', cls: removed ? 'is-removed' : ''});
}

function renderDeclLine(decl: DeclNode, indent: number, transformed: boolean): Line {
  const cls = !transformed
    ? ''
    : decl.status === 'removed'
      ? 'is-removed'
      : decl.status === 'fallback'
        ? 'is-fallback'
        : '';
  const note =
    transformed && decl.originalValue
      ? `  <span class="tk-note">/* was ${escapeHtml(decl.originalValue)} */</span>`
      : '';
  return {
    nid: decl.nid, indent, cls,
    html: `<span class="tk-prop">${decl.prop}</span>: <span class="tk-val">${escapeHtml(decl.value)}</span>${decl.important ? ' !important' : ''};${note}`,
  };
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type {MediaNode};
