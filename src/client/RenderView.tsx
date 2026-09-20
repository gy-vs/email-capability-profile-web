import {useEffect, useRef} from 'react';

const HIGHLIGHT_STYLE = `
[data-nid].nid-hit { outline: 2px solid #e0561f !important; outline-offset: 1px; background: rgba(224,86,31,.12) !important; }
`;

interface RenderViewProps {
  html: string;
  /** 当前要高亮的选择器列表（任一命中即高亮） */
  selectors: string[] | null;
}

export function RenderView({html, selectors}: RenderViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>${HIGHLIGHT_STYLE}</style></head><body>${html}</body></html>`);
    doc.close();
  }, [html]);

  useEffect(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.nid-hit').forEach(el => el.classList.remove('nid-hit'));
    if (!selectors) return;
    for (const sel of selectors) {
      let nodes: Element[] = [];
      try { nodes = [...doc.querySelectorAll(sel)]; } catch { continue; }
      nodes.forEach(el => {
        el.classList.add('nid-hit');
        el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
      });
      if (nodes.length) break;
    }
  }, [html, selectors]);

  return <iframe ref={frameRef} title="rendered preview" className="render-frame" sandbox="allow-same-origin" />;
}
