# Cloud Snapshot V2

## 边界

V2 只改变客户端与服务器之间的 JSON wire/storage format。浏览器 IndexedDB、zustand store、Reader/Feed/Study 消费的 `ReadingUnit` 结构均不变；拉取后必须先 `deserializeCloudSnapshot()` 恢复完整本地结构，再进入 `db.replaceAllData()`。

Canonical Source 仍是 `Book → SourceDocument → Chapter → SourceNode`。V2 不重新解析文件、不改变 chapterId/nodeIndex，也不清空或重写现有云端数据。

## V1 → V2 差异

| 字段 | V2 策略 | 消费点审计与理由 |
|---|---|---|
| `sourceText` | 若从 `documents + sourceStart/sourceEnd + bookType` 重建后逐字相等则省略；否则保留 override | Feed 搜索、ReaderModal 正文/选区→nodeIndex 映射、阅读时长、AI 标题请求均直接消费；必须恢复为逐字相同字符串 |
| `preview` | 从 Source slice 的非 heading 节点使用原 `buildPreview` 规则重建并比对；不等则保留 | FeedCard 直接展示；属于派生缓存，但不能接受算法猜测 |
| `headingText` | 从起始 SourceNode/章节标题重建并比对；不等则保留，原值缺失用 `null` override | ReaderModal 判断首段 heading；`undefined` 与有标题语义不同 |
| `coreSentence` | 保留 | AI 标题请求把它作为 claim 证据；它属于生成当时的结果，生成器升级后重算可能变化 |
| `titleSupport` | 保留 | 当前 UI 消费较少，但它记录标题 claim 的原文支撑，是审计/可追溯数据，不应在 wire migration 中丢失 |
| `ai.title` | 保留 | Feed/Reader/Study 直接展示；可能来自 GLM，无法本地重建 |
| `ai.estimatedReadingMinutes` | 保留 | ReaderModal/FeedCard 直接展示；虽可由 sourceText 计算，体积收益小，不值得拆散 AI generation record |
| `ai.generator` | 保留 | hydrate 依据 generator 判断是否升级/覆盖标题，是防止 GLM 标题被 mock 反复覆盖的关键代际信息 |

`serializeCloudSnapshot()` 对每个单元独立推导并严格比较，因此正常数据获得瘦身，旧版异常、跨章特殊拼接和未来结构变化会自动降级为带 override 的无损 V2。`deserializeCloudSnapshot()` 如果既没有 override 又无法从 Canonical Source 恢复必需字段，会在写 IndexedDB 之前失败，禁止以空字符串静默覆盖本地数据。

## V1 兼容与升级顺序

1. GET 可返回 V1 或 V2。
2. V1 先原样反序列化；V2 先恢复完整 ReadingUnit。
3. 完整快照写入 IndexedDB，期间 `pushGate` 关闭回推。
4. 若来源是 V1，再把同一完整内存快照序列化为 V2 并 PUT 覆盖。升级 PUT 失败不会撤销已恢复的本地数据，后续正常 push 会重试 V2。
5. 新客户端永远 PUT V2；服务端继续接受 V1，避免旧客户端被硬切断。

## 可观测性与验证

- 开发环境每次 `buildSnapshot()` 后输出结构化 `snapshot-size` 日志：总 UTF-8 JSON bytes、10 个业务字段、最大书籍、Canonical Source 文本与 `units.sourceText` 重复体积。
- `pnpm diagnose:snapshot <snapshot.json>` 可分析 V1、V2 或 API `{ data }` JSON，打印 V1→V2 实际体积与缩小比例。
- `pnpm verify:cloud-snapshot` 覆盖 V1/V2 restore、V1→V2 migration、IndexedDB round-trip、progress 重切分、中英文、跨章、异常 override、大书库及体积阈值。

快照日志和诊断输出只包含大小、book id/title 与统计数字，不输出正文、笔记、账号或认证信息。

### 2026-09-08 生产 V1 实测基线

对服务器最新一份 V1 快照做只读、内存管道诊断（未落盘、未输出正文）：

| 口径 | bytes | MiB |
|---|---:|---:|
| V1 | 7,699,662 | 7.34 |
| V2 | 4,956,744 | 4.73 |
| 减少 | 2,742,918 | 2.62（35.62%） |

其中 Canonical Source 节点文本 2,426,066 bytes，V1 `units.sourceText` 2,109,942 bytes；经逐单元比对可安全省略 2,097,711 bytes。旧事故记录的「约 3.98MB」来自 JS 字符数而非 UTF-8 bytes，这也是服务端校验改用 `Buffer.byteLength` 的原因。
