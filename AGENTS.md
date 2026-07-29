# 样片工厂：GitHub 同步规则

当用户说“同步到 GitHub”“发布更新”或类似要求时，按下面流程执行。

## 两个目录的职责

- 实际运行和日常修改目录：`/Users/Apple/Downloads/样片工厂`
- GitHub 专用发布仓库：`/Users/Apple/Downloads/AI人脸提示词/TTyangpian-release`
- GitHub：`https://github.com/lengjueqi-coder/TTyangpian`

不要把运行目录整体复制或执行 `git add .`。它包含图片、任务记录、API 配置、日志、模型、缓存和备份。

## 标准同步命令

在发布仓库运行：

```bash
./scripts/sync_from_live.sh --message "fix: 简述本次修改"
```

脚本只同步白名单中的源代码；`app.py` 会使用受版本控制的基线做三方合并，从而同时保留运行目录的新功能和发布仓库的跨平台逻辑。随后运行隐私校验、JSON 校验、测试和 `git diff --check`，检查通过后才会创建提交。确认提交正确后执行：

```bash
git push origin HEAD:main
```

若需要发布可供软件内“检查更新”下载的新版本，还必须：

1. 更新 `version.json`；
2. 确认 `.github/workflows/release.yml` 已在 GitHub 的 `main` 分支；
3. 推送与版本一致的标签，例如 `v1.5.1`；
4. 等待 GitHub Actions 的 Windows、macOS 构建和 Release 完成；
5. 核对 Release 同时包含安装包、便携包和 `.sha256` 文件。

没有 Release 安装资产时，只推送源码不会让已安装用户完成自动更新。不要声称“更新链路已完成”。

## 永远不得上传

- `data/`、`logs/`、`models/`、`static/images/`
- `_运行缓存/`、`_成品输出/`、`_代码备份/`
- `.env`、`config/`、API Key、Token、Cookie
- `build/`、`dist/`、虚拟环境、测试缓存
- 用户图片、任务历史、导出文件、烟雾测试报告

`default_data/` 不能从运行目录直接覆盖。它只能是经过脱敏的首次启动模板，API Key、任务队列和使用记录必须为空。

## 冲突和失败处理

- 发布仓库存在不明未提交修改时，停止并检查，不能覆盖或删除。
- 远端有新提交时，先获取并审阅差异，再合并；不能强推。
- 测试或隐私校验失败时，不提交、不推送。
- 不停止或重启正在运行的样片工厂；同步源文件不需要终止当前图片任务。
