import {useState} from 'react';
import {Plus, Trash2} from 'lucide-react';
import type {CapabilityProfile} from './types';

interface ProfileEditorProps {
  config: CapabilityProfile;
  onChange: (next: CapabilityProfile) => void;
  readOnly?: boolean;
}

function csv(v: string[]): string {return v.join(', ')}
function parseCsv(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

export function ProfileEditor({config, onChange, readOnly}: ProfileEditorProps) {
  const [newFb, setNewFb] = useState({property: 'display', value: '', fallback: ''});
  const patch = (fn: (draft: CapabilityProfile) => void) => {
    const draft: CapabilityProfile = structuredClone(config);
    fn(draft);
    onChange(draft);
  };

  return (
    <div className="profile-editor">
      <label className="field">
        <span>客户端名称</span>
        <input value={config.client} disabled={readOnly}
          onChange={e => patch(d => {d.client = e.target.value})} />
      </label>

      <fieldset className="field-group" disabled={readOnly}>
        <legend>CSS</legend>
        <label className="field">
          <span>不支持的属性（逗号分隔）</span>
          <input value={csv(config.css.unsupportedProperties)}
            onChange={e => patch(d => {d.css.unsupportedProperties = parseCsv(e.target.value)})}
            placeholder="gap, float, position" />
        </label>
        <label className="field">
          <span>支持的媒体特性（width 代表 min-/max-width）</span>
          <input value={csv(config.css.supportedMediaFeatures)}
            onChange={e => patch(d => {d.css.supportedMediaFeatures = parseCsv(e.target.value)})}
            placeholder="width, hover" />
        </label>
        <label className="check">
          <input type="checkbox" checked={config.css.mediaNested}
            onChange={e => patch(d => {d.css.mediaNested = e.target.checked})} />
          支持嵌套 @media
        </label>

        <div className="field">
          <span>值级回退</span>
          <table className="fb-table">
            <thead><tr><th>属性</th><th>不支持的值</th><th>回退值（空 = 删除声明）</th><th></th></tr></thead>
            <tbody>
              {config.css.valueFallbacks.map((f, i) => (
                <tr key={i}>
                  <td><code>{f.property}</code></td>
                  <td><code>{f.value}</code></td>
                  <td><code>{f.fallback || '∅ 删除'}</code></td>
                  <td>
                    <button className="icon-btn" title="删除该回退"
                      onClick={() => patch(d => {d.css.valueFallbacks.splice(i, 1)})}>
                      <Trash2 size={13}/>
                    </button>
                  </td>
                </tr>
              ))}
              {config.css.valueFallbacks.length === 0 && <tr><td colSpan={4} className="muted">暂无回退规则</td></tr>}
            </tbody>
          </table>
          <div className="fb-add">
            <input placeholder="属性，如 display" value={newFb.property}
              onChange={e => setNewFb({...newFb, property: e.target.value})} />
            <input placeholder="不支持的值，如 flex" value={newFb.value}
              onChange={e => setNewFb({...newFb, value: e.target.value})} />
            <input placeholder="回退值，如 block（留空=删除）" value={newFb.fallback}
              onChange={e => setNewFb({...newFb, fallback: e.target.value})} />
            <button onClick={() => {
              if (!newFb.property || !newFb.value) return;
              patch(d => {d.css.valueFallbacks = [...d.css.valueFallbacks.filter(
                f => !(f.property === newFb.property.toLowerCase() && f.value.toLowerCase() === newFb.value.toLowerCase()),
              ), {property: newFb.property.toLowerCase(), value: newFb.value, fallback: newFb.fallback}];});
              setNewFb({property: newFb.property, value: '', fallback: ''});
            }}><Plus size={13}/>添加</button>
          </div>
        </div>
      </fieldset>

      <fieldset className="field-group" disabled={readOnly}>
        <legend>图片</legend>
        <label className="field">
          <span>支持的格式</span>
          <input value={csv(config.images.supportedFormats)}
            onChange={e => patch(d => {d.images.supportedFormats = parseCsv(e.target.value)})}
            placeholder="jpg, png, webp, avif" />
        </label>
        <label className="field">
          <span>不支持格式的回退后缀（空 = 保留原地址）</span>
          <input value={config.images.fallbackFormat}
            onChange={e => patch(d => {d.images.fallbackFormat = e.target.value.trim()})}
            placeholder="jpg" />
        </label>
        <label className="check">
          <input type="checkbox" checked={config.images.picture}
            onChange={e => patch(d => {d.images.picture = e.target.checked})} />
          支持 <code>&lt;picture&gt;</code> 候选
        </label>
      </fieldset>

      <fieldset className="field-group" disabled={readOnly}>
        <legend>Dark mode</legend>
        <label className="check">
          <input type="checkbox" checked={config.darkMode}
            onChange={e => patch(d => {d.darkMode = e.target.checked})} />
          支持 <code>prefers-color-scheme: dark</code>
        </label>
      </fieldset>
    </div>
  );
}
