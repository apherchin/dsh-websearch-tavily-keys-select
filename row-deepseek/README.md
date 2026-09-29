# dsh-search-deepseek

`dsh-websearch-tavily-keys-select` 的**官方搜索兜底行包**：Tavily 源全部失败或未配置时，交回官方 DeepSeek 搜索（**会花官方余额**）。

- **通常不需要单独安装**：它是 `dsh-websearch-tavily-keys-select` 的依赖。
- 关掉它可以省钱：侧栏 Plugins → 该包页面里「包含的组件」中的 `DS_OFFICIAL` 开关。
- host-only（没有 client 半边），按包名 re-export 宿主实现以共享同一模块实例。

License: MIT
