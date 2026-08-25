# QA-003：干净提交双构建证据

日期：2026-08-25<br>
构建输入提交：`6b9389bab6aac99525e4c3143b9c1a5eb8dcfe65`<br>
分支：`feat/fragment-learning-stage-0-1`<br>
判定：Stable 与 Learning Preview 均由零工作树改动的同一提交成功构建；最终 `dist` 已恢复 learning-off

## 1. 构建顺序

1. `npm.cmd run learning:desktop:build`
2. `npm.cmd run tauri build`
3. `node scripts/verify_learning_disabled_boundary.mjs`
4. 对 Stable/Preview bundle 分别执行 `verify_fragment_learning_boundary.mjs --artifact-dir ...`
5. 对两个 release 可执行文件执行冻结学习标记扫描，并核对安装包 SHA-256 与 Authenticode 状态

先构建 Preview、再构建 Stable，确保最终 `dist` 和默认 release 目标保持学习关闭。两次构建前后 `git status --porcelain=v1` 均为空；Stable 构建重写的许可证归档内容未漂移。

## 2. 产物绑定

| 产物 | 字节数 | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| Stable NSIS `圆圆提醒_1.4.0_x64-setup.exe` | 12,524,156 | `D531BB67B562B5E78D97E6F7C5FF53E1FA13D1673B5C6213DF38170BD00E0D60` | `NotSigned` |
| Learning Preview NSIS `圆圆提醒学习预览版_1.4.0_x64-setup.exe` | 13,925,914 | `CD998032D3CEB7828AB292FA536658797B3ED07DC5B7C0D59C9B9150DC8F2FC4` | `NotSigned` |
| Stable EXE `yuanyuan-reminder.exe` | 22,275,072 | `B7B633BB1B7A51B7974D6E9AEDDF70DF11ADAC2680884679A8BE1B4A9E824E52` | 内部未签名构建 |
| Learning Preview EXE `yuanyuan-reminder.exe` | 24,881,152 | `6667E6768818F544B7E446A60D051EB121A7A51396208ACAA7BA6BCA02B9A40A` | 内部未签名构建 |

## 3. 边界结果

- SCM-001 扫描通过：605 个仓库文件、基线后的 5 个提交无个人内容命中。
- Stable bundle 扫描通过；最终默认 `dist` 的 8 个文件不含学习页面、命令、数据库名、演示数据或 learning atlas。
- Stable release EXE 不含 `get_learning_home`、`start_manual_learning_session`、`yuanyuan-learning.sqlite3` 三项冻结标记。
- Learning Preview release EXE 包含上述三项标记，证明 feature-on 命令与独立数据库入口进入了预览二进制。
- Preview bundle 个人内容边界扫描通过；pre-GEN parser 与 UX research 原型均未进入 Stable 或 Preview 产物。

## 4. 限制

这些产物只证明同一干净提交可以分别生成默认关闭和学习开启的内部安装包，并证明两条产物边界没有串线。它们没有数字签名，不替代 runtime-QA 性能/恢复报告、物理 Windows 菜单和 DPI/Narrator 人工矩阵、内容权利、GEN-000 具名签字或公开发布批准。

本文件自身在构建完成后作为证据记录提交；它只增加文档，不改变上述应用、脚本、配置、依赖或资源输入。
