# UX-RESEARCH-001 独立研究执行包

状态：研究原型与合成材料可供内部试跑；真实参与者研究未执行。

这个目录只用于在 GEN/PACK 冻结前验证通用私有学习包工作流。`prototype.html` 是研究专用的交互草图，不是圆圆提醒 Preview 或生产实现，也不能证明 PACK-002、PACK-003、PACK-004 已完成。

## 边界

- 原型只处理参与者主动粘贴到页面中的文本；没有文件选择器。
- 所有数据只保存在当前页面内存中；刷新或关闭页面后消失。
- 没有网络请求、Tauri 调用、数据库、系统路径、日志、遥测、导出或真实导入。
- “导入”“开始学习”“内容库”均为当前页面中的模拟状态，只用于观察概念理解和步骤衔接。
- 原型及本目录材料必须被应用构建排除；自动检查会扫描默认版和学习 Preview 的 `dist`。
- 真实场次只能使用本目录合成材料。不得粘贴工作原文、个人信息、账号、客户/项目名或绝对路径。

## 主持人准备

1. 在离线研究设备上复制本目录，断开不必要的屏幕录制与同步工具。
2. 直接打开 `prototype.html`；确认页面顶部显示“研究专用 · 仅内存”。
3. 随机分配 `materials/material-a.txt` 到 `material-d.txt` 之一，并提供 `materials/card-builder-template.csv`。
4. 建议参与者用本地表格工具把 10—20 张卡填入模板，再把 CSV 文本粘贴到原型；不记录卡片内容。
5. 只在 `templates/session-record.template.json` 的副本中记录固定指标和代码。场次结束后刷新原型。

## 执行顺序

1. 按 `../UX_RESEARCH_001_PROTOCOL.md` 完成边界说明和匿名指标同意。
2. 参与者从合成笔记制作卡片，并将 CSV 文本粘贴到原型。
3. 参与者选择分隔符、完成字段映射并生成抽样预览。
4. 参与者根据固定错误摘要修复至少一个问题。
5. 参与者执行页面内的模拟导入，开始一轮模拟学习，再回到模拟内容库找到刚才的包。
6. 主持人填写匿名记录；不得把页面内容复制到记录中。

## 文件

- `prototype.html`：研究专用、无持久化的交互草图。
- `materials/material-a.txt`—`material-d.txt`：完全合成的 15 条笔记。
- `materials/card-builder-template.csv`：本地制卡模板。
- `templates/session-record.template.json`：单场匿名量化记录。
- `templates/summary.template.md`：跨场汇总模板。
- `templates/named-deferral.template.md`：无法按期完成真实研究时的具名延期决策。
- `manifest.json`：文件清单、覆盖标签和内容摘要。

执行包通过自动检查只表示材料齐全、隐私与构建隔离边界成立；不表示可用性结论成立。真实参与者结果或具名延期仍是阶段出口条件。
