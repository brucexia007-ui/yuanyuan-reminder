# P0 发布候选无障碍验收门 QA（2026-08-10）

## 结论

发布策略现已把多档 DPI、Windows 文本缩放、高对比度、减少动态、全键盘、Narrator 实际听读和安装/卸载辅助功能列为独立人工阻断门。预检不再允许零散截图、CSS/DOM 测试、UI Automation 结果或 `accessibilityAcceptanceVerified` 裸布尔值冒充完整体验验收。

当前只完成候选绑定的验收包、关闭失败模板、独立验证器和回归测试。正式候选仍未签名，也没有具名人工完成全部矩阵，因此 `accessibility_acceptance=pending`、`accessibilityAcceptanceVerified=false`，不能据此宣称无障碍发布验收已通过。

## 当前绑定

| 材料 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `docs/release/RELEASE_POLICY_V1.json` | 1,025 | `B14E8B0CF6660992E0267C4FAD6930D370AD8B556858C3BBE2619D954F0E41F0` |
| `src-tauri/target/release/release-manifest.json` | 1,792 | `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC` |
| `src-tauri/target/release/release-accessibility-acceptance-packet.json` | 3,762 | `F7D34C54BAE26C787A900ADB1F7E33904E453C2CDFCA5BAAAC56EB9A3A946FDE` |
| `src-tauri/target/release/release-preflight.json` | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

候选三项正式产物仍为：

- 便携主程序：22,192,640 bytes，`1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B`；
- NSIS 实际安装主程序：22,192,640 bytes，`143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`；
- NSIS 安装包：12,500,456 bytes，`C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96`。

## 验收合同

实际签字必须同时满足：

1. 三项产物均为最终有效签名候选，发布者、证书和时间戳通过实时 Authenticode 复验；
2. 便携主程序完成独立烟测，安装主程序确实来自当前安装包；
3. 100%、125%、150%、200% DPI 各完成七条核心流程；
4. 100%、150%、200% Windows 文本大小各完成同一核心流程；
5. 深色与浅色 Windows 对比度主题均通过焦点、状态、颜色非唯一语义和可读性检查；
6. Windows 动画效果关闭并开启应用减少动态后，全部含义仍完整且无闪烁；
7. 五条路径完全不使用指针完成，焦点顺序、可见性、返回和取消均正确；
8. 六条路径由具名人工实际听取 Windows Narrator，名称、角色、状态和动态变化准确，无关键静默或重复阻塞；
9. 安装、默认保留数据卸载、明确删除数据卸载均以键盘和 Narrator 完成，并用隔离哨兵验证数据后果；
10. 每项有候选绑定引用，未解决问题为零，AI/机器人和自动化不能充当主要结论。

## 关闭失败测试

- `npm.cmd run release:accessibility:test`：3/3 通过；
- 正向样本覆盖完整签名候选、具名人工、多档矩阵、键盘、Narrator 和安装/卸载；
- 反向样本拒绝 AI/自动化测试人、自动化主要结论、缺失 200% DPI、Narrator 未听到、未签名候选和只修改证据布尔值；
- 包在发布者尚未冻结时仍可确定性生成，但实际验收不能通过；
- `npm.cmd run release:preflight:test`：17/17 通过；
- 缺少实际签字时 `npm.cmd run release:accessibility:verify` 按设计退出 2。

## 实际执行顺序

1. 冻结发布渠道、发布者 Subject 和 RFC 3161 服务；
2. 对三项最终产物完成签名和签名协议复验；
3. 在可回退、无真实用户数据的 Windows 测试环境按 `docs/release/P0_RELEASE_ACCESSIBILITY_ACCEPTANCE_SOP.md` 完成全部矩阵；
4. 从模板创建实际具名签字，按英文顺序填入去重证据引用；
5. 将发布证据状态绑定当前安装包及验收包/签字引用；
6. 运行独立验证、普通预检和严格发布门；
7. 候选、签名、Windows/WebView2 环境或任何结果发生变化时，重新执行受影响矩阵。

## 边界

本增量只建立完整无障碍人工门的确定性合同，不改变系统显示设置、不启动 Narrator、不操作安装器，也不声称当前候选已通过人工体验验收。真实矩阵必须在明确授权的隔离 Windows 环境由具名人工完成；正式用户数据和现有安装不得作为测试材料。
