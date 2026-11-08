# 安全策略

## 报告漏洞

请不要在本仓库开公开 issue。请通过 GitHub 的 **Security → Report a vulnerability**
（私有漏洞报告）联系维护者，并附上复现步骤与影响范围。

我们会在 7 天内确认收到，并在修复发布后致谢（如你愿意署名）。

## 支持范围

只对最新发布版本（`1.0.x`）提供安全修复。超过一个次版本线（`0.x`）的旧版本不再单独修复。

## 模块的安全模型

- 模块在 Lumina Studio 的**沙箱 iframe** 中运行，宿主通过 `_RUNTIME_CSP` 限制为
  `default-src 'none'`，只放行内联脚本/样式、`data:`/`blob:` 的图片与 Worker，**禁止任何网络连接**
  （`connect-src 'none'`）。模块不发送也不接收任何外部请求。
- 模块代码**不进入宿主进程**：Python 侧只做包校验与文件落盘，从不执行模块 JavaScript。
- 能力（`image.pick`、`handoff.image`）必须在 `manifest.json` 里声明，且每次调用都由宿主校验并回传结果；
  模块无法越过声明去访问工程、颜色库或文件系统。
- 安装的包在安装时按白名单校验：只允许 `manifest.json`、`ui/index.html`、`assets/icon.png`、
  `README.md`、`LICENSE` 与 `assets/gallery/*`；`ui/index.html` 的 `src`/`href` 只允许
  `#`、`data:`、`blob:`、`about:blank`。

## 供应链

`ui/index.html` 内联的 `@lumina/workshop-sdk` 固定为 v1.0.2 的不可变 Release 资产，
`scripts/fetch-sdk.mjs` 在构建时校验 sha256
（`f23f8d0b5181116e8173c0a6f4171405980269615f429be4805973ec4efa93ad`），不匹配即中止构建。
