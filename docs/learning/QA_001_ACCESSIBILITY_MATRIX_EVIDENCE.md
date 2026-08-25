# QA-001：Learning Preview 窗口与辅助显示证据

日期：2026-08-21<br>
状态：当前 150% DPI 自动化矩阵通过；多 DPI、Narrator 与物理键盘仍待人工

## 正式报告

`src-tauri/target/runtime-qa-learning-accessibility/release/evidence/learning-accessibility-matrix-20260821T145707Z.json`

独立检查：

```powershell
npm.cmd run runtime:learning-accessibility:evidence:test
npm.cmd run runtime:learning-accessibility:verify
```

报告绑定当前 QA 应用、fixture、合成内容、`learningDesktop.css`、测量脚本及 6 张 PNG 的 SHA-256。检查器从 PNG `IHDR` 重读物理尺寸并复算文件哈希，还核对每个原生窗口完整位于当前显示器工作区；12/12 项正反向测试通过。不接受缺图、旧脚本、旧样式、错误模式、错误逻辑尺寸、越出工作区、缺少可访问状态或未清理测试根目录的报告。

## 当前真实 Windows 结果

设备窗口 DPI 为 144，即 150%。所有尺寸由 Win32 客户区物理像素按窗口 DPI 反算为 Tauri 逻辑像素。

| 场景 | 逻辑尺寸 | 物理尺寸 | 结果 |
| --- | ---: | ---: | --- |
| 学习页最小窗口 | 360×560 | 540×840 | 页面仍在 Windows UI Automation 树中；截图无横向裁切 |
| 学习页默认窗口 | 390×620 | 585×930 | 页面、标签与滚动区域完整 |
| 学习页最大窗口 | 480×760 | 720×1,140 | WebView 随宿主真实扩展，卡片、统计与设置进入响应式两列布局，无黑边或裁切 |
| 标准小黑板 | 520×420 | 780×630 | 四个选项、退出按钮、圆圆和反馈按钮完整 |
| 减少动态小黑板 | 520×420 | 780×630 | `prefers-reduced-motion: reduce` 与 `animationMode=system` 同时生效；可访问树出现“已减少动态效果” |
| 强制颜色小黑板 | 520×420 | 780×630 | `forced-colors: active` 生效；可访问树出现“已启用 Windows 强制颜色”；系统色截图文字清晰 |

三个标准学习页原生窗口的物理边界分别为 `(107,98)–(647,938)`、`(107,98)–(692,1028)`、`(107,98)–(827,1238)`，全部落在 `(0,0)–(3840,2088)` 工作区内。

视觉复核关闭了两类仅靠机器字段无法发现的问题。强制颜色首轮在白色 `Canvas` 上仍保留浅色自定义文字；修复为 `CanvasText`、`ButtonFace/ButtonText` 和 `Highlight` 后才重跑。后续外部 Win32 调整窗口的诊断报告虽然一度显示尺寸 ready，但 480×760 只放大原生宿主，WebView 仍停留在 390×620 并留下黑边；另一次外部定位还受 DPI 虚拟化影响而裁切。当前正式报告改由 Tauri 主线程调用窗口 `set_size`，确认 WebView 实际响应式重排，并使用白名单工作区位置。上述失败报告只保留为诊断历史，不参与当前判定。

## 焦点与可访问名称

- 组件测试证明题目书写结束后 DOM 焦点自动进入第一答案选项。
- 真实 Tauri 中，Windows UI Automation 从小黑板窗口树找到第一合成答案按钮；节点可聚焦、可用、边界完全位于 520×420 窗口内，且 `SetFocus` 请求可调用。
- WebView 可访问节点属于 WebView2 渲染子进程，报告同时记录 Tauri 主进程和元素进程，不把二者 PID 不同误判为外部窗口。
- 当前非交互自动化受 Windows foreground lock 限制，全局焦点没有从 Codex 窗口切走；报告原样记录 `globalFocusObserved=false`。这不是物理键盘通过证据。
- 三种模式均暴露“圆圆桌面英语复习”“请选择中文释义”“结束本轮”；辅助显示状态只在对应模式出现。

## QA 注入边界

提升权限的 WebView2 会忽略环境变量形式的附加浏览器参数，因此 runtime-QA 改用 Tauri `WebviewWindowBuilder` 程序化设置。只接受三个固定模式：

```text
standard       → 无附加参数
reduced-motion → --force-prefers-reduced-motion
forced-colors  → --force-high-contrast --enable-blink-features=ForcedColors
```

任意其他值均在建窗前拒绝。窗口位置只接受 `work-area-top-left`；尺寸控制只接受 `set-panel-size-360x560`、`set-panel-size-390x620`、`set-panel-size-480x760` 三个精确空普通文件触发器，并在 Tauri 主线程执行。该入口只存在于 `runtime-qa` feature，不进入稳定版运行路径，也不允许脚本传入任意 Chromium 参数、位置或尺寸。Microsoft WebView2 文档说明提升权限宿主会忽略本地环境变量参数、程序化参数仍可用；Chromium forced-colors 虚拟测试同时使用 `force-high-contrast` 与 `ForcedColors` feature。

## 截图

正式报告同名目录包含：

```text
standard-panel-360x560.png
standard-panel-390x620.png
standard-panel-480x760.png
standard-blackboard-520x420.png
reduced-motion-blackboard-520x420.png
forced-colors-blackboard-520x420.png
```

截图仅通过 `PrintWindow` 捕获隔离应用自有窗口，不包含桌面或个人数据。6 张图均已人工查看。

## 尚未替代的人工门

- 100/125/200% 真实 Windows DPI、多显示器和负坐标；
- Narrator 实际朗读顺序、语速和重复程度；
- 从打开学习页到完成/暂停/恢复的完整物理键盘会话；
- Windows 设置面板实际切换“减少动画”和高对比度主题；
- 高对比度不同系统主题、放大镜、RDP 与签名安装候选。

因此本报告关闭当前设备 150% DPI、固定窗口尺寸、可访问名称/可聚焦性，以及程序化媒体模式的工程风险，但不把辅助技术人工验收标记为完成。
