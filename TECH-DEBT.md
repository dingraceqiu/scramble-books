# 技术债留档（Reading State / Learning Foundation）

> 2026-09-05，由产品验收反馈确立。按约定：先留档，不在本轮重构。
> 背景架构原则见 AGENTS.md「关键设计约定」第一条：Source 是事实层；ReadingUnit 是呈现层；Knowledge Point 是学习层。

---

## TD-01 — KP eligibility 仍是「完全已读的 ReadingUnit」粒度（MVP 简化）

- **现状**：`useStore.ensureKnowledgePoints` 以 `isUnitRead`（readRanges 完全覆盖整个单元）为抽取门槛。
- **目标**：`KnowledgePoint.sourceRanges ⊆ ReadingProgress.readRanges` 的直接判定，不再绕回 ReadingUnit。
- **为什么现在可行**：`readState.isRangeCovered` 已经能表达目标判定（`scripts/verify-reading-state.ts` 场景 6 演示：KP 范围 [3..5] 未读 → false；读完 → true）。
- **改造点**：抽取入口从「已读单元的 sourceText」改为「已读区间的原文节点文本」（需从 documents store 按 range 取节点），KP 去重键从单元起点改为区间本身。
- **风险提示**：改造后干扰项池也必须按同一 eligibility 过滤（见 TD-03）。

## TD-02 — Learning 层任何对象不得依赖 ReadingUnit ID 作为永久身份

- ReadingUnit 是呈现层对象，边界随切分算法/书籍类型改变而重建（id 用 `uid()` 重新生成）。
- 现状检查：`Highlight`/`Note` 仍带 `unitId`（历史字段）但**同时**带 chapterId+nodeIndex；KP/Attempt/Quiz 只依赖 sourceRange，符合要求。
- 待办：`Highlight.unitId`/`Note.unitId` 应降级为可选缓存或移除；任何新学习层字段禁止引用 unitId。

## TD-03 — 「只考已读」必须覆盖题目的一切内容，不只是 KP 来源

- 不变量：题干、正确答案、干扰项、解释、source evidence 全部必须来自已读区域。
- 当前实现审计（2026-09-05）：满足。因为 (a) KP 只从已读单元抽取；(b) 题干=KP.concept、正确答案与 evidence=KP.quote、解释=KP.explanation、干扰项=其他 KP 的 quote——而 KP 集合整体来自已读内容。
- **状态升级（2026-09-05）**：已从「上游假设」升级为**代码内强制 + 回归契约**：
  1. `buildRecallQuestion(kp, pool, { readRangesByChapter })` 内部用 `isKpEligible`（= KP.sourceRanges ⊆ readRanges）同时校验题干 KP 与每一个干扰项；Study 出题路径已传入真实 readRanges；
  2. 契约测试 `pnpm verify:quiz-leakage`（scripts/verify-quiz-leakage.ts）：已读 KP-A/B + 未读 KP-C/D 混合池，连续 300 轮出题，断言 stem KP、answer、options、evidence 无任何未读文本，未读 KP 作题干返回 null。**TD-01 改动 eligibility 时此测试是最先该跑的回归**。

## TD-04 — Mastery 目前只是 Attempt 推导框架，不等于「真正掌握」

- 现状：`masteryByLevel/kpMastery` 是正确率聚合，Level 只有 1（Recall）在跑。
- 约束：Level 1–4 必须分别建模（已有 `LearningLevel` 类型与按层聚合）；**永远不要**把各层平均成一个总分；未测量（attempts=0）必须与「测过全错」区分显示（当前 rate=null 的约定要保持）。
- 未来增强方向：近期作答加权（遗忘曲线）、最低作答次数门槛（attempts<2 不给 rate）、Mastery 反哺 Feed 重推。

## TD-05 — sourceRanges 的坐标稳定性未定义（下一阶段最优先查证）

- 现状坐标：`chapterId + nodeIndex 闭区间`。chapterId/nodeIndex 由解析器在**导入时**生成（`uid('ch')` / 数组下标）。
- 当前为什么安全：同一本书的 documents store 记录只在导入时写入一次；重切分（setBookType）不重新解析、不改节点；删除书 = 级联删除其全部阅读状态（bookId 隔离）。重新导入同一文件会生成**新的 bookId**，旧状态自然失效——所以「同 bookId 内 index 漂移」今天不会发生。
- **会打破前提的功能**（做任何一个之前必须先解决本 TD）：
  1. 同一本书重新解析/替换文件（如 EPUB 升级版、PDF 支持）但保留阅读历史；
  2. 服务端/跨设备重新解析（现在快照同步的是整份 documents，所以安全；若将来只同步原文+坐标就危险了）；
  3. 解析器升级导致老用户书籍重新解析迁移。
