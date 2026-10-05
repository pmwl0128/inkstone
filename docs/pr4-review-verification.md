# PR #4 审查核实与登录环境诊断

核实对象：[PR #4 上游回复](https://github.com/ZhenHuangLab/inkstone/pull/4#issuecomment-5910961397)，时间为 2026-09-30，审查基线为独立提交 `bacd655`。

## 代码结论

上游指出的冲突成立。`bacd655` 给共享 host 无条件设置最高 `z-index`、`isolation: isolate` 和 `position: fixed`。#2 的 `3a47bb6` 只降低按钮与面板到 40/41；同步后这两个子元素仍被包在最高层 host 中，无法排到 Claude 的页面浮层之下。

本分支已合入 #2 的最新修复。最高层 overlay 的 CSS 与内联设置均限定到 ChatGPT。Claude 保留原有的非定位 host，按钮与面板仍用 40/41。不能仅把 Claude host 改成 `z-index: auto`：`position: fixed` 本身也会建立层叠上下文。

## 自动验证范围

本次验证：`bun test` 188 pass / 0 fail；`bun run typecheck`、`bun run build` 及下述 Chromium 检查通过。

[check-ui-browser.mjs](../scripts/check-ui-browser.mjs) 使用实际构建的 userscript 和 Chromium，并拦截全部页面请求，验证：

- ChatGPT 的会话/新会话 × 聊天/工作四种合成 DOM，包含隐藏重复锚点与错误位置的 header，实际调用适配器选择锚点。
- 顶栏和输入框两种按钮位置、位置切换后的收起，以及 URL 切换后的收起。
- ChatGPT 按钮位于高层顶栏 surface 之上，页面 author CSS 不会覆盖关键 host 设置；浏览器原生 modal 位于 Inkstone 之上。
- Claude host 不建立独立层叠上下文，普通页面上按钮可点击；`z-index: 50` 页面浮层打开时实际覆盖按钮和面板，关闭后恢复。
- [ui-overlay-probe.js](./ui-overlay-probe.js) 在覆盖前后的命中报告与浏览器实际结果一致，无 API 请求和页面异常。

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run test:browser
```

也可设置 `INKSTONE_BROWSER_EXECUTABLE` 使用已有的 Chromium。Claude 两种位置的正常/覆盖截图保存在 `dist/claude-*-normal.png` 和 `dist/claude-*-overlay.png`。

## 真实登录环境检查

合成 DOM 验证层叠规则与已知锚点选择，不代表网站当前所有灰度布局和菜单都已验证。真实菜单/搜索结果/设置浮层的结构与层级需要在登录环境中检查。

先从当前分支构建 `dist/inkstone.user.js` 并安装到 Tampermonkey，刷新页面确认生效；若安装了其他 Inkstone 版本，应只启用本次测试版本。然后在 F12 → Console 运行 [ui-overlay-probe.js](./ui-overlay-probe.js) 全文，保存 `INKSTONE_UI_OVERLAY_PROBE_BEGIN/END` 之间的 JSON。

| 站点 | 需要采集的状态 |
| --- | --- |
| Claude | 普通页面、Inkstone 面板打开、页面菜单打开、搜索结果打开、设置/usage 浮层打开；顶栏/输入框两种位置各测一遍 |
| ChatGPT | 会话/新会话 × 聊天/工作四种布局；顶栏/输入框两种位置；页面菜单与设置浮层打开时；暗色主题 |

重点看 `host.style`、`fab.style.zIndex`、`panel.style.zIndex`、`fabHitTests`、`panelHitTests` 和 `visibleOverlays`。如果浮层与按钮/面板位置重叠，Claude 的 `inkstoneIsTop` 应为 `false`，报告中的 `top` 应是页面浮层。若两者不重叠，该字段为 `true` 不能单独证明层级有误，需要结合矩形位置判断。

探针不发网络请求，也不读取 cookie、storage、正文、输入值、原始 URL 或对象名称。没有检测到原生 Inkstone host 时，`installed` 为 `false`；先确认当前构建已安装并刷新页面，再采集。

Claude 工作区和沙箱接口的真实诊断另见 [PR #2 核实记录](./pr2-review-verification.md)。
