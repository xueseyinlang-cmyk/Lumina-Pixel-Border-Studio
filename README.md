# 像素工坊 · 图片转像素（Lumina 创意工坊模块）

把 `pixel-border-studio` 打包成 Lumina Studio「创意工坊」可安装模块（`.lumina-workshop`）：
把任意图片转成像素画，**逐格调节黑边**（粗细 / 颜色 / 不透明度 / 位置 / 混合方式 / 圆角 / 双色），
然后在宿主内把结果直接交给 Lumina 的转换器（LUT / 材料 / 3MF）。

| 能力 | 用途 | 权限 |
| --- | --- | --- |
| 从 Lumina 选图 | 直接用宿主工程里的图片作为像素化输入（比本地上传更顺） | `image.pick` |
| 交给 Lumina | 把调好黑边的像素化 PNG 交回 Lumina 的转换器（LUT / 材料 / 3MF） | `handoff.image` |

独立双击 `ui/index.html` 时**不会**出现这两个按钮，行为与单文件版完全一致
（打开图片 / 拖放 / Ctrl+V / 导出 PNG / 导出 1× / 色卡 / 像素编辑器 / 预览与编辑器缩放）。

- 模块 id：`studio.pixelborder.pixelator`
- 当前版本：`1.0.5`（与 `package.json`、git tag `v1.0.5` 三方一致）
- 宿主要求：Lumina Studio ≥ 2.0.0，Workshop API `1.0.0`（`>=1.0.0 <2.0.0`）
- 许可证：GPL-3.0-or-later

## 仓库布局

```
manifest.json              模块清单（宿主要求放在仓库根）
package.json               仓库元数据与脚本（private，不发布到 npm）
src/                       单文件应用源码
  core.js                    纯数值内核（网格检测 / 采样 / 量化 / 黑边 / 管线缓存）
  app.js                     主线程 UI、Worker 调度、导出、像素编辑器
  style.css                  样式
  index.template.html        页面骨架（{{STYLE}} / {{CORE}} / {{APP}} 占位）
  host-bridge.js             工坊桥接（握手 + image.pick + handoff.image）
assets/icon.png            512×512 图标（宿主包必需文件）
scripts/
  fetch-sdk.mjs              取 @lumina/workshop-sdk 的不可变 Release 资产并校验 sha256
  build-web.mjs              内联 src/ → dist/pixel-border-studio.html
  package.mjs                宿主规则校验 + 打包 → artifacts/*.lumina-workshop + .sha256
  install-to-lumina.cmd      本机安装（探活 → install/local → activate → 回读）
test/selftest.mjs          65 项数值自检（网格 / 采样 / 量化 / 黑边 / 缓存 / 规模）
tools/host-sim/            宿主模拟器（仅本地联调，不进入安装包）
tools/mock-host.mjs        假后端（验证 install 脚本本身）
dist/                      构建中间产物（git 忽略）
artifacts/                 发布资产（git 忽略）
```

## 构建

```bash
node scripts/fetch-sdk.mjs    # 取 @lumina/workshop-sdk 1.0.2（校验 sha256，落到 .sdk/）
node scripts/build-web.mjs    # 内联 src/ → dist/pixel-border-studio.html
node test/selftest.mjs        # 数值自检（65 项）
node scripts/package.mjs      # 宿主规则校验 + 打包 → artifacts/
```

产物：

```
artifacts/studio.pixelborder.pixelator-1.0.5.lumina-workshop
artifacts/studio.pixelborder.pixelator-1.0.5.lumina-workshop.sha256
```

只依赖 Node.js ≥ 20，**不需要 npm install**（`.sdk` 与 `dist` / `artifacts` 都由脚本生成）。

SDK 固定版本与校验：`v1.0.2`，6,990 B，
`sha256=f23f8d0b5181116e8173c0a6f4171405980269615f429be4805973ec4efa93ad`
（`scripts/fetch-sdk.mjs` 内硬编码，不匹配即以退出码 2 停止）。离线时可用
`node scripts/fetch-sdk.mjs --from <path>/lumina-workshop-sdk-1.0.2.tgz`。

## 安装（Lumina Studio）

### 一键（推荐）

前置条件只有一个：**Lumina Studio 已启动**（用 launcher 打开应用，后端在 8000 端口监听）。

```bat
scripts\install-to-lumina.cmd
```

脚本做四步，每步失败都会打印原因并停下：

1. `GET /api/workshop/v1/modules` 探活（连不上就提示去启动应用，并指向 `%APPDATA%\lumina-electron\backend-port.json`）；
2. `POST /api/workshop/v1/install/local` 上传 `artifacts/*.lumina-workshop`（multipart 字段名是 `archive`，装成**未激活候选**）；
3. `POST /api/workshop/v1/modules/studio.pixelborder.pixelator/activate`，body `{"version":"<包版本>"}`；
4. 再拉一次 `/modules`，确认列表里出现本模块 id。

### 应用内

「创意工坊 → 开发者 / Developer → 安装本地包」，选 `artifacts/studio.pixelborder.pixelator-1.0.5.lumina-workshop`，
装成未激活候选后点「激活」，回到已安装列表打开模块。

> 本地包安装与本地运行时 HTML 需要**每次启动的桌面 token**（由 Electron 主进程交给 loopback 后端），
> 因此打开模块必须在应用里；`GET .../runtime` 从命令行访问会得到 `403`，这是设计如此。
> 安装/激活两个接口本身不需要 token，所以一键脚本可以跑。

联调（没有应用时）可用假后端验证脚本本身：

