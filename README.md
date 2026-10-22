# dsh-web-search-chain（正本）

DSH 的 Web 搜索链路：`元宝搜索（腾讯云 SearchPro，带额度闸门）/ Tavily（0~3 个源）→ 官方 DeepSeek 搜索兜底`，
并在侧栏 Plugins 的本包页面提供配置卡片（**Windows 环境变量 / 明文**两种密钥来源）。
**面向用户的说明见 [`bundle/README.md`](bundle/README.md)**（含额度/计费/查额度与控额度的完整说明）；本文件只写开发侧约定。

## 三个 npm 包（一个仓库）

| 目录 | 包名（发布用） | 角色 |
|---|---|---|
| `bundle/` | **`dsh-websearch-tavily-keys-select`** | **安装入口**：`dsh.bundle.patch` + 宿主实现（`host/`，已自包含在包内） |
| `row-chain/` | `dsh-search-chain` | 链本体行包：按**包名** re-export 宿主实现 + 配置卡片 `client.js` |
| `row-deepseek/` | `dsh-search-deepseek` | 官方兜底行包：同样按包名 re-export 宿主实现（host-only） |

- bundle 的 `cordis.patch.yml` 只插**两行**，`name:` 分别是上面两个**行包名**；两行都 re-export 同一个模块 ⇒ **一个模块实例 = 一份源注册表**。
- bundle ↔ 行包互相声明依赖（bundle 依赖行包以安装它们；行包依赖 bundle 以解析裸包名导入）。**只有依赖图成环，运行时不成环**（宿主实现不 import 行包）。

## 宿主实现（`bundle/host/`）

| 文件 | 职责 |
|---|---|
| `core.mjs` | 纯逻辑：文档形状/提交校验/腿序/凭据回收 + **额度算术（北京时间月、promo 到期、usage 账本）** |
| `config-store.mjs` | I/O：配置文档 + 用量文档的读（绝不抛）与原子写 |
| `tencent-sign.mjs` | 腾讯云 **TC3-HMAC-SHA256** 签名（零依赖、纯函数） |
| `index-v5.mjs` | 运行时接线：注册 provider、Tavily/元宝两条腿、额度闸门、配置路由 |

## 正本 ↔ 生成物（⚠️ 两套布局）

- **正本 = 本目录**（进 git）。
- **生成物 = profile 的 node_modules 副本**，有两套名字，`sync-to-profile.mjs` 都支持：

| 布局 | bundle 目录 | 用途 |
|---|---|---|
| `live`（默认） | `dsh-web-search-chain`（旧名） | **本机 profile 实际部署的形态**：宿主实现摊平在包根（`main: index-v5.mjs`），`client.js` 里的 `ENTRY_KEY` 由脚本**受控改名**成同名 |
| `npm` | `dsh-websearch-tavily-keys-select` | 发布形态：`host/` 子目录 + 发布用包名 |

> 为什么不能统一：本机 profile 的 `package.json`、`dsh.profile.bundles` 与 bundle 自己的 patch **全指向旧名**，
> 改名会让包解析不到 ⇒ 整机起不来。所以 live 布局不写 `package.json`（两形态的包名/依赖本来就不同）。

```powershell
node sync-to-profile.mjs            # 等同 --dry-run（live 布局，只列差异）
node sync-to-profile.mjs --check    # 一致性自检（期望「一致：N/N」，退出码 0）
node sync-to-profile.mjs --apply    # 写入并回读校验 sha256（需要提权，profile 不在文件围栏内）
node sync-to-profile.mjs --npm-check  # 只看发布布局的差异
```

## 运行期文件

| 路径 | 作用 |
|---|---|
| `$DSH_HOME\web-search-chain.json` | 源列表（唯一真源），链路每次搜索重读；损坏/超 64KB 时按默认值工作 |
| `$DSH_HOME\web-search-chain-usage.json` | **本地额度账本**（按北京时间 `YYYY-MM`，只留本月+上月） |
| `$DSH_HOME\.credentials.yaml` | 明文密钥（DSH 凭据域；`refs` 段，引用名 `WEB_SEARCH_TAVILY_<n>`） |
| `$DSH_HOME\web-search-chain.log` | 审计：哪条源服务了、何时走官方兜底、何时因额度被跳过 |

## 元宝搜索的额度设计（2026-10-22）

用户口径（已写进代码默认值）：日常 **2000 次/自然月/UIN**；限时活动（**2026-10-10 ~ 2026-11-30 北京时间**，需邀请码）**6000 次**，
结束后自动恢复 2000；**标准版超额 20 元/千次 = DS 搜索 API 的约 4 倍**。

- `budget = { monthly, reserve, promo?: {monthly, until} }`：生效额度 = 活动期内 `promo.monthly`，否则 `monthly`；
  可用 = `monthly − reserve`，**已用 ≥ 可用即跳过该腿**（`quota-exhausted`）。
- 计数在**发请求之前** +1（失败/超时也算），且取 `max(文件, 进程缓存)` ⇒ 写盘失败也不会把闸门放开。
- 腾讯云**没有查配额 API**（API 概览只有 `SearchPro`）⇒ 本地账本 + 卡片手动校准 + 控制台/账单核对。

## 测试（逐文件跑，本机 `node --test` 必失败——沙箱禁命名管道）

```powershell
node test\run-all.mjs          # 全部 *.test.mjs（进程内汇总；当前 9 文件 / 143 条）
node test\verify-client.mjs    # 客户端验证台（vm + 假 react/jsx + 合规守卫 + 注册 key 动态比对；71/71）
node test\make-mutants.mjs     # 变异测试：10 个变异必须全部被杀
```

## 发布

```powershell
# 三个包分别发布（先 row 后 bundle，保证依赖已在线）
cd row-chain     ; npm publish --auth-type=web
cd ../row-deepseek ; npm publish --auth-type=web
cd ../bundle     ; npm publish --auth-type=web
```

## 验收

改任何文件后：`--check` 一致 → `--apply` 同步 → **整机重启 DSH**（打包版没有「刷新页面」）→
侧栏 Plugins → 本包包页看卡片（元宝源应显示 SecretId、额度、本月已用）。

改动记录见 `work\websearch-plugin-20260929\profile-patch-diff.md`（profile 补丁那次改动），
元宝通道的实施与验证见 `reports\dsh-websearch-元宝搜索通道-20261022.md`。
