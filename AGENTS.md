# 项目上下文

**Scrollbook（刷书）**——私人智能阅读器（scroll + book）。用户上传 EPUB/TXT，前端解析为 Book → Chapter → SourceNode 的 Canonical Source Map，按语义近似切分为 Reading Unit，生成 Mock AI 标题，以瀑布流 Feed 呈现；书库进入连续阅读 Reader。**默认纯本地模式**（数据存浏览器 IndexedDB）；登录后可选**云端模式**（数据同步到服务器 SQLite，多端不丢）。底部三入口：Feed（发现）/ 书库（读）/ 学习（Master，MVP3 Quiz 占位）。

## 技术栈

- **核心**: React 19, TypeScript, Vite 7, Express（开发容器 + API 服务）
- **状态**: zustand（含 persist）
- **本地存储**: IndexedDB（idb 库）
- **云端存储**: SQLite（node:sqlite，无 native 依赖）+ bcryptjs 密码哈希；库文件默认 `data/cloud.db`（生产 `/tmp/scrollbook-cloud.db`，可用 `CLOUD_DB_PATH` 覆盖），`data/` 不入 git
- **解析**: 自写正则（TXT）+ jszip + DOMParser（EPUB，nav.xhtml/spine 阅读顺序，无图片/CSS）
- **UI**: Tailwind CSS 3, lucide-react
- **注意**: `@vitejs/plugin-react` 锁定 v4（v6 与本环境 esbuild 不兼容）

## 目录结构

```
├── server/                  # Express 壳：vite.ts 集成 Vite 中间件（configFile:false，插件勿重复注册）
│   ├── lib/cloudDb.ts       # 云端 SQLite：users/sessions/invite_codes/user_data（整库快照 JSON blob）
│   ├── routes/auth.ts       # 注册/登录/登出/me（bcryptjs + Bearer token 会话）+ admin 邀请码接口
│   ├── routes/sync.ts       # GET/PUT/DELETE /api/sync（整库快照 last-write-wins，70MB body 上限）
│   └── scripts/invite.mjs   # 管理员命令行：pnpm invite [n] 生成邀请码、pnpm invite --list 查看
├── src/
│   ├── main.tsx             # React 入口
│   ├── App.tsx              # 启动序列：hydrate → 订阅同步 → restoreSession → 云端模式拉取（replaced 则 reload）
│   ├── types.ts             # 全部实体类型（含 CloudSnapshot/CloudUser/AppMode；AI 字段 ai* 与原文严格分离）
│   ├── store/useStore.ts    # zustand 状态 + IndexedDB 持久化 + 业务动作
│   ├── store/useAuth.ts     # 账号状态（mode: 'local'|'cloud'、user、token、syncStatus），token 存 localStorage
│   ├── store/useReaderPrefs.ts # 阅读偏好（persist：字号/字体/行距/主题、书签、滚动位置、划线颜色）
│   ├── components/AccountPanel.tsx # 右上角账号图标：登录/注册（邀请码）/个人信息/登出（询问保留或清空本地）
│   ├── lib/
│   │   ├── db.ts            # idb 封装；replaceAllData/clearAllData/getAllDocuments 供云端同步
│   │   ├── cloudApi.ts      # 前端 API client（register/login/logout/me/pull/push/clear，ApiError 带 status）
│   │   ├── sync.ts          # 同步引擎：pullCloudData（云端有→替换本地 reload；空→推本地）、schedulePush 防抖 1.5s、startSyncSubscriptions、pushGate 防替换回推
│   │   ├── parsers/         # txt.ts / epub.ts（产出 ParsedDocument）
│   │   ├── segmenter.ts     # 语义近似切分（章节边界 + 3-8 段 + 句末断点；切分前调 frontmatter）
│   │   ├── frontmatter.ts   # 前置非正文检测（版权页/目录/序言/扉页）；markFrontMatter 给 Chapter 打 frontMatter，bodyChapters 供 Feed 切分；Reader 仍展示全部章节
│   │   ├── titleGen.ts      # Mock 标题/标签/阅读时长（独立可替换为 LLM）
│   │   ├── recommender.ts   # 推荐打分（偏好/收藏/未读/新鲜度/多样性）
│   │   ├── sample.ts        # 内置示例书
│   │   └── utils.ts         # id/时间/中文阅读速度
│   ├── hooks/useTheme.ts    # 深/浅色调切换（documentElement.class）
│   └── components/
│       ├── Shell / Feed / FeedCard / ReaderModal(单篇弹层) / Library(含统计+划线笔记入口) / BookCover / Study(MVP3 占位)
│       ├── ReaderView.tsx   # 连续阅读页：设置/进度/书签/多色划线/搜索/位置记忆
│       └── reader/          # panels(Drawer) / SettingsPanel / SearchPanel / MarksPanels(书签) / MarksList(划线笔记列表)
└── vite.config.ts
```

