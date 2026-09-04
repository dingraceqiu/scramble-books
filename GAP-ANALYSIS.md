# Gap Analysis：原始产品构想 vs 当前代码

> 对照《私人智能阅读器｜产品原始构想与缺口检查稿》，对 `projects/` 下当前实现逐项核对。
> 核对时间：2026-09-05。所有行号以当前代码为准。

---

## 〇、六个「最容易从底层做错」的检查结论

| # | 问题 | 结论 |
|---|------|------|
| 1 | Feed 正文有没有被 AI 改写 | **没有**。`ReadingUnit.sourceText` 是 Canonical Source 节点的逐字拼接；AI 只产出 `ai.title`（`src/types.ts:111-135`） |
| 2 | Reading Unit 是不是固定长度机械切分 | **不是**。软阈值 10 段/1800 字、硬上限 22 段/3800 字、核心句驱动收束（`src/lib/segmenter.ts:24-88`） |
| 3 | Feed 和 Reader 有没有两套阅读状态 | **没有**。共用同一份 `progress[bookId].readUnitIds`，Reader 用 `unitAtNode` 双向映射单元↔节点区间（`src/components/ReaderView.tsx:91-110, 228-247`） |
| 4 | 是否存在稳定统一的 Canonical Source / Source Map | **存在**。`SourceDocument = Book → Chapter → SourceNode` 存 IndexedDB documents store，Reader 与切分器都引用它（`src/types.ts:71-105`，`src/lib/db.ts:312-321`） |
| 5 | Quiz 是否直接针对整本书随机出题 | **不适用**——Quiz 尚未实现，只有占位卡片（`src/components/Study.tsx:257-270`） |
| 6 | Mastery 是否被简化成总分 | **不适用**——Mastery 体系（Level 0–4、Knowledge Point）完全未实现 |

**总体判断：底层架构方向与原始构想一致，六个关键点没有做错。Feed 和 Reader 两大第一/第二优先级已基本成立；Quiz/Learning 是完整的空白（符合「第三优先级」现状）；另有若干 P1 级偏差需要修。**

---

## 一、已经完整实现

| 项目 | 代码位置 | 说明 |
|------|---------|------|
| APP 默认主入口是 Feed | `src/store/useStore.ts:131`（`view: 'feed'`）、`src/components/Shell.tsx`（第一个 Tab） | 打开即瀑布流，不是书架 |
| Feed 全部来自自己上传的书 | `src/store/useStore.ts:158-231`（ingest） | 无任何公共内容源 |
| Feed 正文 = 作者原文 | `src/lib/segmenter.ts:355-363`；卡片预览 `unit.preview` 为原文截断（`:238-244`） | AI 字段与原文严格分离（`src/types.ts:128-134`） |
| Semantic Reading Unit（非机械切分） | `src/lib/segmenter.ts:90-175` | 硬边界（章/标题/列表）+ 软硬阈值 + 核心句收束；碎片单元强制并入相邻单元（`:148-172`）；<120 字碎片不进 Feed（`:377`） |
| Reading Unit 来自连续原文 | `SourceRange`（`src/types.ts:99-105`），切分只做连续节点区间 | 无跨段拼接 |
| 标题小红书化 + 忠实度约束 | 本地：核心句提取 + 实词 grounded 校验（`src/lib/titleGen.ts:95-107, 470+`）；服务端 GLM prompt 铁律「claim 必须被原文支撑」（`server/routes/index.ts:131-141`） | 另存 `coreSentence`/`titleSupport` 作为标题依据（`src/types.ts:124-127`） |
| 标题展示来源信息 | `src/components/FeedCard.tsx:74-80`（书名 · 作者）、`:58-65`（编号、预计阅读时长） | |
| Feed → Reader 精确跳转 | `src/components/ReaderModal.tsx:147-168`「回到本书」→ `openBookReader(anchor=sourceStart)` | 定位到章节+节点并高亮闪烁（`ReaderView.tsx:170-191`） |
| 继续刷下一篇 | `src/store/useStore.ts:417-454`（nextUnit / nextUnitInBook）、`src/lib/recommender.ts:276-319`（pickNext） | 同书顺序 + 混合推荐双模式 |
| 收藏 | `Marks.favorites`（`src/types.ts:174-183`）、FeedCard 爱心、ReaderModal 收藏 | |
| 真正常规 Reader | `src/components/ReaderView.tsx`（全量）：连续滚动、目录、章节跳转、书签、全文搜索、字号/字体/行距/主题设置、位置记忆（`ReaderPosition`，`src/types.ts:243-250`） | Reader 中严禁出现 AI 内容（DESIGN.md 明确，代码遵守） |
| 划线 / 笔记（Reader 内） | `ReaderView.tsx:250-333`：四色划线、笔记弹层、段落内 mark 包裹（`:341-398`） | 均绑定 `chapterId + nodeIndex` |
| Feed 与 Reader 共用 Reading State | Reader 已读节点集合由已读单元映射而来（`ReaderView.tsx:91-110`）；Reader 内滚动经 IntersectionObserver 反向 markRead（`:228-247`）；Feed 卡片显示已读徽标（`FeedCard.tsx:48-51`） | 双向打通 ✅ |
| 阅读覆盖率（基础版） | `coverageOf`（`src/store/useStore.ts:598-608`，书库展示 `Library.tsx:151`）；Reader 内按节点数的 `overallPct`（`ReaderView.tsx:123-131`）；目录每章百分比进度条（`ReaderView.tsx:454-503`） | 热力图扩展的雏形已在 |
| 推荐信号 | `src/lib/recommender.ts`：少推荐、收藏、阅读活跃、类型亲和、确定性伪随机、多样性重排 | 显式+行为信号均有 |
| 小说防剧透顺序追更 | `segmentFiction`（一章一单元）+ `nextFictionEpisode` 硬顺序解锁（`recommender.ts:163-169`） | 构想外合理增强 |
| 隐私私有架构 | IndexedDB 本地为主（`src/lib/db.ts`）；账号仅用于整库快照同步（`src/lib/sync.ts`） | 无社交/分享/评论 |