```bash
node tools/mock-host.mjs 8123
set PBS_WORKSHOP_BASE=http://127.0.0.1:8123/api/workshop/v1
scripts\install-to-lumina.cmd
```

## 本地验证（无宿主时）

```bash
node tools/host-sim/serve.mjs      # http://localhost:8781/
```

浏览器打开 `http://localhost:8781/`，页面会自动：握手 → `image.pick` → 渲染 → `handoff.image` 两次
（第一次 `needs-confirmation`、第二次 `completed`）→ 打印 `PASS=true`。
模拟器 `/ui/*` 的响应头与宿主 `api/routers/workshop.py::_RUNTIME_CSP` 一致，
所以这里通过就代表沙箱 CSP 下也能通过。

- 真机（Lumina Studio 2.0.1，2026-11-08）：`POST /api/workshop/v1/install/local` → `activate` 1.0.5 成功；宿主落盘的 5 个文件与发布包逐字节一致（`ui/index.html` `712b12ce…`），`/runtime` 无桌面 token 返回 403（只能应用内打开）。
已验证（Chromium，1.0.5）：

- 握手：`ready from module: studio.pixelborder.pixelator@1.0.5 api=1.0.0` → `lumina.workshop.connect` 成功。
- `lifecycle.ready` → `image.pick`（64×64 PNG）→ 主应用 `渲染完成 · 64×64 · 24 色`。
- `handoff.image` 第一次 `needs-confirmation`、第二次 `completed`，负载含 `recipeSource.payload.settings`。
- SVG 输入（含 20000×20000 的极端尺寸）在沙箱内不崩：栅格化上限 2048px。

## 模块内实现说明

- `ui/index.html` = 单文件主应用 + 内联 `@lumina/workshop-sdk` + `host-bridge.js`，全部内联，无外链
  （宿主 `core/workshop/package_validator.py` 要求 `src`/`href` 只能是 `#` / `data:` / `blob:` / `about:blank`）。
- `host-bridge.js` 只在 `window.parent !== window` 时启用：握手 `connectWorkshop({moduleId, moduleVersion})`，
  收到客户端后注入「从 Lumina 选图 / 交给 Lumina」两个按钮与连接状态徽标；模块 id/版本由
  `scripts/package.mjs` 在打包时从 `manifest.json` 注入（占位符 `__MODULE_ID__` / `__MODULE_VERSION__`）。
- 交接负载：`{moduleId, moduleVersion, projectId, pngBytes(ArrayBuffer), pixelWidth, pixelHeight,
  recommendedWidthMm, recommendedHeightMm, preserveCanvasBounds:true, colorLibraryId:null, recipeSource}`；
  `recipeSource.payload` 带上完整像素化设置，便于复现。`needs-confirmation` 时同 `projectId` 再点一次即确认替换，
  `completed` 后换新 `projectId`。
- 沙箱内 `window.confirm` 常被宿主禁用：`PBS_MODULE_MODE` 下跳过「编辑器有未应用改动」的二次确认，
  直接沿用「替换即关闭编辑器」的行为。

## 发布

发布走 tag，人不需要本地手工上传资产：

```bash
git tag -a v1.0.5 -m "v1.0.5"
git push origin v1.0.5
```

`.github/workflows/release.yml` 会：拉取固定版本 SDK → 构建 → 自检 → 打包 →
校验「tag == `v<package.json version>` == `manifest.json version`」→ 校验 `artifacts/` 恰好两个文件且
`sha256sum -c` 通过 → `git diff --exit-code` → `gh release create v1.0.5 <asset> <asset>.sha256 --verify-tag`。

规则：

- 资产名固定 `<module-id>-<version>.lumina-workshop` 与 `<同名>.sha256`（`sha256sum` 兼容格式）；
- **一个版本号只对应一份字节**：已发布就不可变，改任何文件（含 README）都要先升版本；
- 不发 `latest` 之类可变资产，不上 npm registry。

## 已知边界

- 单文件应用体积预算（307,200 B 通过线）只管主应用；模块包另受宿主 100 MiB / 2,000 文件 / 压缩比 ≤ 100 约束。
- 宿主未运行时无法验证握手与交接，用 `tools/host-sim` 代替（它复刻宿主 CSP，但不等同真宿主）。
- 图标为代码生成的 512×512 PNG，未做多尺寸/深色适配。

## 踩坑记录（已验证）

- **`manifest.json` 的 `name` / `description` 每个语言都 ≤ 200 字符**（宿主 `core/workshop/models.py` 的
  `LocalizedText`，`max_length=200`，按字符计）。超长时 `/install/local` 只回
  `422 {"detail":"The Creative Workshop package is invalid."}`，**不会指出是哪个字段**；
  `scripts/package.mjs` 已加同规则的前置校验。
- 同一 `module_id` + 同一 `version` 重复安装返回
  `409 {"detail":"module version is already installed"}`：只改文档也要先升版本号。
- 本地（`source: local`）模块的 `GET .../runtime` 需要 `X-Lumina-Workshop-Desktop-Token`，无 token 直接 `403`。
- 包内只允许 `manifest.json` / `ui/index.html` / `assets/icon.png` / `README.md` / `LICENSE`
  与 `assets/gallery/*`，多一个文件都会报 `unexpected package file`。

## 许可证

本模块以 **GPL-3.0-or-later** 分发。`ui/index.html` 内联了
`@lumina/workshop-sdk` v1.0.2（同样为 GPL-3.0-or-later，来源与 sha256 见 `LICENSE` 与
`scripts/fetch-sdk.mjs`）。对应源码即本仓库。
