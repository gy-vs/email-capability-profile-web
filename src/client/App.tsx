import {useCallback, useEffect, useState} from 'react';
import {
  FlaskConical,
  GitCompareArrows,
  History,
  MonitorSmartphone,
  Play,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import type {
  CapabilityConfig,
  Explanation,
  PreviewRecord,
  PreviewSummary,
  ProfileDetail,
  ProfileSummary,
  TemplateRow,
  TemplateSummary,
} from '../shared/types';
import {api} from './api';
import CodeView from './CodeView';

type Mode = 'template' | 'profile';

const SEVERITY_LABEL: Record<Explanation['severity'], string> = {
  drop: 'Drop',
  fallback: 'Fallback',
  note: 'Note',
};

const EMPTY_CONFIG: CapabilityConfig = {
  schemaVersion: 1,
  css: {unsupportedProperties: [], unsupportedValues: {}, fallbackValues: {}},
  media: {supported: true, maxDepth: 1, supportedFeatures: ['width', 'min-width', 'max-width']},
  images: {formats: ['jpeg', 'png', 'gif', 'webp']},
  darkMode: {supported: true, mechanisms: ['prefers-color-scheme', 'meta-color-scheme'], attributeHooks: []},
};

export default function App() {
  const [mode, setMode] = useState<Mode>('template');
  const [items, setItems] = useState<TemplateSummary[]>([]);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [selectedProfile, setSelectedProfile] = useState('gmail');
  const [row, setRow] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState('');
  const [profileDetail, setProfileDetail] = useState<ProfileDetail | null>(null);
  const [profileDraft, setProfileDraft] = useState('');
  const [profileRevision, setProfileRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<{revision: number; createdAt: string}[]>([]);
  const [preview, setPreview] = useState<PreviewRecord | null>(null);
  const [history, setHistory] = useState<PreviewSummary[]>([]);
  const [activeExplanation, setActiveExplanation] = useState<Explanation | null>(null);
  const [status, setStatus] = useState('Ready');
  const [view, setView] = useState<'code' | 'rendered'>('code');

  const loadProfiles = useCallback(() => {
    api.listProfiles().then((list) => {
      setProfiles(list);
      if (!list.some((p) => p.id === selectedProfile)) setSelectedProfile(list[0]?.id ?? '');
    });
  }, [selectedProfile]);

  useEffect(() => {
    api.listTemplates().then(setItems);
    loadProfiles();
    api.listPreviews().then(setHistory);
  }, []);

  useEffect(() => {
    setStatus('Loading template');
    api.getTemplate(selected).then((value) => {
      setRow(value);
      setDraft(value.content);
      setStatus('Template loaded');
      setPreview(null);
      setActiveExplanation(null);
    });
  }, [selected]);

  useEffect(() => {
    api
      .listRevisions(selectedProfile)
      .then((list) => {
        setRevisions(list);
        // Default the bound revision to the latest stored one.
        setProfileRevision((current) => {
          if (current !== null && list.some((r) => r.revision === current)) return current;
          return list[list.length - 1]?.revision ?? null;
        });
      })
      .catch(() => setRevisions([]));
  }, [selectedProfile, profiles]);

  useEffect(() => {
    if (mode !== 'profile') return;
    setStatus('Loading client profile');
    api
      .getProfile(selectedProfile)
      .then((value) => {
        const profile = value as unknown as ProfileDetail;
        setProfileDetail(profile);
        setProfileDraft(JSON.stringify(profile.config, null, 2));
        setProfileRevision(profile.revision);
        setStatus(`Profile revision ${profile.revision}`);
      })
      .catch(() => {
        setProfileDetail(null);
        setStatus('Profile missing');
      });
  }, [mode, selectedProfile]);

  useEffect(() => {
    api.listPreviews().then(setHistory);
  }, [preview?.id]);

  async function saveTemplate() {
    if (!row) return;
    setStatus('Saving template');
    const {ok, body} = await api.saveTemplate(row.id, draft, row.revision);
    if (!ok) {
      setStatus(`Revision conflict (server at r${(body as {current?: TemplateRow}).current?.revision})`);
      return;
    }
    setRow(body as TemplateRow);
    setItems(await api.listTemplates());
    setStatus('Template saved');
  }

  async function saveProfile() {
    if (!profileDetail) return;
    let config: CapabilityConfig;
    try {
      config = JSON.parse(profileDraft) as CapabilityConfig;
    } catch {
      setStatus('Config JSON is invalid');
      return;
    }
    const {ok, status: code, body} = await api.saveProfile(profileDetail.id, profileDetail.name, config, profileDetail.revision);
    if (!ok) {
      setStatus(code === 409 ? 'Profile revision conflict — reload' : `Invalid config (${code})`);
      return;
    }
    const saved = body as ProfileDetail;
    setProfileDetail(saved);
    setProfileDraft(JSON.stringify(saved.config, null, 2));
    setProfileRevision(saved.revision);
    loadProfiles();
    setRevisions(await api.listRevisions(saved.id));
    setStatus(`Profile saved → revision ${saved.revision}`);
  }

  async function createProfile() {
    const id = `client-${Date.now().toString(36)}`;
    const name = 'New client profile';
    const {ok, body} = await api.createProfile(id, name, EMPTY_CONFIG);
    if (!ok) {
      setStatus('Could not create profile');
      return;
    }
    await loadProfiles();
    const created = body as ProfileDetail;
    setSelectedProfile(created.id);
    setMode('profile');
    setStatus('Profile created at revision 1');
  }

  async function deleteProfile() {
    if (!profileDetail) return;
    if (!confirm(`Delete profile "${profileDetail.name}"? Historical previews keep their snapshots.`)) return;
    await api.deleteProfile(profileDetail.id);
    await loadProfiles();
    setHistory(await api.listPreviews());
    setStatus('Profile deleted; history snapshots retained');
  }

  async function runTransform() {
    if (!row) return;
    if (profileRevision === null) {
      setStatus('Select a profile revision first');
      return;
    }
    setStatus('Running degradation transform');
    const {ok, body} = await api
      .runTransform({
        templateId: row.id,
        profileId: selectedProfile,
        profileRevision,
        useDraft: true,
        content: draft,
      });
    if (!ok) {
      setStatus(`Transform failed: ${(body as {error?: string}).error}`);
      return;
    }
    setPreview(body as PreviewRecord);
    setActiveExplanation(null);
    setHistory(await api.listPreviews());
    const {stats} = (body as PreviewRecord).result;
    setStatus(`Transform done: ${stats.drops} drops, ${stats.fallbacks} fallbacks, ${stats.notes} notes`);
  }

  async function openHistory(id: string) {
    const record = await api.getPreview(id);
    setSelected(record.templateId);
    setSelectedProfile(record.profileId);
    setProfileRevision(record.profileRevision);
    setDraft(record.contentSnapshot);
    setPreview(record);
    setMode('template');
    setActiveExplanation(null);
    setStatus(`History snapshot: ${record.profileName} r${record.profileRevision}`);
  }

  const explanations = preview?.result.explanations ?? [];
  const activeNid = activeExplanation?.nodeId ?? null;
  const relatedNids = activeExplanation?.relatedNodeIds ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Email Rendering Lab</strong>
        <small>Client capability workbench</small>
        <span className="spacer" />
        <button className={mode === 'template' ? 'tab active' : 'tab'} onClick={() => setMode('template')}>
          Templates
        </button>
        <button className={mode === 'profile' ? 'tab active' : 'tab'} onClick={() => setMode('profile')}>
          <MonitorSmartphone size={14} /> Clients
        </button>
      </header>

      <section className="workspace">
        <aside className="pane sidebar">
          {mode === 'template' ? (
            <>
              <h2>Templates</h2>
              <div className="list">
                {items.map((item) => (
                  <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                    {item.name}
                    <br />
                    <small>Revision {item.revision}</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <h2>Client profiles</h2>
              <div className="list">
                {profiles.map((item) => (
                  <button className={item.id === selectedProfile ? 'active' : ''} onClick={() => setSelectedProfile(item.id)} key={item.id}>
                    {item.name}
                    <br />
                    <small>Revision {item.revision}</small>
                  </button>
                ))}
                {profiles.length === 0 && <p className="muted">All profiles deleted — history still replays.</p>}
              </div>
              <button className="ghost" onClick={createProfile}>
                <Plus size={14} /> New profile
              </button>
            </>
          )}

          <h2 className="history-title">
            <History size={14} /> Preview history
          </h2>
          <div className="list history-list">
            {history.map((entry) => (
              <button key={entry.id} className="history-item" onClick={() => openHistory(entry.id)} title={entry.id}>
                <GitCompareArrows size={13} /> {entry.profileName} <small>r{entry.profileRevision}</small>
                <br />
                <small>
                  {entry.templateName} · {new Date(entry.createdAt).toLocaleString()}
                </small>
                {!entry.profileExists && <span className="badge snapshot">snapshot</span>}
              </button>
            ))}
            {history.length === 0 && <small className="muted">No transforms run yet.</small>}
          </div>
        </aside>

        <section className="pane center">
          {mode === 'template' ? (
            <>
              <div className="toolbar">
                <label className="rev-picker">
                  Client:
                  <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="rev-picker">
                  Config revision:
                  <select
                    value={profileRevision ?? ''}
                    onChange={(e) => setProfileRevision(Number(e.target.value))}
                  >
                    {revisions.length === 0 && <option value="">r?</option>}
                    {revisions.map((r) => (
                      <option key={r.revision} value={r.revision}>
                        r{r.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary" onClick={runTransform}>
                  <Play size={15} /> Transform preview
                </button>
                <button onClick={saveTemplate}>
                  <Save size={15} /> Save template
                </button>
                <span className="status">{status}</span>
              </div>
              <textarea aria-label="Template HTML" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />

              <div className="diff-head">
                <h3>Original</h3>
                <h3>
                  Transformed{' '}
                  {preview && (
                    <small>
                      bound to {preview.profileName} r{preview.profileRevision} · template r{preview.templateRevision}
                    </small>
                  )}
                </h3>
                <div className="view-toggle">
                  <button className={view === 'code' ? 'active' : ''} onClick={() => setView('code')}>
                    Code
                  </button>
                  <button className={view === 'rendered' ? 'active' : ''} onClick={() => setView('rendered')}>
                    Rendered
                  </button>
                </div>
              </div>
              <div className="diff-grid">
                {view === 'code' ? (
                  <>
                    <div className="code-pane">
                      {preview ? (
                        <CodeView root={preview.result.tree} transformed={false} />
                      ) : (
                        <p className="muted">Run a transform to compare.</p>
                      )}
                    </div>
                    <div className="code-pane">
                      {preview ? (
                        <CodeView
                          root={preview.result.tree}
                          transformed
                          activeNid={activeNid}
                          relatedNids={relatedNids}
                        />
                      ) : (
                        <p className="muted">No transform yet.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <iframe title="original render" className="render-frame" srcDoc={preview?.contentSnapshot ?? ''} sandbox="" />
                    <iframe title="transformed render" className="render-frame" srcDoc={preview?.result.outputHtml ?? ''} sandbox="" />
                  </>
                )}
              </div>
            </>
          ) : (
            profileDetail && (
              <>
                <div className="toolbar">
                  <input
                    className="name-input"
                    value={profileDetail.name}
                    onChange={(e) => setProfileDetail({...profileDetail, name: e.target.value})}
                  />
                  <span className="pill">revision {profileDetail.revision}</span>
                  <button className="primary" onClick={saveProfile}>
                    <Save size={15} /> Save (new revision)
                  </button>
                  <button className="danger" onClick={deleteProfile}>
                    <Trash2 size={15} /> Delete
                  </button>
                  <span className="status">{status}</span>
                </div>
                <p className="muted small">
                  Saving bumps the revision and stores an immutable snapshot. Previews bind to the exact revision
                  selected; deleting the profile leaves every revision snapshot and historical preview intact.
                </p>
                <textarea
                  aria-label="Capability config JSON"
                  className="config-editor"
                  value={profileDraft}
                  onChange={(e) => setProfileDraft(e.target.value)}
                  spellCheck={false}
                />
                <h3>Stored revisions</h3>
                <div className="revision-list">
                  {revisions.map((r) => (
                    <button
                      key={r.revision}
                      className={r.revision === profileRevision ? 'active' : ''}
                      onClick={() => setProfileRevision(r.revision)}
                    >
                      r{r.revision} <small>{new Date(r.createdAt).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
              </>
            )
          )}
        </section>

        <aside className="pane inspection">
          <h2>Degradations</h2>
          {preview ? (
            <>
              <div className="stat-row">
                <span className="stat drop">{preview.result.stats.drops} drops</span>
                <span className="stat fallback">{preview.result.stats.fallbacks} fallbacks</span>
                <span className="stat note">{preview.result.stats.notes} notes</span>
              </div>
              {!preview.profileExists && (
                <p className="snapshot-banner">
                  Profile deleted — showing the immutable snapshot {preview.profileName} r{preview.profileRevision}.
                </p>
              )}
              <ul className="explanations">
                {explanations.map((explanation) => (
                  <li key={explanation.id}>
                    <button
                      className={`expl ${activeExplanation?.id === explanation.id ? 'active' : ''}`}
                      onClick={() => setActiveExplanation(explanation)}
                    >
                      <span className={`sev ${explanation.severity}`}>{SEVERITY_LABEL[explanation.severity]}</span>
                      <span className="expl-title">{explanation.title}</span>
                      <small className="expl-node">{explanation.nodeId}</small>
                    </button>
                  </li>
                ))}
              </ul>
              {activeExplanation && (
                <div className="expl-detail">
                  <strong>{activeExplanation.title}</strong>
                  <p>{activeExplanation.detail}</p>
                  <small>
                    Phase {activeExplanation.phase} · node {activeExplanation.nodeId}
                    {activeExplanation.relatedNodeIds.length > 0 && (
                      <> · related {activeExplanation.relatedNodeIds.join(', ')}</>
                    )}
                  </small>
                </div>
              )}
            </>
          ) : (
            <p className="muted">Run a transform to see per-rule explanations. Select one to highlight its node.</p>
          )}
        </aside>
      </section>
    </main>
  );
}