---

## 二、已经实现，但与原始产品意图有偏差

### 2.1 「多推荐这个主题」没有 UI 入口 —— P1
- **位置**：`src/components/FeedCard.tsx:83-111`（只有 EyeOff 少推荐 + Heart 收藏）；`src/store/useStore.ts:526-549` 的 `feedback(dir: 1|-1)` 已支持 +1，但没有任何组件传 `1`。
- **差异**：构想第二十七节明确列了「多推荐这个」信号；DESIGN.md 是有意精简成两个操作。
- **建议**：保留精简版面也可以，但至少在 ReaderModal 里给「多推荐」入口（不占卡片空间）。**不需要架构返工。**

### 2.2 「已读」的判定语义 = 「打开过」，不是「读过」 —— P1
- **位置**：Feed 打开单元即 markRead（`useStore.ts:411-414`，openReader 内立即调用）；Reader 内是看到即算（IntersectionObserver，`ReaderView.tsx:242`，进入视口 10% 即记）。
- **差异**：构想第十五/二十节期望 Reading State 反映「实际阅读过的 Source Range」。当前粒度是「单元被打开/进入视口」，没有阅读时长或完成度校验。
- **建议**：短期可接受（Exposure 本来就是「看过」）；中长期在单元弹层加「滚到底部才 markRead」或最低停留时长。**不需要架构返工，只是判定函数改动。**

### 2.3 GLM 标题在每次刷新时会被本地 mock 覆盖再重新生成 —— P1（实 bug）
- **位置**：`src/lib/db.ts:130-154`：`isLatest = generator === TITLE_GENERATOR && !!coreSentence`，而 `TITLE_GENERATOR = 'mock-lang-aware-v5'`（`titleGen.ts:318`）。GLM 回写时 generator 是模型名（`aiTitles.ts:70`）且不更新 `coreSentence` 之外的依据字段，于是 hydrate 时被判为「过期」，用本地 mock 重新生成标题；随后 `upgradeAiTitles`（`useStore.ts:389-409`，App 启动调用）又把 mock 重新送 GLM。
- **后果**：每次刷新所有标题经历「GLM→mock→GLM」翻转：标题闪变、浪费 API 调用、`generator` 语义失真。
- **建议**：给标题加「生成代际」判断：GLM generator 一律视为最新（或记录 `titleSource: 'glm' | 'mock'`），只有 mock 且生成器版本落后才重算。**不需要架构返工，改 loadAll 的判定即可。**

