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
- **将来破坏点**：TD-01 落地后「KP 集合 ⊆ 已读」不再自动成立（KP 可以来自部分已读单元），届时 `buildRecallQuestion` 的干扰项池必须先按 eligibility 过滤。建议届时在 `buildRecallQuestion` 加 eligibility 谓词参数，在函数内部强制。

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

---

## 附：纵切验证（2026-09-05 已执行，20/20 通过）

`pnpm verify:readstate`（`scripts/verify-reading-state.ts`，纯逻辑层）覆盖：

1. **重切分不变性** ✓ —— 边界变化后逐节点已读状态一致；新单元按覆盖关系正确判定已读/部分/未读。
2. **Feed/Reader 互认** ✓ —— 双向（feed 区间→reader 节点集合；reader 乱序节点上报→feed 单元已读），邻接区间合并无碎片。
3. **部分阅读** ✓ —— 只读 3/10 节点时单元不判已读、不进派生缓存；补完即翻转。
4. **旧数据迁移** ✓ —— readUnitIds→readRanges 不丢失、不扩大，幽灵 id 安全丢弃。
5. **跨章区间精度** ✓ —— 跨章单元须两章都覆盖；邻接合并 via/at 取较新者。
6. **TD-01 目标判定** ✓ —— `isRangeCovered` 已能直接表达 KP 范围级 eligibility。

**真书 GUI 纵切（导入 → 切分 → Feed 阅读 → Reader → 重开 → 重切分 → Study → 答题 → 跳回原文 → 同步恢复）仍需人工用 2–3 本结构差异大的真实书执行**，自动化脚本只覆盖纯逻辑层。
