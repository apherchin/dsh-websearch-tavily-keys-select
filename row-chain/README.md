# dsh-search-chain

`dsh-websearch-tavily-keys-select` 的**链本体行包**：注册 `ctx.web` 的 `web_search` provider，并供应侧栏 Plugins 里那张配置卡片。

- **通常不需要单独安装**：`dsh plugin --profile <profile> add dsh-websearch-tavily-keys-select` 会把它作为依赖一并装上。
- 它按**包名** re-export 宿主实现（`export { name, inject, apply } from 'dsh-websearch-tavily-keys-select'`），
  这样两个行包共享**同一个模块实例**（= 同一份源注册表）。
- 浏览器半边 `client.js` 只 `require` `react` / `react/jsx-runtime`（官方 practices 禁止 require 任何 Harness Client 包 ⇒ 组件全部自包含）。

License: MIT
