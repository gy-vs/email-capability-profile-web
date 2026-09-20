# Email Rendering Lab

邮件模板客户端兼容性工作台：声明某个邮件客户端的能力配置（CSS 属性、媒体查询、图片格式、dark mode），
查看模板在该配置下发生的逐条降级，并在原始 / 转换结果间并排定位节点。

运行：

```bash
npm install
npm run dev      # API :4174，前端 :4173
npm test         # vitest
npm run build    # tsc 类型检查 + vite 构建
```

## 能力配置（版本化）

`GET/PUT /api/profiles/:id`、`DELETE`（软删除）、`GET ?revision=n`（历史快照）。
保存使用 `revision` 乐观锁，每次保存追加一条不可变历史；删除后历史 revision 仍可读取和渲染。

预览必须显式绑定 `profileRevision`：

```
POST /api/templates/:id/preview  {profileId, profileRevision, content?}
```

响应包含原始 / 转换两份带 `data-nid` 标注的 HTML、逐节点字符区间，以及逐条解释。
配置事后被修改或删除，旧 revision 渲染出的结果不漂移（`snapshot: true` 标记删除态快照）。

## 降级模型（src/server/engine）

- `parser.ts`：容错 HTML/CSS 解析，解析时即给每个元素 / 规则 / 媒体块 / 声明分配稳定 id；
  转换只打 `detached` 标记或移动节点，id 永不重新分配（保持节点身份）。
- `transform.ts`：三个按固定顺序执行的 pass
  1. dark mode + 媒体查询：dark 门控块丢弃在前；嵌套 `@media` 先合并查询提升，再对提升结果做能力评估（互相依赖的降级按确定顺序执行）；
  2. 图片候选：删不受支持的 `<source>` → `<picture>` 解包为 `<img>` → `<img>` 后缀按回退格式改写；
  3. 声明级：规则以数据注册后按固定优先级排序（属性删除 60 优先于值回退 70），
     同一声明命中多条规则时只有先生效的执行，其余产生 `conflict-skipped` 解释。
     `shuffleSeed` 可扰动注册顺序，测试用来证明输出与遍历顺序无关。
- `serialize.ts`：确定性序列化，输出每个 id 的字符区间（含 `<style>` 内 CSS 的全局区间、内联样式区间）。

## 前端

- 中间双栏：原始模板 / 转换结果，各有代码与渲染（iframe）两种视图。
- 右侧“降级解释”：选择一条解释，两侧同时滚动高亮对应节点；转换侧不存在的节点给出提示。
  代码视图里点击任意节点可反向选中相关解释。
- 右侧“配置与历史”：编辑能力配置后保存为新 revision；revision 列表可回看 / 绑定任意历史快照，
  已删除配置标记“历史快照”仍可渲染。
