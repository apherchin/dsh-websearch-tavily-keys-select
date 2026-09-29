# dsh-websearch-tavily-keys-select（正本）

DSH 的 Web 搜索链路：`Tavily（0~3 个源）→ 官方 DeepSeek 搜索兜底`，并在侧栏 Plugins 的本包页面提供配置卡片
（**Windows 环境变量 / 明文**两种密钥来源）。**面向用户的说明见 [`bundle/README.md`](bundle/README.md)
（含配置页截图）**；本文件只写开发侧约定。

## 三个 npm 包（一个仓库）

| 目录 | 包名 | 角色 |
|---|---|---|
| `bundle/` | **`dsh-websearch-tavily-keys-select`** | **安装入口**：`dsh.bundle.patch` + 宿主实现（`host/`，已自包含在包内） |
| `row-chain/` | `dsh-search-chain` | 链本体行包：按**包名** re-export 宿主实现 + 配置卡片 `client.js` |
| `row-deepseek/` | `dsh-search-deepseek` | 官方兜底行包：同样按包名 re-export 宿主实现（host-only） |

- bundle 的 `cordis.patch.yml` 只插**两行**，`name:` 分别是上面两个**行包名**；两行都 re-export 同一个模块 ⇒ **一个模块实例 = 一份源注册表**。
- bundle ↔ 行包互相声明依赖（bundle 依赖行包以安装它们；行包依赖 bundle 以解析裸包名导入）。**只有依赖图成环，运行时不成环**（宿主实现不 import 行包）。

## 正本 ↔ 生成物

- **正本 = 本目录**（进 git）。
- **生成物 = profile 的 node_modules 副本**：
  - `bundle\*` → `~\.dsh\profiles\desktop\node_modules\dsh-websearch-tavily-keys-select\`
  - `row-chain\*` → `…\dsh-search-chain\`
  - `row-deepseek\*` → `…\dsh-search-deepseek\`
- **唯一写入通道**：`node sync-to-profile.mjs --apply`（需要提权，profile 不在文件围栏内）。
  收工自检：`node sync-to-profile.mjs --check`（期望 `一致：N/N`，退出码 0）。

> ⚠️ **发布阻塞点（2026-09-29 修掉）**：行包原先用**相对路径** re-export（`from '../dsh-web-search-chain/index-v5.mjs'`）——
> 在 profile 的扁平 node_modules 里碰巧能解析，但 `dsh plugin` 用的是 **pnpm**（虚拟 store + 符号链接），
> 从 `.pnpm/dsh-search-chain@…/node_modules/dsh-search-chain/` 出发那个兄弟目录**不存在** ⇒ 装上去 import 失败。
> 现已改成**按包名** re-export，并在行包里声明 bundle 依赖（`test/manifest.test.mjs` 有守卫）。

## 运行期文件

| 路径 | 作用 |
|---|---|
| `$DSH_HOME\web-search-chain.json` | 源列表（唯一真源），链路每次搜索重读；损坏/超 64KB 时按默认值工作 |
| `$DSH_HOME\.credentials.yaml` | 明文密钥（DSH 凭据域；`refs` 段，引用名 `WEB_SEARCH_TAVILY_<n>`） |
| `$DSH_HOME\web-search-chain.log` | 审计：哪条源服务了、何时走了官方兜底 |

## 测试（逐文件跑，本机 `node --test` 必失败——沙箱禁命名管道）

```powershell
node test\run-all.mjs          # 全部 *.test.mjs（进程内汇总）
node test\verify-client.mjs    # 客户端验证台（vm + 假 react/jsx + 合规守卫 + 注册 key 动态比对）
node test\make-mutants.mjs     # 变异测试：5 个变异必须全部被杀
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
侧栏 Plugins → 本包包页看卡片。

改动记录见 `work\websearch-plugin-20260929\profile-patch-diff.md`（profile 补丁那次改动），
完整实施与验证见 `reports\dsh-websearch-配置界面-实施与验证.md`。
