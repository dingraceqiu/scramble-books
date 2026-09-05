# HANDOFF · Scrollbook（刷书）项目交接包

> 生成于 2026-09-05。用途：把项目现状完整交给下一位协作者（或另一个 AI 会话），并作为「下一步开发什么」讨论的基线。
> 配套文档：`AGENTS.md`（架构约定）、`GAP-ANALYSIS.md`（构想 vs 实现逐项核对）、`TECH-DEBT.md`（技术债留档）、`DESIGN.md`（视觉规范）。

---

## 一、这是什么产品

**Scrollbook（刷书）**——私人智能阅读器。用户上传自己的 EPUB/TXT，前端解析为 `Book → Chapter → SourceNode` 的**规范原文（Canonical Source）**，按语义近似切分为**阅读单元（Reading Unit）**，以「小红书式图文卡片瀑布流」呈现（Feed 即发现入口）；同时提供完整的**连续阅读器（Reader）**；学习页（Study）从已读内容抽知识点、出复习题。

- 默认**纯本地**：数据存浏览器 IndexedDB，无后端依赖。
- 可选**云端模式**：邀请制注册，登录后整库快照同步到服务器 SQLite（node:sqlite），多端恢复。
- 中英双语（i18next，zh-CN / en，RTL 架构预留）。
- AI 能力走智谱 GLM（OpenAI 兼容接口，环境变量 `GLM_API_KEY`，模型默认 `glm-4-flash-250414`）；**未配置密钥时全链路自动降级**（规则分类 / 本地 mock 标题），绝不阻塞主流程。

## 二、架构铁律（先读这个再写代码）

**Source 是事实层；ReadingUnit 是呈现层；Knowledge Point 是学习层。所有上层对象必须能一路追溯回原文。**

- `ReadingUnit.sourceText` 是 SourceNode 的逐字拼接，**原文不可变**；AI 只产出标题与学习层字段，两者严格分离。
- **Reader 里严禁出现任何 AI 内容**（DESIGN.md 明确，代码遵守）。
- **阅读状态事实层是 `readRanges`**（chapterId + 节点闭区间 + via: 'feed'|'reader' + at）；`readUnitIds` 只是由它推导的呈现层缓存，禁止单独写入。Feed 已读、Reader 已读、覆盖率、Quiz 出题范围全部从 readRanges 推导（纯函数集中在 `src/lib/readState.ts`）。
- **Quiz 只考已读**：KP 只能从已读 Source Range 抽取；题干、正确答案、干扰项、解释、evidence 全部必须来自已读区域（代码内强制，见第五节）。
- ** Mastery 由 QuizAttempt 推导（masteryByLevel），绝不存单一总分**；未测量（attempts=0）与「测过全错」区分显示。
- 重切分语义分两类：presentation re-segmentation（`setBookType`，保留 readRanges）vs source re-parsing（必须先做坐标迁移，见 TD-05），禁止混用。

## 三、已完成（按模块）

| 模块 | 状态 | 说明 |
|------|------|------|
| 解析 | ✅ | EPUB（jszip + DOMParser，nav/spine 顺序）+ TXT（自写正则）；前置非正文检测（frontmatter）；无 PDF |
| Feed | ✅ | 两列瀑布流（桌面 3/4 列）、无限滚动、筛选（全部/未读/已读/收藏）、搜索、换一批；卡片=AI 标题封面 + 原文预览；爱心收藏 / 不感兴趣；已读徽标；小说防剧透顺序追更 |
| Reader | ✅ | 连续滚动、目录+章节进度条、书签、四色划线、笔记、全文搜索、字号/字体/行距/三主题、位置记忆；Feed→Reader 精确跳转（锚点+高亮闪烁） |
| Feed↔Reader 状态互通 | ✅ | 双向：Feed 读过的区间 Reader 里显示已读；Reader 里读过的节点 Feed 卡片标记已读（readRanges 统一推导） |
| 推荐 | ✅ v2 | 显式信号（收藏/少推荐/多推荐）+ 行为信号（阅读活跃、书级收藏热度、近 14 天类型亲和）+ 确定性种子 + 多样性重排 |
| 学习层 MVP | ✅ | Level 0 Exposure（=Reading State）→ Level 1 Recall 选择题闭环：知识点抽取（GLM/本地双路）、答题、Mastery 按层推导、题目回跳原文；划线回顾 + 笔记汇总页 |
| 账号与云同步 | ✅ | 邀请制注册（bcryptjs + token 会话 30 天）、整库快照 last-write-wins、防替换回推 pushGate、登出时保留/清空本地 |
| i18n | ✅ | zh-CN / en，界面语言切换 |
| GLM 接入 | ✅ | 书籍类型裁决兜底、AI 标题生成（忠实度后校验）、知识点抽取；全部可降级 |
| 部署 | ✅ | Express 单进程（dev: Vite middleware 端口 5000；prod: 静态 + API），支持子路径部署；PWA manifest 已就位 |

