# SCM-001 通用与个人内容通道隔离审计

日期：2026-08-14<br>
任务：SCM-001<br>
通用开发分支：`feat/fragment-learning-stage-0-1`<br>
稳定基线：`main` / `3146aba`<br>
个人验证分支：`personal/kajweb-kaoyan-local` / `ef210e7`

## 结论

仓库没有可以直接使用的干净 Learning Preview 提交。`45f5599` 首次引入学习能力时，同时加入了通用学习代码、个人词包、个人构建配置和稳定版发行工程；因此不能把该提交或其后代直接作为通用分支历史。

通用分支从未包含个人词库的稳定 `main` 基线创建。Learning Preview 按最终文件状态重建，并明确排除个人资源、个人构建入口和个人包加载代码。个人分支继续保留在本地，只用于真实规模迁移、性能和个人安装验证，不作为通用分支祖先，也不得直接推送到公共仓库。

## 文件级提交审计

### 通用代码候选

| 提交 | 分类 | 迁移决定 |
| --- | --- | --- |
| `45f5599` | 混合提交 | 不挑选；仅按文件/代码块提取 Learning Preview 通用实现 |
| `67e42ae` | 通用学习 | 提取客观题闭环、schema v3 与对应测试 |
| `e7e7dd4` | 通用学习/宠物 | 提取桌面小黑板、学习图集、构建边界与测试 |
| `53d6241` | 通用学习/宠物 | 提取桌面学习动作和窗口协调改进 |
| `4a24cfc` | 通用学习/宠物 | 提取学习反馈动作与图集清单更新 |
| `23112a8` | 通用学习 | 提取学习可用量修复 |
| `f77c48a` | 通用学习 | 提取看板、错题和记录浏览能力；提交标题虽含 personal，变更文件是通用实现 |
| `d41eda2` | 通用学习 | 提取不限轮次与 schema v5 实现 |
| `beaed5f` | 通用学习/稳定交互 | 提取退出文案、学习窗口样式和睡眠菜单协调 |
| `9cfd466` | 混合提交 | 不挑选；只提取通用 UI 修正，排除个人资源、准备脚本和个人包加载器 |
| `dd1c166` | 通用稳定修复 | 提取手动睡眠状态修复及回归测试 |
| `ef210e7` | 通用稳定修复 | 提取 Windows 睡眠菜单标签修复 |

### 个人内容或个人构建提交

| 提交 | 个人范围 | 处置 |
| --- | --- | --- |
| `45f5599` | 个人 CSV、来源清单、个人 Cargo feature、个人 Tauri 配置、个人准备与自动装包代码 | 不进入通用历史；通用部分按文件级重建 |
| `9cfd466` | 更新个人 CSV/清单/准备脚本/自动装包代码，同时混有通用 UI 修正 | 不整提交挑选；只提取通用 UI 修正 |

### 冲突说明

- `3146aba` 是从同一稳定祖先形成的 v1.4 源码拆分，已经包含发行、MSIX、数据清理和稳定 UI 改动；不能用 `45f5599` 覆盖整个树，否则会把个人内容带入历史并可能倒退稳定主线。
- `45f5599` 和 `9cfd466` 是不可拆分的混合提交，采用最终文件级重建，不执行 cherry-pick。
- 其余学习提交虽然可以逻辑分类为通用，但都以 `45f5599` 为祖先；为避免祖先历史携带个人 CSV，通用分支同样采用无个人祖先的文件级重建。
- 个人验证分支后续通过挑选通用分支新提交获得更新；不得反向把个人分支提交直接合入通用分支。

## 个人资源路径 denylist

以下路径或内容不得出现在通用分支的工作树、分支新增历史或 Learning Preview 构建产物：

- `src-tauri/resources/personal-learning/**`
- `work/personal-sources/**`
- `src-tauri/tauri.learning-personal.conf.json`
- `scripts/prepare_personal_kajweb_pack.mjs`
- `src-tauri/src/learning/personal_pack.rs`
- 名称含个人上游标识的压缩包
- 从用户数据目录复制出的 `yuanyuan-reminder.sqlite3*` 或 `yuanyuan-learning.sqlite3*`
- 源码或构建产物中的个人 edition/feature 标识、用户绝对路径

`.gitignore` 负责降低误加入概率；`scripts/verify_fragment_learning_boundary.mjs` 独立检查当前候选文件、相对 `main` 的全部分支新增提交，以及指定的构建产物目录。个人构建文件即使被忽略，只要出现在通用源码/资源目录仍会失败。`work/personal-sources/**` 可以作为本机忽略目录继续服务个人验证分支，但一旦被强制加入 Git 或出现在产物中就会失败；通用构建没有读取该目录的入口。

## 构建形态

通用分支只保留：

- 默认稳定构建：学习关闭；
- Learning Preview：Cargo `learning` feature、Vite `learning-preview` mode、`src-tauri/tauri.learning-preview.conf.json`；
- 不含个人内容的浏览器演示和合成测试数据。

Learning Preview 桌面构建使用独立的 `src-tauri/target/learning-preview/` 目标目录，避免同一机器上个人验证分支遗留的安装包被误计入通用构建产物清单。个人构建脚本、配置与内置词包只保留在个人验证分支。通用提交挑选回个人分支后，再由个人分支自己的入口执行真实 4,533 卡验证。

## 验证记录

验证完成后在本节记录命令、结果和未完成的真实 Windows 项；自动化通过不等于公开发布、内容权利或人工 Windows 验收批准。

- `npm.cmd run learning:boundary:verify`：通过；5 项策略测试通过，571 个候选文件无个人资源路径/标识/用户数据，分支基线为 `3146aba`
- `npm.cmd run learning-off:verify`：通过；默认前端产物 8 个文件无学习 UI、命令、数据库名或学习资源
- `npm.cmd run learning:verify`：通过；前端 198 项、默认 Rust 201 项通过/1 项权限忽略、learning Rust 254 项通过/1 项权限忽略，Learning Preview 前端产物 14 个文件通过扫描
- `npm.cmd run verify`：通过；完整迁移、发行边界、安全、证据和宠物回归门通过
- `cargo test`：通过；workspace 全部测试通过，主程序 201 项通过/1 项 Windows 符号链接权限忽略
- `npm.cmd run pet:validate`：通过；39 个动画、4 张 WebP 图集通过
- `npm.cmd run tauri build`：通过；稳定版 NSIS 构建成功
- `npm.cmd run learning:desktop:build`：通过；独立目标目录仅生成 1 个 Learning Preview NSIS，安装包目录和二进制字节无个人标识
- `git diff --check`：通过
- 真实 Windows 交互：release/runtime-QA 已封存启动、学习页/小黑板、活动学习中强提醒让位、杀进程恢复原题及原生菜单睡眠/唤醒状态链；安装启动、通用导入、物理右键/OS 级菜单选择、专注结束邀请、DPI 与 Narrator/减少动画/高对比度仍需人工验证
