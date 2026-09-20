import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, History, Play, Save, Trash2} from 'lucide-react';
import {api, type CapabilityProfile, type Explanation, type PreviewResponse, type ProfileDetail, type ProfileSummary, type TemplateRow, type TemplateSummary} from './types';
import {CodeView, resolveTarget} from './CodeView';
import {RenderView} from './RenderView';
import {ProfileEditor} from './ProfileEditor';

type Mode = 'code' | 'rendered';
const severityLabel: Record<Explanation['severity'], string> = {drop: '删除', fallback: '回退', info: '调整', warning: '警告'};

export default function App() {
  const [items, setItems] = useState<TemplateSummary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('就绪');

  const [profileList, setProfileList] = useState<ProfileSummary[]>([]);
  const [profileId, setProfileId] = useState('gmail-android');
  const [profileRevision, setProfileRevision] = useState<number | null>(null);
  const [profileDetail, setProfileDetail] = useState<ProfileDetail | null>(null);
  const [draftConfig, setDraftConfig] = useState<CapabilityProfile | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [selectedExplanation, setSelectedExplanation] = useState<Explanation | null>(null);
  const [leftMode, setLeftMode] = useState<Mode>('code');
  const [rightMode, setRightMode] = useState<Mode>('code');
  const [codePick, setCodePick] = useState<string | null>(null);

  const previewSeq = useRef(0);

  useEffect(() => {api.templates().then(setItems).catch(() => {});}, []);
  useEffect(() => {api.profiles().then(list => {setProfileList(list);}).catch(() => {});}, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('加载模板');
    api.template(selected).then(value => {
      if (cancelled) return;
      setRow(value); setDraft(value.content); setDirty(false); setStatus('已加载');
    }).catch(() => !cancelled && setStatus('加载失败'));
    return () => {cancelled = true;};
  }, [selected]);

  const loadProfile = useCallback((id: string, revision?: number | undefined) => {
    api.profile(id, revision).then(detail => {
      setProfileDetail(detail);
      setDraftConfig(detail.config);
      setProfileRevision(detail.revision);
      setConfigDirty(false);
      setShowHistory(false);
    }).catch(() => setStatus('配置加载失败'));
  }, []);

  useEffect(() => {loadProfile(profileId);}, [profileId, loadProfile]);

  // 预览绑定的配置 revision：默认当前；历史模式下用户可改
  const runPreview = useCallback(async (contentOverride?: string) => {
    if (profileRevision == null) return;
    const content = contentOverride ?? draft ?? '';
    const rev = profileRevision;
    const seq = ++previewSeq.current;
    setStatus('生成预览');
    try {
      const result = await api.preview(selected, content, profileId, rev);
      if (seq !== previewSeq.current) return;
      setPreview(result);
      setSelectedExplanation(null);
      setCodePick(null);
      setStatus(result.snapshot ? `预览基于已删除配置的历史快照 rev.${rev}` : `预览绑定 rev.${rev}`);
    } catch (e) {
      setStatus(`预览失败：${(e as Error).message}`);
    }
  }, [selected, draft, profileId, profileRevision]);

  // 模板或绑定配置 revision 变化时自动预览
  useEffect(() => {if (row) void runPreview(); /* eslint-disable-next-line react-hooks/exhaustive-deps */}, [selected, profileId, profileRevision]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!dirty) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runPreview(), 400);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  async function saveTemplate() {
    if (!row) return;
    setStatus('保存模板');
    try {
      const value = await api.saveTemplate(row.id, draft, row.revision);
      setRow(value); setDraft(value.content); setDirty(false); setStatus(`已保存 rev.${value.revision}`);
      void runPreview(value.content);
    } catch (e) {
      setStatus((e as {body?: {error?: string}}).body?.error === 'revision_conflict' ? '模板版本冲突，请刷新' : '保存失败');
    }
  }

  async function saveProfileConfig() {
    if (!draftConfig || !profileDetail) return;
    setStatus('保存配置');
    try {
      const summary = await api.saveProfile(profileId, profileDetail.name, stripVersion(draftConfig), profileDetail.revision);
      setStatus(`配置已保存 rev.${summary.revision}`);
      const list = await api.profiles();
      setProfileList(list);
      loadProfile(profileId, summary.revision); // 预览自动切到新 revision
    } catch (e) {
      const err = (e as {body?: {error?: string}}).body?.error;
      setStatus(err === 'revision_conflict' ? '配置版本冲突：他人已更新，请重新载入' : `配置保存失败：${err ?? ''}`);
    }
  }

  async function deleteProfile() {
    if (!profileDetail) return;
    if (!confirm(`删除配置 “${profileDetail.name}”？历史预览仍可按 revision 查看。`)) return;
    try {
      await api.deleteProfile(profileId);
      const list = await api.profiles();
      setProfileList(list);
      const next = list.find(p => p.deletedAt === null && p.id !== profileId);
      if (next) setProfileId(next.id);
      setStatus('配置已删除（历史快照保留）');
    } catch {setStatus('删除失败');}
  }

  // 解释 → 两侧定位
  const onSelectExplanation = (ex: Explanation | null) => {
    setSelectedExplanation(ex);
    setCodePick(ex?.targetId ?? null);
  };

  const leftTarget = selectedExplanation && preview
    ? resolveTarget(preview.original, selectedExplanation.targetId, selectedExplanation.selectors) : null;
  const rightTarget = selectedExplanation && preview
    ? resolveTarget(preview.transformed, selectedExplanation.targetId, selectedExplanation.selectors) : null;

  const codePickHandler = useCallback((id: string) => {
    setCodePick(id);
    // 从代码反向选择解释：优先找 targetId 命中且 survives 状态一致的条目
    const hit = preview?.explanations.find(e => e.targetId === id);
    setSelectedExplanation(hit ?? null);
  }, [preview]);

  const grouped = useMemo(() => {
    if (!preview) return [];
    const order: Explanation['severity'][] = ['drop', 'fallback', 'warning', 'info'];
    return [...preview.explanations].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  }, [preview]);

  const currentProfileSummary = profileList.find(p => p.id === profileId);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/><strong>邮件渲染实验室</strong>
        <small>客户端能力配置 · 版本化降级预览</small>
        <span className="status">{status}</span>
      </header>
      <section className="workspace">
        <aside className="pane pane-left">
          <h2>模板</h2>
          <div className="list">
            {items.map(item => (
              <button key={item.id} className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)}>
                {item.name}<br/><small>模板 rev.{item.revision}</small>
              </button>
            ))}
          </div>
          <h2>客户端能力配置</h2>
          <div className="list">
            {profileList.map(p => (
              <button key={p.id} className={p.id === profileId ? 'active' : ''} onClick={() => setProfileId(p.id)}>
                {p.name}{p.deletedAt && <span className="tag tag-dead">已删除</span>}
                <br/><small>配置 rev.{p.revision}{p.deletedAt ? ' · 快照可查' : ''}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane pane-center">
          <div className="toolbar">
            <button className="primary" onClick={saveTemplate} disabled={!dirty}><Save size={15}/>保存模板</button>
            <button onClick={() => void runPreview()}><Play size={15}/>预览</button>
            <span className="binding">
              预览绑定：<strong>{preview?.profile.name ?? profileId}</strong>
              <span className={preview?.snapshot ? 'tag tag-snapshot' : 'tag tag-live'}>
                {preview?.snapshot ? `历史快照 rev.${preview.profile.revision}` : `rev.${preview?.profile.revision ?? profileRevision}`}
              </span>
            </span>
            {preview?.snapshot && <span className="muted">该配置已被删除，展示的是删除前快照</span>}
          </div>
          <div className="dual">
            <div className="view-pane">
              <div className="view-head">
                <span>原始模板</span>
                <div className="seg">
                  <button className={leftMode === 'code' ? 'on' : ''} onClick={() => setLeftMode('code')}>代码</button>
                  <button className={leftMode === 'rendered' ? 'on' : ''} onClick={() => setLeftMode('rendered')}>渲染</button>
                </div>
              </div>
              {preview && (leftMode === 'code'
                ? <CodeView view={preview.original} highlightId={codePick} dimmed={Boolean(selectedExplanation && !leftTarget)} onPick={codePickHandler}/>
                : <RenderView html={preview.original.html} selectors={leftTarget?.selector ? [leftTarget.selector] : null}/>)}
              {selectedExplanation && !leftTarget && <div className="miss-hint">该节点在原始模板中无对应位置</div>}
            </div>
            <div className="view-pane">
              <div className="view-head">
                <span>转换结果</span>
                <div className="seg">
                  <button className={rightMode === 'code' ? 'on' : ''} onClick={() => setRightMode('code')}>代码</button>
                  <button className={rightMode === 'rendered' ? 'on' : ''} onClick={() => setRightMode('rendered')}>渲染</button>
                </div>
              </div>
              {preview && (rightMode === 'code'
                ? <CodeView view={preview.transformed} highlightId={codePick} dimmed={Boolean(selectedExplanation && !rightTarget)} onPick={codePickHandler}/>
                : <RenderView html={preview.transformed.html} selectors={rightTarget?.selector ? [rightTarget.selector] : null}/>)}
              {selectedExplanation && !rightTarget && <div className="miss-hint">该节点已被降级移除，转换结果中不存在</div>}
            </div>
          </div>
          <details className="template-source">
            <summary>编辑模板源码（当前 rev.{row?.revision}）</summary>
            <textarea aria-label="模板内容" value={draft} onChange={e => {setDraft(e.target.value); setDirty(true);}}/>
          </details>
        </section>

        <aside className="pane pane-right">
          <div className="tabs">
            <button onClick={() => setShowHistory(false)} className={!showHistory ? 'active' : ''}>降级解释</button>
            <button onClick={() => setShowHistory(true)} className={showHistory ? 'active' : ''}><History size={13}/> 配置与历史</button>
          </div>

          {!showHistory ? (
            <>
              <div className="expl-summary">
                共 {preview?.explanations.length ?? 0} 条变化
                ：{grouped.filter(e => e.severity === 'drop').length} 删除
                / {grouped.filter(e => e.severity === 'fallback').length} 回退
              </div>
              <ul className="expl-list">
                {grouped.map(ex => (
                  <li key={ex.id}>
                    <button
                      className={'expl-item sev-' + ex.severity + (selectedExplanation?.id === ex.id ? ' selected' : '')}
                      onClick={() => onSelectExplanation(selectedExplanation?.id === ex.id ? null : ex)}>
                      <span className="badge">{severityLabel[ex.severity]}</span>
                      <span className="expl-msg">{ex.message}</span>
                      <small className="expl-loc">{ex.location || codeName(ex.code)}</small>
                    </button>
                  </li>
                ))}
                {grouped.length === 0 && <li className="muted">该配置下模板没有发生降级</li>}
              </ul>
            </>
          ) : (
            <div className="history-pane">
              <div className="history-head">
                <strong>{profileDetail?.name}</strong>
                <span className="muted">config schema v{profileDetail?.config.version}</span>
                <button className="icon-btn danger" onClick={deleteProfile} title="删除配置（历史快照保留）"><Trash2 size={14}/></button>
              </div>
              <div className="revision-list">
                {currentProfileSummary && Array.from({length: currentProfileSummary.revision}, (_, i) => currentProfileSummary.revision - i).map(rev => (
                  <button key={rev}
                    className={'revision-item' + (rev === profileRevision ? ' active' : '') + (rev === currentProfileSummary.revision ? '' : ' old')}
                    onClick={() => {setProfileRevision(rev); loadProfile(profileId, rev);}}>
                    revision {rev}{rev === currentProfileSummary.revision ? '（最新）' : '（历史快照）'}
                    {rev === preview?.profile.revision && <span className="tag tag-snapshot">预览中</span>}
                  </button>
                ))}
              </div>
              {draftConfig && <>
                <div className="editor-bar">
                  <button className="primary" onClick={saveProfileConfig} disabled={!configDirty || profileRevision !== currentProfileSummary?.revision}>
                    <Save size={14}/>保存为新 revision
                  </button>
                  {profileRevision !== currentProfileSummary?.revision && <small className="muted">正在查看历史快照，切回最新 revision 才能编辑</small>}
                  {currentProfileSummary?.deletedAt && <small className="muted">配置已删除，仅可查看快照</small>}
                </div>
                <ProfileEditor
                  config={draftConfig}
                  readOnly={profileRevision !== currentProfileSummary?.revision || Boolean(currentProfileSummary?.deletedAt)}
                  onChange={c => {setDraftConfig(c); setConfigDirty(true);}}/>
              </>}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

function stripVersion(c: CapabilityProfile): Omit<CapabilityProfile, 'version'> {
  const {version: _v, ...rest} = c;
  return rest;
}
function codeName(code: string): string {
  return code.replace(/-/g, ' ');
}
