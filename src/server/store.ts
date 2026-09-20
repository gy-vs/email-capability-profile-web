import type {
  CapabilityConfig,
  PreviewRecord,
  ProfileDetail,
  ProfileSnapshot,
  TemplateRow,
} from '../shared/types';
import {PRESET_CONFIGS} from './capabilities';
import {transform} from './transform';

export interface TemplateRecord extends TemplateRow {}

export interface ProfileRecord extends ProfileDetail {}

interface Store {
  templates: TemplateRecord[];
  profiles: ProfileRecord[];
  /** Immutable config snapshots keyed `${profileId}#${revision}`. Never deleted. */
  snapshots: Map<string, ProfileSnapshot>;
  previews: PreviewRecord[];
}

export const TEMPLATE_ALPHA = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
  .banner {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    color: #1f3a5f;
    color: color-mix(in srgb, #1f3a5f, white 10%);
    text-shadow: 0 1px 2px rgba(0,0,0,.2);
    padding: 16px;
  }
  /* Later rule wins the cascade; once its color-mix value is dropped,
     the earlier #17314d below resurges — a rule-conflict explanation. */
  .banner { color: #17314d; }
  .banner { color: color-mix(in srgb, #17314d, white 20%); }
  @media (min-width: 600px) {
    .banner { display: grid; color: #10243b; }
    @media (hover: hover) {
      .banner:hover { color: #0b1a2b; }
    }
  }
  @media (prefers-color-scheme: dark) {
    .banner { color: #d7e7f7; }
    [data-ogsc] .banner { color: #ffd8a8; }
  }
</style>
</head>
<body>
  <div class="banner" style="display:grid;gap:8px">
    <picture>
      <source type="image/avif" srcset="hero.avif">
      <source type="image/webp" srcset="hero.webp">
      <img src="hero.jpg" alt="Hero" width="320">
    </picture>
    <p>Quarterly render report</p>
  </div>
</body>
</html>`;

export const TEMPLATE_BETA = `<!doctype html>
<html>
<head><meta name="color-scheme" content="light dark"></head>
<body>
<style>
  .cta { background: #176b55; color: #fff; border-radius: 12px; padding: 10px; }
  @media (max-width: 480px) { .cta { width: 100%; } }
</style>
<picture>
  <source type="image/avif" srcset="promo.avif">
  <img src="promo.png" alt="Promo">
</picture>
<a class="cta" style="color:#fff;color:light-dark(#111,#eee)">Open report</a>
</body>
</html>`;

function seedProfiles(): ProfileRecord[] {
  const now = Date.parse('2026-09-01T09:00:00.000Z');
  return [
    {
      id: 'gmail',
      name: 'Gmail mobile (2024)',
      revision: 3,
      updatedAt: new Date(now).toISOString(),
      config: clone(PRESET_CONFIGS.gmail),
    },
    {
      id: 'outlook',
      name: 'Outlook 2016 (Word engine)',
      revision: 1,
      updatedAt: new Date(now + 1000).toISOString(),
      config: clone(PRESET_CONFIGS.outlook),
    },
    {
      id: 'modern',
      name: 'Modern baseline (Apple Mail / iOS 18)',
      revision: 1,
      updatedAt: new Date(now + 2000).toISOString(),
      config: clone(PRESET_CONFIGS.modern),
    },
  ];
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createStore(): Store {
  const templates: TemplateRecord[] = [
    {
      id: 'alpha',
      name: 'Primary render previews',
      revision: 4,
      content: TEMPLATE_ALPHA,
      updatedAt: new Date(0).toISOString(),
    },
    {
      id: 'beta',
      name: 'Secondary render previews',
      revision: 6,
      content: TEMPLATE_BETA,
      updatedAt: new Date(1000).toISOString(),
    },
  ];
  const profiles = seedProfiles();
  const snapshots = new Map<string, ProfileSnapshot>();
  for (const profile of profiles) {
    snapshots.set(snapshotKey(profile.id, profile.revision), {
      profileId: profile.id,
      revision: profile.revision,
      name: profile.name,
      config: clone(profile.config),
      createdAt: profile.updatedAt,
    });
  }
  return {templates, profiles, snapshots, previews: []};
}

export function snapshotKey(profileId: string, revision: number): string {
  return `${profileId}#${revision}`;
}

// --- Template ops ---

export function updateTemplate(
  store: Store,
  id: string,
  content: string,
  revision: number,
): {status: 404 | 409 | 200; row?: TemplateRecord; current?: TemplateRecord} {
  const row = store.templates.find((t) => t.id === id);
  if (!row) return {status: 404};
  if (revision !== row.revision) return {status: 409, current: row};
  row.content = content;
  row.revision += 1;
  row.updatedAt = new Date().toISOString();
  return {status: 200, row};
}

// --- Profile ops (revision optimistic locking, snapshots never deleted) ---

export function listProfiles(store: Store): ProfileRecord[] {
  return [...store.profiles].sort((a, b) => a.id.localeCompare(b.id));
}

export function getProfile(store: Store, id: string): ProfileRecord | undefined {
  return store.profiles.find((p) => p.id === id);
}

export function getProfileRevision(store: Store, id: string, revision: number): ProfileSnapshot | undefined {
  return store.snapshots.get(snapshotKey(id, revision));
}

export function listProfileRevisions(store: Store, id: string): ProfileSnapshot[] {
  return [...store.snapshots.values()]
    .filter((s) => s.profileId === id)
    .sort((a, b) => a.revision - b.revision);
}

export function createProfile(
  store: Store,
  id: string,
  name: string,
  config: CapabilityConfig,
): {status: 201 | 409; record?: ProfileRecord} {
  if (store.profiles.some((p) => p.id === id)) return {status: 409};
  const record: ProfileRecord = {id, name, revision: 1, updatedAt: new Date().toISOString(), config: clone(config)};
  store.profiles.push(record);
  store.snapshots.set(snapshotKey(id, 1), toSnapshot(record));
  return {status: 201, record};
}

export function updateProfile(
  store: Store,
  id: string,
  name: string,
  config: CapabilityConfig,
  revision: number,
): {status: 404 | 409 | 200; record?: ProfileRecord; current?: ProfileRecord} {
  const record = store.profiles.find((p) => p.id === id);
  if (!record) return {status: 404};
  if (revision !== record.revision) return {status: 409, current: record};
  record.name = name;
  record.config = clone(config);
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
  // Save takes a revision: the new revision's snapshot is captured immediately,
  // so history can always replay it, even after later edits or deletion.
  store.snapshots.set(snapshotKey(id, record.revision), toSnapshot(record));
  return {status: 200, record};
}

export function deleteProfile(store: Store, id: string): boolean {
  const index = store.profiles.findIndex((p) => p.id === id);
  if (index === -1) return false;
  store.profiles.splice(index, 1); // snapshots and previews are intentionally retained
  return true;
}

function toSnapshot(record: ProfileRecord): ProfileSnapshot {
  return {
    profileId: record.id,
    revision: record.revision,
    name: record.name,
    config: clone(record.config),
    createdAt: record.updatedAt,
  };
}

// --- Previews: bind template + content snapshot + exact profile revision ---

export function runPreview(
  store: Store,
  templateId: string,
  profileId: string,
  profileRevision: number,
  contentOverride?: string,
): {status: 404; error: string} | {status: 200; record: PreviewRecord} {
  const template = store.templates.find((t) => t.id === templateId);
  if (!template) return {status: 404, error: 'template_not_found'};
  const snapshot = store.snapshots.get(snapshotKey(profileId, profileRevision));
  if (!snapshot) return {status: 404, error: 'profile_revision_not_found'};
  const contentSnapshot = contentOverride ?? template.content;
  const result = transform(contentSnapshot, snapshot.config);
  const record: PreviewRecord = {
    id: `pv-${store.previews.length + 1}-${Date.now().toString(36)}`,
    templateId: template.id,
    templateName: template.name,
    templateRevision: template.revision,
    profileId,
    profileName: snapshot.name,
    profileRevision,
    profileExists: store.profiles.some((p) => p.id === profileId),
    createdAt: new Date().toISOString(),
    contentSnapshot,
    profile: clone(snapshot),
    result,
  };
  store.previews.unshift(record);
  return {status: 200, record};
}

export function listPreviews(store: Store): PreviewRecord[] {
  return store.previews;
}

export function getPreview(store: Store, id: string): PreviewRecord | undefined {
  return store.previews.find((p) => p.id === id);
}
