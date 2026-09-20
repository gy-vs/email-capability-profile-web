import {useEffect, useMemo, useRef} from 'react';
import type {Range, ViewPayload} from './types';

export type TargetKind = 'element' | 'sheet' | 'inline';
export interface ResolvedTarget {
  kind: TargetKind;
  /** 代码视图中的字符区间 */
  range: Range;
  /** 渲染视图高亮选择器 */
  selector: string | null;
}

/** 把解释 targetId 解析为视图下的字符区间；节点已被删除时返回 null */
export function resolveTarget(view: ViewPayload | null, targetId: string, selectors: string[]): ResolvedTarget | null {
  if (!view) return null;
  // 1) <style> 内 CSS 节点：服务端已给出相对整个 HTML 的全局区间
  for (const entry of Object.values(view.sheetRanges)) {
    const global = entry.ranges[targetId];
    if (global) {
      return {
        kind: 'sheet',
        range: global,
        selector: selectors[0] ?? null,
      };
    }
  }
  // 2) 内联声明：代码视图高亮整个元素开标签，渲染视图用 data-nid 定位
  for (const [elId, decls] of Object.entries(view.inlineRanges)) {
    if (decls[targetId]) {
      const host = view.ranges[elId];
      if (host) return {kind: 'inline', range: host, selector: `[data-nid="${elId}"]`};
    }
  }
  // 3) HTML 元素
  const range = view.ranges[targetId];
  if (range) {
    return {
      kind: 'element',
      range,
      selector: selectors[0] ?? (targetId.startsWith('h') ? `[data-nid="${targetId}"]` : null),
    };
  }
  return null;
}

interface Mark {start: number; end: number; id: string; cls: 'el' | 'css'}

/** 元素区间收敛为开标签：<tag ... >（不含子树） */
function openTagRange(html: string, r: Range): Range {
  const gt = html.indexOf('>', r.start);
  if (gt === -1 || gt > r.end) return r;
  return {start: r.start, end: gt + 1};
}

function collectMarks(view: ViewPayload): Mark[] {
  const marks: Mark[] = [];
  const sheetHosts = new Set(Object.keys(view.sheetRanges));
  for (const [id, r] of Object.entries(view.ranges)) {
    if (sheetHosts.has(id)) continue; // style 宿主整体不高亮，交给 CSS marks
    marks.push({...openTagRange(view.html, r), id, cls: 'el'});
  }
  for (const entry of Object.values(view.sheetRanges)) {
    for (const [id, global] of Object.entries(entry.ranges)) {
      marks.push({start: global.start, end: global.end, id, cls: 'css'});
    }
  }
  return marks;
}

interface CodeViewProps {
  view: ViewPayload;
  highlightId: string | null;
  dimmed: boolean;
  onPick: (id: string) => void;
}

export function CodeView({view, highlightId, dimmed, onPick}: CodeViewProps) {
  const preRef = useRef<HTMLPreElement>(null);

  const marks = useMemo(() => collectMarks(view), [view]);
  const sortedMarks = useMemo(() => [...marks].sort((a, b) => a.start - b.start || b.end - a.end), [marks]);

  const segments = useMemo(() => {
    type Ev = {pos: number; delta: number; mark: Mark};
    const events: Ev[] = [];
    for (const m of sortedMarks) {
      events.push({pos: m.start, delta: 1, mark: m});
      events.push({pos: m.end, delta: -1, mark: m});
    }
    events.sort((a, b) => a.pos - b.pos || a.delta - b.delta);
    const segs: Array<{start: number; end: number; stack: Mark[]}> = [];
    const stack: Mark[] = [];
    let cursor = 0;
    for (const ev of events) {
      if (ev.pos > cursor) segs.push({start: cursor, end: ev.pos, stack: [...stack]});
      if (ev.delta === 1) stack.push(ev.mark);
      else {
        const idx = stack.findIndex(m => m === ev.mark);
        if (idx >= 0) stack.splice(idx, 1);
      }
      cursor = ev.pos;
    }
    if (cursor < view.html.length) segs.push({start: cursor, end: view.html.length, stack: []});
    return segs;
  }, [sortedMarks, view.html]);

  useEffect(() => {
    if (!highlightId) return;
    preRef.current?.querySelector('.code-hit')?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }, [highlightId]);

  return (
    <pre ref={preRef} className={'code-view' + (dimmed ? ' is-dimmed' : '')}><code>
      {segments.map((s, i) => {
        const text = view.html.slice(s.start, s.end);
        const top = s.stack[s.stack.length - 1];
        if (!top) return <span key={i}>{text}</span>;
        const hit = top.id === highlightId;
        return (
          <span
            key={i}
            className={hit ? 'code-hit' : top.cls === 'css' ? 'code-css' : 'code-node'}
            onClick={(e) => {e.stopPropagation(); onPick(top.id);}}
          >{text}</span>
        );
      })}
    </code></pre>
  );
}