## Reader 主题与样式约定（MVP2）

- 阅读页根容器 `.reader-surface[data-reader-theme='paper'|'carbon'|'eye']`，CSS 变量 `--reader-bg/ink/ink-soft/muted/line/read`；工具类 `.r-text/.r-muted/.r-line/.r-read/.r-bar-track` 均作用于该容器内。
- 正文字号/行距/字体由 JS 以 `--rfs/--rlh/--rff` 驱动（`.reader-article`）；字号档 FONT_SIZE_PX=[16,18,20,23]，行距 LINE_HEIGHT={compact:1.7,normal:1.95,loose:2.25}。
- 多色划线 `.hl-yellow/green/blue/pink`；搜索命中 `.r-search-hit`（闪烁动画）；长章节 `section{content-visibility:auto}`。
- 段落节点带 `id="reader-node-<chapterId>-<nodeIndex>"` 与 `data-chapter/data-node`，供跳转/观察器/划线定位；heading 额外带 `data-chapter-heading`。
- 阅读偏好（settings/bookmarks/positions）存 localStorage（zustand persist key `scrollbook-reader-prefs`），与正文数据（IndexedDB）分离。

## 关键设计约定

- **架构铁律（分层）**：**Source 是事实层（Book → Chapter → SourceNode / SourceRange）；ReadingUnit 是呈现层；Knowledge Point 是学习层。所有上层对象（Feed 单元、Highlight、Note、Reading State、Knowledge Point、Quiz、Mastery）都必须能一路追溯回 Source。** 任何新功能先检查这条链有没有断。
- **原文不可变**：ReadingUnit.sourceText 直接由 SourceNode 拼接；AI 内容仅标题与学习层抽取（concept/explanation，quote 必须逐字回溯原文），两者分离。
- **切分/标题模块独立**：segmenter、titleGen 均为纯函数模块，未来可替换为 AI 语义切分/真实 LLM。
- **阅读状态（readRanges 事实层）**：`ReadingProgress.readRanges`（chapterId + 节点闭区间 + via: 'feed'|'reader' + at）是「我读过哪些原文」的唯一事实来源；`readUnitIds` 只是由它推导的呈现层缓存，禁止单独写入。Feed（单元已读 = 区间被完全覆盖，`readState.isUnitRead`）、Reader（IntersectionObserver 上报 `markNodesRead`，按章合并区间）、覆盖率（唯一口径 `readState.coverageOfNodes` = 已读节点数/`book.nodeCount`，对切分不变，UI 经 `useStore.coverageOf` 消费）、Quiz 出题范围全部从 readRanges 推导；相关纯函数集中在 `src/lib/readState.ts`。旧数据（只有 readUnitIds）在 loadAll 的 `normalizeProgress` 自动迁移（存量区间一律 `mergeReadRanges` 后使用，不信任写入方有序性）。**重切分语义分两类**：presentation re-segmentation（`setBookType`，documents 不变）保留 readRanges；source re-parsing（重新解析原文）必须先做迁移（见 TECH-DEBT.md TD-05），禁止混用 `preserveReadRanges`。
- **学习层（Knowledge Point / Quiz / Mastery）**：抽取资格只由 readRanges 决定、不经过 ReadingUnit（TD-01 已落地）：`readRanges → subtractRanges → buildExtractionWindows → extractKnowledgePointsForBook → KP.sourceRanges → isKpEligible()`，同一 Canonical Source + 同一组 readRanges 下切分变化不得影响 KP 资格与出题范围（契约测试 `pnpm verify:kp-invariance`）；KP.sourceRanges 记录来源、quote 必须逐字存在于原文（否则该 KP 不出题）；题目是 KP 的测试方式（QuizQuestion），Mastery 一律由 QuizAttempt 推导（`masteryByLevel`），**绝不存单一总分**。Level 0=Exposure 由 Reading State 表达，1=Recall 已实现，2/3/4 数据模型已预留。云端快照 CloudSnapshot 可选携带 knowledgePoints/quizAttempts。
- **Reader 连续阅读**：`view:'reader'` + `readerBookId/readerAnchor/readerDoc`，章节原文懒加载自 documents store（`db.getDocument`）；`unitAtNode/lastReadUnit/findHighlightNode` 在 segmenter.ts 末尾，负责段落→单元归属、继续阅读定位、划线包裹。
- **划线/笔记**：HighLight/Note 按 unitId+bookId 关联并记录 chapterId+nodeIndex（Feed 弹层划选时由段落序号映射回 SourceNode 下标），Feed 弹层与 Reader 页共享同一套数据；Note 可选 text 字段存划选原文。
- **本地存储**：无后端 API；上传文件仅在浏览器内解析，不落服务器。

