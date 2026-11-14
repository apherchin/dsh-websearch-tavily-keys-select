# 变更记录

## 3.2.0（2026-11-14）

**Tavily credits 按 key 分账 + 手动查额度校正。** 3.1.0 的抓取梯队消耗 Tavily Extract 额度但不记本地账本，卡片「本月已用」只统计 `web_search`，因此显示偏低。

### 新增

- `usage.json` 每 key 扩为 `{calls, credits, fetchUrls, fetchCredits, credits_correction}`；旧文档自动兼容（缺字段当 0）。
- **分两份记账**（各自按 key）：`credits` = `web_search` 成功响应的 `usage.credits`；`fetchUrls` = `web_fetch` 成功提取的 URL 次数，按官方口径折算 `fetchCredits`（basic 每 5 次成功 = 1 credit，advanced = 2；失败不记）。
- 卡片「本月已用」= 各 key 的 `credits + fetchCredits + credits_correction` 之和；每把 key 行另显示 `搜索 X · 抓取 Y · 校正 ±Z` 分项。
- **手动查额度才校正**：`POST queryUsage:[id]` 成功后只给**该 key** 写 `credits_correction = 上游 plan_usage − 本地(credits + fetchCredits)`（可为负/正）；两个原始记账字段永不改动，没查的 key 校正值保持 0。查询失败不写。自动路径（搜索/抓取/打开页面/保存）**一次 `/usage` 请求都不发**。
- 搜索与抓取共用一个 `mutateUsage()` 读-改-写助手（保留对方字段），避免并发写同一账本互相覆盖。
- `credits_correction` 不参与额度闸门（只影响显示）；闸门仍靠搜索 credits + 上游 432 切 key。

### 兼容

- v1 数字 / v2 `{calls,credits}` 账本自动读入，无需迁移。
- 3.1.0 的腿序、配置段、跨月恢复、`ENTRY_KEY` 均不变。
- 验证：宿主测试 11 文件全绿（新增 `credits-ledger.test.mjs` 10/10）、客户端验证台 74/74、变异、真机抓取记账与查额度校正。

## 3.1.0（2026-11-14）

**一个安装入口同时接管 `web_search` 与 `web_fetch`。** 原先 `web_fetch` 靠一个用绝对路径 `insert` 挂载的本地原型
提供（2026-11-14 已退役，归档于 `archive\retired-dsh-web-deepseek-api-20261114\`），换台机器就失效；本版把抓取梯队并入 bundle 宿主模块，随包发布。

### 新增

- 抓取梯队 `http-leg → tavily-extract → deepseek-fetch-api`：本地 HTTP（免费）→ [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)（basic 每 5 次成功 URL = 1 credit，失败不收费）→ DS 官方 Fetch API（0.005 元/成功次）。
- 抓取腿与搜索腿**共享** `$DSH_HOME\web-search-chain.json` 的 Tavily 源 / key / credits，不另立账本；
  某把 key 上游报「用满」（402/429/432 或额度文案）自动切下一把，两把都尽才落到 DS。
- DS 兜底只由 `fetch.dsFetchFallback` 开关控制，不做月度计数；设为 `false` 即彻底不走 DS。
- 「用满」记忆按**北京时间自然月**自动恢复（每月 1 号，东八区），不用改配置、不用重启；跨月写
  `tavily-extract-quota-reset` 审计行。
- 抓取审计独立写 `$DSH_HOME\web-fetch-chain.log`（与 `web-search-chain.log` 分文件）。
- 新增 `bundle/host/fetch-chain.mjs`（零 `@deepseek-ai/*` 静态依赖）；`apply` 同时注册
  `registerSearchProvider` 与 `registerFetchProvider(chain-fetch)`，`inject: ['web']` 与配置路由时序不变。

### 兼容 / 安装

- 一个命令装齐三个包：`dsh plugin --profile desktop add dsh-websearch-tavily-keys-select@3.1.0`。
- 搜索侧腿序、配置卡片、v2→v3 文档迁移全部不变；本次只新增 `fetch` 配置段（有默认值，旧配置可直接工作）。
- ⚠️ 启用抓取梯队还需把 profile 的 `web.fetchProvider` 指向 `chain-fetch`（本机切换是独立后续步骤，本版不改任何 profile 文件）。
- 验证：宿主测试 **10 文件全绿**（新增 `fetch-chain.test.mjs` 15/15）、客户端验证台、变异、`npm pack --dry-run` 含 `host/fetch-chain.mjs`。

## 3.0.0（2026-10-23）

**三级模型：源 → key → 额度。** 配置文档升到 `version: 3`（旧配置**自动迁移**，key id 沿用源 id）。

### 新增

- **一个源可以有多把 key**（每源最多 4 把）。腿序 = 源按文档顺序 × 源内 key 按顺序：
  key 额度用完自动换同源下一把；整个源的 key 都不可用才换下一个源（审计行 `source-exhausted`）。
- **每个 key 独立**：自己的额度（monthly / reserve / promo）、自己的 enable / disable / delete、
  自己的失败计数与「自动停用」（连续 3 次确定性失败），可单独「恢复」。
- **每个源一份计费方式**：`billing: { unit: "calls" | "credits", pricePer1000?: number }`，
  填了单价后卡片显示「本月 ≈ ¥X」。
- **账本按 key 记账**：`{"2026-10":{"k1":{"calls":3,"credits":5}}}`，每把 key 各有「查额度」（Tavily `GET /usage`）。
- **卡片改成"一个源一张卡"**：卡头有「＋ 加一把 key」「删除源」与源级汇总，卡内每把 key 一行。

### 变更

- 上限：4 个源、每源 4 把 key（原：4 个平铺源，一源一 key）。
- 「源」不再直接持有密钥与额度，这些下沉到 key；源只保留模板、计费方式、可选标签与源级停用。
- 官方兜底行保持不变（仍是 profile 补丁里的那一行开关）。

### 兼容

- v2 文档自动迁移：每个旧源 → 单 key 源，**key id 沿用源 id** ⇒ 本地账本与自动停用标记无缝续上。
- 兼容层同时接受 v2 形状的**提交**与**序列化输入**（`mode`/`ref`/`budget` 挂在源上），手写 JSON 不会直接失败。
- 测试：宿主 168/168、客户端验证台 70/70、变异 18/18。

## 2.0.0（2026-10-22）

- 加入腾讯元宝搜索（TC3 签名，`SearchPro`），带**本地月度额度闸门**（2000 次/月，活动期 6000）。
- query 意图解析：`site:` → `Site` 参数；`今天/昨天/本周/最近N天/月/年` → `Freshness`（官方语法 d1–30 / m1–12 / y1–5，超界夹到上限）。
- Tavily 按 **credit** 记账 + 「查额度」按钮；DeepSeek 搜索 API 作为兜底；源可停用 / 自动停用（3 次确定性失败）。
