# dsh-web-search-chain（正本）

DSH 的 Web 搜索链路：`Tavily（0~3 个源）→ 官方 DeepSeek 搜索兜底`，并在侧栏 Plugins 的
`dsh-web-search-chain` 包页提供配置卡片（**环境变量 / 明文**两种密钥来源）。

## 正本 ↔ 生成物

- **正本 = 本目录**（进 git）。
- **生成物 = profile 的 node_modules 副本**：
  - `bundle\*` + `host\*` → `~\.dsh\profiles\desktop\node_modules\dsh-web-search-chain\`
  - `row-chain\*` → `…\dsh-search-chain\`
  - `row-deepseek\*` → `…\dsh-search-deepseek\`
- **唯一写入通道**：`node sync-to-profile.mjs --apply`（需要提权，profile 不在文件围栏内）。
  收工自检：`node sync-to-profile.mjs --check`（期望 `一致：N/N`，退出码 0）。

## 运行期文件

| 路径 | 作用 |
|---|---|
| `$DSH_HOME\web-search-chain.json` | 源列表（唯一真源），链路每次搜索重读；损坏/超 64KB 时按默认值工作 |
| `$DSH_HOME\.credentials.yaml` | 明文密钥（DSH 凭据域；`refs` 段，引用名 `WEB_SEARCH_TAVILY_<n>`） |
| `$DSH_HOME\web-search-chain.log` | 审计：哪条源服务了、何时走了官方兜底 |

## 测试（逐文件跑，本机 `node --test` 必失败——沙箱禁命名管道）

```powershell
node test\run-all.mjs          # 全部 *.test.mjs（进程内汇总）
node test\verify-client.mjs    # 客户端验证台（vm + 假 react/jsx + 合规守卫）
node test\make-mutants.mjs     # 变异测试：4 个变异必须全部被杀
```

## 验收

改任何文件后：`--check` 一致 → `--apply` 同步 → **整机重启 DSH**（打包版没有「刷新页面」）→
侧栏 Plugins → `dsh-web-search-chain` 包页看卡片。

改动记录见 `work\websearch-plugin-20260929\profile-patch-diff.md`（profile 补丁那次改动），
完整实施与验证见 `reports\dsh-websearch-配置界面-实施与验证.md`。
