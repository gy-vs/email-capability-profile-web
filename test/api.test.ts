import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {transform, PHASES} from '../src/server/transform';
import {PRESET_CONFIGS} from '../src/server/capabilities';
import type {CapabilityConfig, Explanation, PreviewRecord} from '../src/shared/types';

function byKind(result: {explanations: Explanation[]}, kind: Explanation['kind']): Explanation[] {
  return result.explanations.filter((e) => e.kind === kind);
}

function gmail(overrides: Partial<CapabilityConfig> = {}): CapabilityConfig {
  return JSON.parse(JSON.stringify({...PRESET_CONFIGS.gmail, ...overrides}));
}

describe('transform pipeline', () => {
  it('removes unsupported properties from rules and inline styles', () => {
    const html = `<div style="gap:10px;color:red"><style>.x{display:grid;gap:4px;color:#000}</style></div>`;
    const result = transform(html, gmail());
    const dropped = byKind(result, 'property_unsupported');
    expect(dropped.map((d) => d.title)).toContain('Unsupported property gap');
    expect(result.outputHtml).not.toContain('gap');
    // display:grid is a value-level degradation with the profile fallback display:block
    expect(result.outputHtml).toContain('display: block');
    // color survives
    expect(result.outputHtml).toContain('color: red');
    expect(result.outputHtml).toContain('color: #000');
  });

  it('falls back at value level to the nearest earlier supported declaration', () => {
    const html = `<style>.x{color:#123;color:color-mix(in srgb,#123 80%,white)}</style>`;
    const result = transform(html, gmail());
    const fb = byKind(result, 'value_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].relatedNodeIds).toHaveLength(1);
    const declNode = result.tree;
    void declNode;
    expect(result.outputHtml).toContain('color: #123');
    expect(result.outputHtml).not.toContain('color-mix');
  });

  it('uses profile fallback values when no author fallback exists', () => {
    const html = `<style>.x{display:grid;color:#000}</style>`;
    // display:grid unsupported value with profile fallback display:block
    const result = transform(html, gmail());
    const fb = byKind(result, 'value_fallback');
    expect(fb.some((e) => e.title === 'Profile fallback for display')).toBe(true);
    expect(result.outputHtml).toContain('display: block');
  });

  it('selects the first supported picture candidate and unwraps when none match', () => {
    const html = `<picture><source type="image/avif" srcset="a.avif"><source type="image/webp" srcset="a.webp"><img src="a.jpg"></picture>`;
    const result = transform(html, gmail());
    expect(result.outputHtml).toContain('a.webp');
    expect(result.outputHtml).not.toContain('a.avif');
    expect(result.outputHtml).toContain('<picture>');
    const selected = byKind(result, 'image_candidate_selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].detail).toContain('webp');

    const outlook = transform(html, PRESET_CONFIGS.outlook);
    expect(outlook.outputHtml).not.toContain('<picture>');
    expect(outlook.outputHtml).not.toContain('<source');
    expect(outlook.outputHtml).toContain('<img src="a.jpg"');
  });

  it('drops unsupported media blocks and flattens nested media beyond maxDepth', () => {
    const html = `<style>
      @media (min-width:600px){.a{color:red}
        @media (hover:hover){.a{color:blue}}}
      @media (pointer:coarse){.b{color:green}}
    </style>`;
    const result = transform(html, gmail()); // maxDepth 1; pointer unsupported
    const flattened = byKind(result, 'media_nested');
    expect(flattened).toHaveLength(1);
    // Inner hover condition lifted: its rule now belongs to min-width block,
    // and there is no nested @media in the output.
    expect(result.outputHtml).toContain('@media (min-width: 600px)');
    expect(result.outputHtml).not.toMatch(/@media[^{]*\{[^}]*@media/s);
    expect(result.outputHtml).toContain('color: blue');
    const dropped = byKind(result, 'media_unsupported');
    expect(dropped.some((e) => e.detail.includes('(pointer: coarse)'))).toBe(true);
    expect(result.outputHtml).not.toContain('coarse');

    // Client with no media support drops everything.
    const none = transform(html, PRESET_CONFIGS.outlook);
    expect(none.outputHtml.replace(/\s/g, '')).toBe('<style></style>');
  });

  it('detects cascade conflicts (resurge) deterministically', () => {
    const html = `<style>.x{color:red}.x{color:color-mix(in srgb,red,blue)}</style>`;
    const result = transform(html, gmail());
    const conflicts = byKind(result, 'rule_conflict_resurge');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain('red');
    expect(result.outputHtml).toContain('color: red');
  });

  it('is independent of rule iteration order across runs', () => {
    const html = `<style>
      .a{gap:1px;color:color-mix(in srgb,red,blue);color:red}
      .a{display:grid}
      @media (hover:hover){.a{text-shadow:1px 1px red;color:red}
        @media (min-width:10px){.a{gap:9px}}}
    </style><picture><source type="image/avif" srcset="x.avif"><img src="x.jpg"></picture>`;
    const first = transform(html, gmail());
    const second = transform(html, gmail());
    expect(first.outputHtml).toBe(second.outputHtml);
    expect(first.explanations.map((e) => `${e.phase}:${e.nodeId}:${e.kind}`)).toEqual(
      second.explanations.map((e) => `${e.phase}:${e.nodeId}:${e.kind}`),
    );
    // Explanations appear in fixed phase order.
    const phases = first.explanations.map((e) => e.phase);
    expect([...phases]).toEqual([...phases].sort((a, b) => a - b));
  });

  it('preserves node identity between original and transformed trees', () => {
    const html = `<div id="a" style="gap:1px"><style>.a{gap:2px;color:red}</style><span>hi</span></div>`;
    const result = transform(html, gmail());
    const originalIds = collectIds(result.originalHtml);
    const outputIds = collectIdsFromTree(result.tree);
    // Every surviving output nid existed in the original parse; nothing was re-minted.
    for (const id of outputIds) expect(originalIds).toContain(id);
  });

  it('keeps phase ordering constants fixed', () => {
    expect(PHASES.DARK_MEDIA).toBeLessThan(PHASES.MEDIA_FEATURE);
    expect(PHASES.MEDIA_FEATURE).toBeLessThan(PHASES.MEDIA_NESTING);
    expect(PHASES.MEDIA_NESTING).toBeLessThan(PHASES.VALUE);
    expect(PHASES.VALUE).toBeLessThan(PHASES.PROPERTY);
    expect(PHASES.PROPERTY).toBeLessThan(PHASES.RULE_CONFLICT);
  });
});

function collectIds(html: string): string[] {
  // Re-parse via transform with a permissive config and read tree ids.
  const result = transform(html, PRESET_CONFIGS.modern);
  return collectIdsFromTree(result.tree);
}

function collectIdsFromTree(root: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.nid === 'string') ids.push(node.nid);
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (Array.isArray(node.attrs)) node.attrs.forEach(visit);
    if (Array.isArray(node.sheet)) node.sheet.forEach(visit);
    if (Array.isArray(node.decls)) node.decls.forEach(visit);
    if (Array.isArray(node.inline)) node.inline.forEach(visit);
  };
  visit(root);
  return ids;
}

describe('service', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/templates/alpha').expect(200);
    await request(app).put('/api/templates/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/templates/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });

  it('saves profiles with revision locking and keeps old revisions', async () => {
    const app = createApp();
    const loaded = await request(app).get('/api/profiles/gmail').expect(200);
    expect(loaded.body.revision).toBe(3);
    const updated = await request(app)
      .put('/api/profiles/gmail')
      .send({name: 'Gmail edited', config: loaded.body.config, revision: 3})
      .expect(200);
    expect(updated.body.revision).toBe(4);
    await request(app)
      .put('/api/profiles/gmail')
      .send({name: 'Gmail stale', config: loaded.body.config, revision: 3})
      .expect(409);
    // Both revisions remain readable.
    await request(app).get('/api/profiles/gmail/revisions/3').expect(200);
    const rev4 = await request(app).get('/api/profiles/gmail/revisions/4').expect(200);
    expect(rev4.body.name).toBe('Gmail edited');
  });

  it('binds previews to explicit profile revisions', async () => {
    const app = createApp();
    const bad = await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'gmail'})
      .expect(400);
    expect(bad.body.error).toBe('profile_revision_required');

    const run = await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'gmail', profileRevision: 3})
      .expect(201);
    const record = run.body as PreviewRecord;
    expect(record.profileRevision).toBe(3);
    expect(record.result.explanations.length).toBeGreaterThan(0);
    expect(record.templateRevision).toBe(4);

    // Draft content is transformed but never mutates the stored template.
    await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'gmail', profileRevision: 3, useDraft: true, content: '<div style="gap:1px">x</div>'})
      .expect(201);
    const current = await request(app).get('/api/templates/alpha').expect(200);
    expect(current.body.content).toContain('<html');
  });

  it('replays historical previews after the profile is deleted', async () => {
    const app = createApp();
    const run = await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'outlook', profileRevision: 1})
      .expect(201);
    const previewId = run.body.id;
    await request(app).delete('/api/profiles/outlook').expect(204);
    await request(app).get('/api/profiles/outlook').expect(404);

    const history = await request(app).get('/api/previews').expect(200);
    const entry = history.body.find((p: PreviewRecord) => p.id === previewId);
    expect(entry.profileExists).toBe(false);
    expect(entry.profileName).toContain('Outlook');

    const detail = await request(app).get(`/api/previews/${previewId}`).expect(200);
    expect(detail.body.profileExists).toBe(false);
    // Full snapshot survived: the degraded output still replays.
    expect(detail.body.profile.config.media.supported).toBe(false);
    expect(detail.body.result.outputHtml).toBeTruthy();
    expect(detail.body.result.explanations.length).toBeGreaterThan(0);

    // Stored revision snapshots outlive the profile as well.
    await request(app).get('/api/profiles/outlook/revisions/1').expect(200);
  });

  it('updating a profile changes the degradations of subsequent runs', async () => {
    const app = createApp();
    const before = await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'gmail', profileRevision: 3})
      .expect(201);
    const beforeDrops = before.body.result.stats.drops;

    const loaded = await request(app).get('/api/profiles/gmail').expect(200);
    const relaxed: CapabilityConfig = JSON.parse(JSON.stringify(loaded.body.config));
    relaxed.css.unsupportedProperties = [];
    relaxed.css.unsupportedValues = {};
    const saved = await request(app)
      .put('/api/profiles/gmail')
      .send({name: loaded.body.name, config: relaxed, revision: loaded.body.revision})
      .expect(200);

    const after = await request(app)
      .post('/api/transform')
      .send({templateId: 'alpha', profileId: 'gmail', profileRevision: saved.body.revision})
      .expect(201);
    expect(after.body.result.stats.drops).toBeLessThan(beforeDrops);
  });
});
