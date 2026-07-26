# 参与贡献

感谢你帮助圆圆提醒变得更稳定、更好用。Bug 修复、Windows 兼容性改进、无障碍、测试、文档和新的本地功能都很欢迎。

## 开始之前

1. 搜索已有 Issue，避免重复工作；
2. 较大的功能先创建 Feature Request，说明使用场景和对圆圆动作的影响；
3. 涉及宠物素材时阅读 `docs/PET_PACK_SPEC.md` 和 `ASSETS_LICENSE.md`；
4. 不要在 Issue、提交或截图中包含私人照片、任务数据、绝对路径或日志中的个人信息。

## 开发

```powershell
npm.cmd ci
npm.cmd run verify
cd src-tauri
cargo test
```

运行应用：

```powershell
npm.cmd run tauri dev
```

## 提交要求

- 一个提交解决一个明确问题；
- 新逻辑应增加对应的 TypeScript 或 Rust 测试；
- UI 修改应附上干净背景截图；
- 动画修改必须附动作预览，并说明身份一致性、方向和透明背景检查结果；
- 不提交 `release/`、`work/`、构建目录、日志或原始私人照片；
- 保持离线优先，不添加遥测或强制账号。

## Pull Request

PR 描述请写明：

- 修改了什么及原因；
- 对最终用户和圆圆动作的影响；
- 执行过的测试；
- 已知限制；
- 如果修改 UI 或动画，附对应截图或 GIF。

提交贡献即表示你有权提供相关代码与素材，并同意代码使用 MIT License；宠物素材必须带有明确、兼容的素材许可。
