# 发布新版本

本项目通过 GitHub Actions 为 Windows x64 自动生成安装版与便携版。

## 发布前

1. 同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与 README 中的版本号。
2. 更新 `CHANGELOG.md`。
3. 在 Windows 上运行：

   ```powershell
   npm.cmd ci
   npm.cmd run verify
   cargo test --manifest-path src-tauri/Cargo.toml --locked
   npm.cmd run tauri build
   ```

4. 检查任务提醒、喝水、专注、久坐活动、历史记录与全部宠物互动。
5. 检查安装版和便携版均可在未安装 Codex、Node.js、Rust、Python 的 Windows 电脑上运行。

## 创建 Release

确认 `main` 分支的 CI 通过后，创建并推送与版本一致的标签：

```powershell
git tag v1.3.0
git push origin v1.3.0
```

`Windows Release` 工作流会自动：

- 执行前端测试、宠物包校验与 Rust 测试；
- 编译 Windows 应用；
- 生成 `Yuanyuan-Reminder-<version>-x64-Setup.exe`；
- 生成 `Yuanyuan-Reminder-<version>-x64-Portable.exe`；
- 生成 `SHA256SUMS.txt`；
- 创建 GitHub Release 并附上上述文件。

如果工作流失败，不要复用已经失败的标签。修复后删除本地及远程失败标签，再重新创建同名标签，或递增补丁版本。