## 四、验证体系（当前全绿，改代码必须先跑）

统一入口 **`pnpm verify`**（三层）：

| 层 | 命令 | 覆盖 | 结果 |
|----|------|------|------|
| Layer 1 纯逻辑 | `pnpm verify:readstate` | readRanges 合并/覆盖/迁移/推导数学模型 | 20/20 ✓ |
| Layer 2 持久化集成 | `pnpm verify:persistence` | db.ts 全链路（建库→导入→阅读→reload→重切分→快照 round-trip→级联删除），内存 IndexedDB shim，业务代码全真 | 25/25 ✓ |
| TD-03 契约 | `pnpm verify:quiz-leakage` | Quiz 全字段「只考已读」300 轮不变量 | 2709 项 ✓ |

另有 `pnpm validate`（tsc strict + eslint + stylelint）：**tsc 与 eslint 当前干净**；stylelint 在 `src/index.css` 上有 **47 个历史遗留报错**（keyframes 命名、alpha 写法等风格规则与手写设计 CSS 冲突），不影响功能，属低优先清理项。

⚠️ 环境注意：本项目由扣子编程 CLI 容器创建（`.coze` 钉 Node 24）。在 **Node 26 本机**上曾出现两层工具链问题并已修复（见第五节）：tsx/esbuild 不再自动把含 top-level await 的 .ts 按 ESM 处理，且异步 loader hooks 拦不到 CJS require 链。若未来在新机器上 `pnpm verify` 报「top-level await / indexedDB is not defined」，先 `pnpm install` 再跑，不要回退 `scripts/test-shims/register.mjs` 的双模式注册。

## 五、交接前这一轮做了什么（未提交，建议尽快 commit）

上一轮会话的成果（已通过验证但未 commit）+ 本次交接时的修复：

**上一轮遗留（未提交）**
- `src/lib/knowledge.ts`：新增 `isKpEligible`（KP.sourceRanges ⊆ readRanges），`buildRecallQuestion` 强制校验题干与全部干扰项——「只考已读」从上游假设升级为代码内强制。
- `src/components/Study.tsx`：出题路径传入真实 readRanges 上下文。
- `src/lib/db.ts`：`normalizeProgress` 强制 `mergeReadRanges`（不信任写入方有序性，防已读误判未读）。
- 新增 `scripts/verify-persistence.ts`、`scripts/verify-quiz-leakage.ts`、`scripts/test-shims/`（内存 idb / i18n shim）及 package.json 的 verify 脚本。
- `AGENTS.md` / `TECH-DEBT.md`：补记 normalizeProgress、重切分语义分离、TD-03 状态升级、invariant suite。

**本次交接修复（原状跑不起来，现在全绿）**
1. `src/components/Study.tsx`：QuizSection 缺 `progressMap` selector（上轮改动引入的 TS 编译错误），已补。
2. `src/lib/knowledge.ts`：删掉未使用导入（eslint 报错）。
3. `scripts/test-shims/register.mjs`：改为双模式——Node 22.15+ 用同步 `registerHooks`（同时拦截 require 与 import），老 Node 回退原 `register()`。修复本机（Node 26）上 shim 失效导致真实 idb 被加载的问题。
4. `scripts/verify-persistence.ts`：底部 5 个 top-level await 包进 `main().then(...).catch(...)`（CJS 转换下不支持 TLA；同时保证汇总与退出码在用例完成后执行）。

## 六、已知差距（GAP-ANALYSIS 摘要，详见原文）

**六问自查全部通过**：正文未被 AI 改写 ✓、切分非机械固定长度 ✓、Feed/Reader 单一阅读状态 ✓、Canonical Source 稳定 ✓（Quiz/Mastery 空白属第三优先级预期）。