### 2.4 GLM 标题没有本地忠实度后校验 —— P1
- **位置**：`server/routes/index.ts:143-149`：GLM 返回的标题直接 trim/slice 入库；本地 `isGrounded` 实词校验（`titleGen.ts`）只作用于 mock 候选。`coreSentence/titleSupport` 在 GLM 替换标题后仍是 mock 的依据（GLM 标题可能依据了别的句子）。
- **差异**：构想第十节「标题不能增强作者没有表达过的 Claim」——prompt 有约束但没有代码级兜底。
- **建议**：GLM 标题回写前跑一遍宽松版 grounded 校验（关键实词命中率阈值），不过关就保留 mock 标题；GLM 同时返回 `support` 句更新 titleSupport。**不需要架构返工。**

### 2.5 Feed 弹层里划的线/写的笔记没有 Source Range —— P1
- **位置**：`ReaderModal.tsx:112-118`（`addHighlight(unit.id, sel.text)`，无 opts）与 `:263-266`（`addNote(unit.id, noteDraft)`，无 opts）。对比 Reader 内的调用都带 `chapterId/nodeIndex`（`ReaderView.tsx:277-305`）。
- **后果**：在 Feed 弹层产生的划线/笔记 `chapterId/nodeIndex` 为空，Reader 里不渲染（`marksByNode` 依赖这两个字段，`ReaderView.tsx:341-351`），Study 页跳回原文也只能落到 null anchor。
- **建议**：Feed 弹层的段落本来就来自 `unit.sourceStart` 区间，按段落序号映射回节点下标即可补上 Source Range。**不需要架构返工。**

### 2.6 阅读覆盖率有两套口径 —— P2
- **位置**：书库/弹层用「已读单元数/总单元数」（`coverageOf`、`ReaderModal.tsx:83`）；Reader 顶栏用「已读节点数/总节点数」（`ReaderView.tsx:123-131`）。两者数字会不一致。
- **差异**：构想第十四/二十二节的 Reading Coverage 期望最终是「段落级 Source Range 覆盖率」。
- **建议**：统一到一个函数（建议以节点区间并集为准），UI 各处复用。**不需要架构返工。**

### 2.7 划线的定位粒度是「节点级」不是「字符偏移级」 —— P2
- **位置**：`Highlight` 只有 `chapterId + nodeIndex`（`src/types.ts:145-157`），回显靠文本匹配包裹（`ReaderView.tsx:354-398`）。
- **差异**：构想第九节要求随时回到原书上下文——节点级已够用；但同段多次部分划线、跨段划线无法精确表达。
- **建议**：后续在 SourceNode 内加字符偏移（startOffset/endOffset）。**小改，不返工。**

### 2.8 语言切换不影响已生成的标题前缀/标题语言 —— P2
- **位置**：小说「第X篇/Ep.N」前缀在切分时按当时界面语言固化（`segmenter.ts:279-282`、`db.ts:141-144`）；mock 标题语言也在生成时固化。
- **建议**：低优先级，接受现状或重切时重算。**不返工。**

---

## 三、部分实现

### 3.1 Reading State 粒度是「单元级」，不是构想要求的「段落级 Source Range」 —— P1（架构性，但可渐进）
- **位置**：`ReadingProgress.readUnitIds: string[]`（`src/types.ts:137-142`）。
- **现状**：Feed 已读 ↔ Reader 已读的互通完全建立在「单元」这个中介上。Reader 是通过 `unitAtNode` 把节点可见性翻译成单元已读。
- **两个具体缺口**：
  1. **类型为「其他」的书（不进 Feed 切分）没有任何 ReadingUnit，在 Reader 里读完全书，阅读状态永远是 0%**（IntersectionObserver 找不到单元 → 永不 markRead；`coverageOf` 分母为 0）。这是真实功能缺口，见 `useStore.ts:598-608` 与 `ReaderView.tsx:228-247`。
  2. 段落级热力图（构想第十五节：哪些段落 Feed 看过/Reader 看过/划过线）目前只能到单元级 + 划线/笔记节点级。