- 目标方案（届时评估，不必现在做）：`sourceDocumentHash`（书籍内容指纹）+ 章节稳定 id（基于章节标题+序号推导而非随机 uid）+ 节点文本 fingerprint 匹配迁移；坐标表达从裸 index 升级为「index + 文本指纹」双保险。
- **API 语义分离（2026-09-05 验收补充）**：必须区分两种操作——
  **presentation re-segmentation**（documents 不变，仅重建 ReadingUnit，如 `setBookType`）：`readRanges` 完整保留，这正是 `replaceBookContent(..., preserveReadRanges)` 的唯一合法用途；
  **source re-parsing**（原文重新经过 parser，documents 可能变化）：现有 `[chapterId, nodeIndex]` 坐标不保证安全，必须先经 source migration / fingerprint reconciliation，**不得**机械地传 `preserveReadRanges: true`。
  长期应把 API 拆为概念上的 `replaceReadingUnits(...)`（必须保留 ranges）与 `replaceCanonicalSource(...)`（必须走迁移），防止未来有人把两个语义混进同一个函数。在拆分完成前，`replaceBookContent` 调用点必须注释声明自己属于哪一类。

---

## 附：invariant test suite（2026-09-05，三条层全部自动化通过）

**统一入口 `pnpm verify`**，任何对 parser / segmenter / reading state / sync / quiz 的改动都必须先过这三层：

| 层 | 命令 | 覆盖 | 状态 |
|----|------|------|------|
| Layer 1 纯逻辑 | `pnpm verify:readstate` | readRanges 合并/覆盖/迁移/推导数学模型 | 20/20 ✓ |
| Layer 2 持久化集成 | `pnpm verify:persistence` | db.ts 全链路：建库→导入→阅读→reload→normalize→重切分→快照 round-trip→级联删除（'idb' 用内存 shim，业务代码全真） | 25/25 ✓ |
| TD-03 契约 | `pnpm verify:quiz-leakage` | Quiz 全字段「只考已读」300 轮不变量 | 2709 项 ✓ |

Layer 2 曾抓到真实缺陷：loadAll 对**未合并/乱序**的存量 readRanges 直接信任，`isRangeCovered` 的提前返回语义会导致已读被误判为未读——已在 `normalizeProgress` 强制 `mergeReadRanges`（持久化边界不信任写入方的有序性）。

### 真 book GUI 纵切检查表（人工，待执行）

测试书选择：① 标准 EPUB（基准 happy path）；② 结构脏的 EPUB（短章/标题/列表/空段/频繁小节，压 segmenter 与标题映射）；③ 长篇连续文本或「其他」类型（压 fallback 与重切分）。PDF 不在当前 MVP 支持面内，不为类型丰富扩大测试面。

| 检查项 | 判定标准 |
|--------|---------|
| 重切分 coverage | 重切分前 = X%，重切分后仍为 X% |
| 已读 source nodes | 重切分前后**集合完全相同** |
| ReadingUnit 数量 | 允许变化（呈现层） |
| Feed 已读卡片数量 | 允许变化；**卡片覆盖的原文不变化**才是判定对象 |
| 已读徽标语义 | 新卡片若含 70% 已读 + 30% 未读，不显示「完全已读」是正确行为——不要把 ReadingUnit 的视觉连续性当成事实连续性 |
| Reader 已读样式/highlight | 对应同一原文位置 |
| Study 可用 KP | 纯 presentation re-segmentation 不应改变可用 KP 集合 |
| reload / sync round-trip | 上述一切保持一致（自动化的部分已由 Layer 2 覆盖，GUI 复核渲染层）

1. **重切分不变性** ✓ —— 边界变化后逐节点已读状态一致；新单元按覆盖关系正确判定已读/部分/未读。
2. **Feed/Reader 互认** ✓ —— 双向（feed 区间→reader 节点集合；reader 乱序节点上报→feed 单元已读），邻接区间合并无碎片。
3. **部分阅读** ✓ —— 只读 3/10 节点时单元不判已读、不进派生缓存；补完即翻转。
4. **旧数据迁移** ✓ —— readUnitIds→readRanges 不丢失、不扩大，幽灵 id 安全丢弃。
5. **跨章区间精度** ✓ —— 跨章单元须两章都覆盖；邻接合并 via/at 取较新者。
6. **TD-01 目标判定** ✓ —— `isRangeCovered` 已能直接表达 KP 范围级 eligibility。

**真书 GUI 纵切（导入 → 切分 → Feed 阅读 → Reader → 重开 → 重切分 → Study → 答题 → 跳回原文 → 同步恢复）仍需人工用 2–3 本结构差异大的真实书执行**，自动化脚本只覆盖纯逻辑层。