**P1（不返工可修）**
- ~~标题代际 bug（GLM→mock→GLM 翻转）~~ 已修（commit 9520400）
- ~~Feed 弹层划线/笔记缺 Source Range~~ 已修（同上）
- ~~GLM 标题忠实度后校验~~ 已修（同上）
- 「已读」语义仍是「打开过/进入视口」，无时长或完成度校验（弹层已改「滚到底才 markRead」，Reader 仍是进入视口即算）

**架构性 / 待办**
- **TD-01**：KP 抽取门槛仍是「完全已读的 ReadingUnit」粒度；目标是直接按「KP.sourceRanges ⊆ readRanges」判定（`isRangeCovered` 已能表达，改造点明确，动工时先跑 `pnpm verify:quiz-leakage` 回归）。
- **TD-05**：readRanges 坐标（chapterId + nodeIndex）在「重新解析同一本书 / 解析器升级 / 只同步原文+坐标」场景下不保证稳定；做这些功能前必须先上内容指纹 + 章节稳定 id。
- 「其他」类型书籍（不进 Feed 切分）阅读覆盖率仍按节点集合上报，但无 ReadingUnit 可派生（GUI 纵切清单中待人工复核）。
- 覆盖率两套口径（书库按单元、Reader 顶栏按节点）待统一。
- 划线定位是节点级不是字符偏移级（同段多次部分划线无法精确表达）。
- Feed 只有 For You 模式（Continue / Surprise Me / Deep Dive 未做）；PDF 未支持。

## 七、下一步候选（按建议顺序，供与 ChatGPT 讨论取舍）

1. **先把第五节未提交改动 commit 掉**——这是已验证的全绿状态，别裸奔。
2. **真书 GUI 纵切人工验收**（TECH-DEBT 附表）：拿 2–3 本结构差异大的真实书（标准 EPUB / 脏结构 EPUB / 长文 TXT）走一遍「导入→切分→Feed→Reader→重开→重切分→Study→答题→跳回原文→同步恢复」，核对重切分前后已读节点集合不变。自动化已覆盖逻辑层，渲染层需人眼。
3. **TD-01 落地**：KP 抽取从「已读单元」改为「已读区间」直接判定——Quiz 质量与「只考已读」严格性的地基，改造点已写明，回归测试就位。
4. **Quiz/Learning 继续往上层走**：Level 2 Understanding / Level 3 Transfer（需 LLM 服务端出题，可复用 `server/lib/glm.ts` 模式）；Level 4 只预留数据口（KP 不绑单书）。配套：Mastery 展示与 Coverage 分离、attempts<2 不给 rate、近期作答加权（遗忘曲线）、Mastery 反哺 Feed 重推。
5. **P2 体验项**：覆盖率口径统一、段落级热力图（依赖 readRanges 可视化）、Feed 的 Surprise Me（低成本）、PDF 支持（触发 TD-05，先解决坐标稳定性）。

## 八、开发约定速查

- **包管理只许 pnpm**（preinstall 强制）；常用：`pnpm dev`（开发，端口 5000）/ `pnpm build` / `pnpm start` / `pnpm validate` / `pnpm verify`。
- TypeScript strict 心智：禁隐式 any / `as any`，catch 与 req/res 先收窄。
- 云端库文件 `data/cloud.db` 不入 git；管理员邀请码：服务首启自动生成 5 个并打印日志，之后 `pnpm invite [n]`（密钥在 `data/admin-key.txt` 或 `ADMIN_KEY`）。
- GLM：`GLM_API_KEY` / `GLM_MODEL` 环境变量；未配置自动降级，不阻塞。
- `@vitejs/plugin-react` 锁 v4（v6 与环境 esbuild 不兼容）。
- 关键代码入口：状态与业务动作 `src/store/useStore.ts`（835 行）；阅读状态纯函数 `src/lib/readState.ts`；切分 `src/lib/segmenter.ts`；学习层 `src/lib/knowledge.ts`；云同步 `src/lib/sync.ts`；GLM 客户端 `server/lib/glm.ts`。

## 九、仓库状态快照（2026-09-05）

- 分支 `main`（有 remote），最新 commit：`adfb270 短笔记完整可见即标记已读`（共 19 个 commit，全部为线性推进）。
- 代码量约 1.0 万行 TS/TSX（src + server，不含测试脚本与文档）。
- 未提交改动见第五节清单（7 个修改文件 + 3 个新增脚本/目录）。
