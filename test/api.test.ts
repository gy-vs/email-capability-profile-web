import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const gmailUpdate = {
  name: 'Gmail Android',
  config: {
    client: 'Gmail App · Android',
    css: {
      unsupportedProperties: ['gap'],
      supportedMediaFeatures: ['width'],
      mediaNested: false,
      valueFallbacks: [{property: 'display', value: 'flex', fallback: 'block'}],
    },
    images: {supportedFormats: ['jpg', 'png'], fallbackFormat: 'jpg', picture: false},
    darkMode: false,
  },
};

describe('capability profile API', () => {
  it('保存配置使用 revision 乐观锁，每次保存生成新 revision 快照', async () => {
    const app = createApp();
    const before = await request(app).get('/api/profiles/gmail-android').expect(200);
    expect(before.body.revision).toBe(1);
    await request(app).put('/api/profiles/gmail-android').send({...gmailUpdate, revision: 1}).expect(200);
    // 旧 revision 仍然可读（快照）
    const rev1 = await request(app).get('/api/profiles/gmail-android?revision=1').expect(200);
    expect(rev1.body.config.css.unsupportedProperties).toEqual(['gap', 'grid-template-columns', 'border-radius']);
    const rev2 = await request(app).get('/api/profiles/gmail-android?revision=2').expect(200);
    expect(rev2.body.config.css.unsupportedProperties).toEqual(['gap']);
    expect(rev2.body.config.version).toBe('1.0');
    // 过期 revision 保存被拒
    await request(app).put('/api/profiles/gmail-android').send({...gmailUpdate, revision: 1}).expect(409);
  });

  it('预览必须绑定 profileRevision，返回逐条解释与双视图', async () => {
    const app = createApp();
    const res = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'gmail-android', profileRevision: 1}).expect(200);
    expect(res.body.profile.revision).toBe(1);
    expect(res.body.original.html).toContain('data-nid=');
    expect(res.body.transformed.html).toContain('data-nid=');
    const codes = res.body.explanations.map((e: {code: string}) => e.code);
    expect(codes).toContain('property-removed');
    expect(codes).toContain('value-fallback');
    expect(codes).toContain('dark-block-dropped');
    expect(codes).toContain('picture-unwrapped');
    // 区间映射存在（前端点击定位用）
    expect(Object.keys(res.body.transformed.ranges).length).toBeGreaterThan(0);
    // 未传 revision → 400
    await request(app).post('/api/templates/alpha/preview').send({profileId: 'gmail-android'}).expect(400);
  });

  it('旧配置删除后，历史预览仍能显示当时快照；新预览不能再绑定', async () => {
    const app = createApp();
    // 先用 rev1 渲染
    const before = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 1}).expect(200);
    expect(before.body.snapshot).toBe(false);
    // 删除配置（软删除）
    await request(app).delete('/api/profiles/apple-mail').expect(200);
    // 历史 revision 仍可读
    const old = await request(app).get('/api/profiles/apple-mail?revision=1').expect(200);
    expect(old.body.config.darkMode).toBe(true);
    // 用旧 revision 仍能渲染出当时快照
    const snapshotPreview = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 1}).expect(200);
    expect(snapshotPreview.body.snapshot).toBe(true);
    expect(snapshotPreview.body.profile.deletedAt).toBeTruthy();
    expect(snapshotPreview.body.transformed.html).toBe(before.body.transformed.html);
    // 不存在的 revision → 404
    await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 99}).expect(404);
  });

  it('配置更新后预览绑定的旧 revision 不漂移，切到新 revision 才体现差异', async () => {
    const app = createApp();
    // rev1 支持 dark（apple-mail 种子），无 dark 降级
    const rev1 = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 1}).expect(200);
    expect(rev1.body.explanations.some((e: {code: string}) => e.code === 'dark-block-dropped')).toBe(false);

    // 保存 rev2：关闭 dark mode
    await request(app).put('/api/profiles/apple-mail').send({
      name: 'Apple Mail',
      revision: 1,
      config: {
        client: 'Apple Mail · iOS 17',
        css: {unsupportedProperties: [], supportedMediaFeatures: ['width', 'hover'], mediaNested: true, valueFallbacks: []},
        images: {supportedFormats: ['jpg', 'png', 'gif', 'webp', 'avif'], fallbackFormat: 'jpg', picture: true},
        darkMode: false,
      },
    }).expect(200);

    // 仍绑定 rev1 → 结果不变
    const stillRev1 = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 1}).expect(200);
    expect(stillRev1.body.transformed.html).toBe(rev1.body.transformed.html);
    expect(stillRev1.body.snapshot).toBe(false);
    // 切到 rev2 → 出现 dark 降级
    const rev2 = await request(app).post('/api/templates/alpha/preview')
      .send({profileId: 'apple-mail', profileRevision: 2}).expect(200);
    expect(rev2.body.explanations.some((e: {code: string}) => e.code === 'dark-block-dropped')).toBe(true);
  });

  it('非法配置返回 400', async () => {
    const app = createApp();
    await request(app).put('/api/profiles/gmail-android').send({
      name: 'x', revision: 1, config: {client: '', css: {}, images: {}},
    }).expect(400);
  });

  it('模板保存仍按 revision 乐观锁', async () => {
    const app = createApp();
    const before = await request(app).get('/api/templates/alpha').expect(200);
    await request(app).put('/api/templates/alpha').send({content: '<div>v2</div>', revision: before.body.revision}).expect(200);
    await request(app).put('/api/templates/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });
});