## 云端模式约定（可选，不影响本地模式）

- **未登录 = 纯本地**：不发任何账号/同步请求，IndexedDB 为唯一事实来源；所有云端逻辑入口先判 `useAuth.getState().mode === 'cloud'`。
- **邀请制**：注册必须携带未使用过的邀请码（`invite_codes` 表，事务内原子消费，一码一次）。管理员生成：服务首次启动自动生成 5 个并打印日志；之后 `pnpm invite [数量]` / `pnpm invite --list`，或 `POST/GET /api/admin/invites`（header `x-admin-key`，密钥见 `data/admin-key.txt` 或环境变量 `ADMIN_KEY`）。
- **会话**：登录返回 64 字符随机 token（sessions 表，30 天滑动续期），前端存 localStorage `scrollbook-cloud-token`；请求带 `Authorization: Bearer <token>`。
- **同步模型（MVP）**：整库快照 `CloudSnapshot`（books/documents/units/progress/highlights/notes/marks + readerPrefs 来自 localStorage persist 键）。登录后云端有数据→`db.replaceAllData` 替换本地并刷新页面（以云端为准）；云端空→推送本地数据迁移。之后业务 store 与阅读偏好的任何变更经 `startSyncSubscriptions` 订阅、防抖 1.5s 推送整库（last-write-wins）；`pushGate` 在替换本地期间临时关闭，避免替换动作触发回推。
- **登出**：询问「保留本地数据 / 清空本地数据」；清空走 `db.clearAllData` + 移除 readerPrefs 后刷新。
- **离线/失败**：网络错误不阻塞本地操作（数据已 write-through 到 IndexedDB），面板提示失败并提供「重试同步」。

## 工程流程规范（所有 Agent 必须遵守）

**目标**：功能正确、不丢用户数据、可测试、可理解、可修改、可回滚、不依赖单次聊天上下文。把项目当作持续开发数年的真实软件维护，但工程复杂度必须与当前真实复杂度匹配——禁止为了形式上的 Clean Architecture / SOLID 制造没有现实价值的 interface / repository / adapter / factory / wrapper。

### 复杂度原则

任何新的 abstraction、架构层、framework、dependency、middleware、infrastructure，引入前必须回答「它现在解决了什么已经存在的问题？」。仅为「未来可能需要」的默认不引入；出现真实的重复、耦合、测试困难或替换需求后再抽象。优先选择满足当前需求的最简单清晰方案。

### 项目阶段判定：当前为 Stage 2（Real Project）

依据：已长期开发、有真实用户数据（本地 IndexedDB + 云端 SQLite）、多 Agent 交替开发、已有 CI（GitHub Pages 部署）、契约测试与架构文档。

- **已具备**：Git、lint/format、契约测试、架构文档、.gitignore。
- **应逐步补强**：pre-commit hooks、核心业务逻辑（segmenter / readState / sync）单测与回归测试、secret scanning、更严格 type check。
- **暂不引入**（Stage 3 内容，除非出现真实需求）：E2E 全套、deployment pipeline、monitoring、backup、数据库 migration 体系。特别注意本项目同步模型是整库快照 last-write-wins，引入任何「迁移/备份」类机制前先确认现有快照模型确实不够用。

### Git 约定

Git 是事实来源：项目演化历史 + 回滚机制 + Agent 间协作记录。所有正式修改进入 Git，commit 保持单一逻辑变化，使用简化 Conventional Commits：

```text
feat: 新功能      fix: Bug 修复     refactor: 重构
test: 测试        docs: 文档        chore: 工程维护
perf: 性能优化
```

### 分支规则（开始任何非微小任务前先判断）

判断标准不是「改了多少行代码」，而是**修改失败后的恢复成本和影响范围**。不确定时优先开 Branch。

默认创建 Branch：新增完整功能、大规模重构、数据 Schema/Migration 修改、核心数据模型或状态管理修改、高风险模块（认证/同步/存储）修改、一次任务涉及多个核心模块、预计多个 Commit、实验性方案、技术方案未定、失败后难以快速人工恢复、可能影响已有稳定功能。

可直接在 main：文案、样式、README/文档、明确且低风险的小 Bug、局部且容易验证和撤销的修改。

流程：确认工作区状态 → 从稳定 main 创建语义明确的 Branch → 开发 → 运行适用测试 → 验证通过后合并回 main。命名：`feat/xxx`、`fix/xxx`、`refactor/xxx`、`experiment/xxx`。

> 本项目对应高风险模块：`server/lib/cloudDb.ts`、`server/routes/auth.ts`、`src/lib/sync.ts`、`src/lib/db.ts`、`src/store/useStore.ts`（readRanges 相关改动一律视为核心数据模型修改）。

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

- 使用 Tailwind CSS 进行样式开发

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、Express `req`/`res`、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。
