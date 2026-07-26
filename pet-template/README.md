# 宠物定制起点

1. 复制 `identity-lock.template.md` 并填写你的宠物特征。
2. 准备你有权使用的参考照片，原始私人照片建议放在被 Git 忽略的 `work/` 下。
3. 将 `AI_CUSTOMIZATION_PROMPT.md`、身份锁定文件和照片一起交给 Coding 工具。
4. 生成后的三张正式图集放入 `public/assets/pet/`。
5. 更新 `public/assets/pet/pet-manifest.json`，运行 `npm.cmd run verify`。
6. 用你自己的授权说明替换 `ASSETS_LICENSE.md` 中的圆圆素材条款。

不要把原始家庭照片、失败生成图、临时行素材或包含私人路径的日志提交到公开仓库。