- **建议**：把 Reading State 升级为「已读区间集合」：`readRanges: Array<{chapterId, startNode, endNode, via: 'feed'|'reader', at: number}>`，单元已读可以作为派生视图保留兼容。这一步是**准架构返工**（迁移 progress store + 同步快照版本），但它是未来热力图、Coverage 精确化、Quiz「只考已读」的共同地基，建议在 Quiz 动工之前做。
- **过渡方案**：给「其他」类书籍在 Reader 里按章生成隐式单元（或直接按章 markRead），先堵住 0% 的洞。

### 3.2 章节覆盖率 → 热力图 —— P2
- **现状**：目录里每章有百分比进度条（`ReaderView.tsx:454-503`），已经是「章节级热力」；但没有段落级已读/Feed 来源/划线分布的可视化。
- **建议**：依赖 3.1 的区间化 Reading State 之后做。

### 3.3 格式支持：EPUB + TXT，无 PDF —— P2
- **位置**：`src/lib/parsers/`（仅 epub.ts / txt.ts），`Book.format: 'epub' | 'txt'`（`types.ts:48`）。
- **差异**：构想第一节列 PDF 为「后续其他格式」，当前未实现，符合预期节奏。

### 3.4 Feed 模式：只有 For You —— P2
- **现状**：一个混合瀑布流（all/unread/read/favorites 筛选 + 搜索 + 换一批）。构想第二十五节的 Continue / Surprise Me / Deep Dive 均未做。
- **评估**：Continue 已部分隐含（追更小说置顶、Study 页「在读的书」）；Surprise Me 可用现有 `unitNoise` 提高探索权重低成本实现；Deep Dive 依赖主题/知识点体系，后置合理。**不返工。**

---

## 四、尚未实现（Quiz / Learning 整个子系统）

构想第十七至二十二、二十八节对应的全部能力当前为空白，`Study.tsx:257-270` 只有一个「敬请期待」占位卡：

| 缺失项 | 说明 | 优先级 |
|--------|------|--------|
| Knowledge Point 抽取（含 Source Evidence 绑定） | 无任何数据模型。需新增 `KnowledgePoint { id, bookId, sourceRange, text, topics[] }`，且**只能从已读区间抽取**（构想第二十节硬规则） | P1（Quiz 动工时） |
| Level 0 Exposure | 部分：Reading State 即 Exposure，但没有被学习系统消费 | P1 |
| Level 1 Recall / Level 2 Understanding / Level 3 Transfer | 完全未实现；Level 2/3 需要 LLM 出题服务端（可复用 `server/lib/glm.ts` 的模式） | P1→P2 |
| Level 4 Compare / Integrate | 未实现，需要跨书 KP 索引；架构上只需 KP 不绑定单书即可预留 | P2（预留即可） |
| 分层 Mastery 记录 / Quiz Attempt 保存 | 无模型、无存储（IndexedDB 需新增 stores，CloudSnapshot 需升版本） | P1（随 Quiz） |
| 题目 → 原文回跳 | 无（但 `ReaderAnchor` 基建已就绪，KP 带 sourceRange 即可接上） | P1（随 Quiz） |
| Coverage 与 Mastery 分离展示 | Coverage 已有，Mastery 无 | P1（随 Quiz） |
| 划线/笔记反哺 Quiz 选题（构想第十六节） | 无，但 Highlight/Note 已带 sourceRange，数据链路是通的 | P2 |
| Mastery 反哺 Feed（遗忘重推） | 无；recommender 已有「已读降权 -30」的入口，可加「已读但 Mastery 低/久未复习」的加权项 | P2 |

---

## 五、结论与下一阶段建议

**不需要推倒任何底层**。四套底层状态里，Canonical Source（✅）与统一 Reading State（✅，粒度待升级）都已从正确方向建立；Recommendation（✅ 基础版）；Knowledge Map（空白）。

建议顺序：

1. **P1 修复（不返工）**：2.3 标题代际 bug → 2.5 Feed 弹层划线补 Source Range → 2.4 GLM 标题后校验 → 2.1 多推荐入口 → 2.2 已读判定。
2. **P1 架构小手术**：3.1 Reading State 区间化（先堵「其他」类书籍 0% 的洞，再迁移到 readRanges），这是 Quiz 的前置地基。
3. **P1 新子系统**：Quiz/Learning——先做 Level 0/1（从已读单元抽 KP + Recall 选择题），Level 2/3 随后，Level 4 只留数据口。
4. **P2**：Coverage 口径统一、段落热力图、Surprise Me、PDF。
