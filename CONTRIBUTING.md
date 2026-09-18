# 贡献指南

欢迎修正福利信息、改善页面体验、修复接口问题。这个仓库可以独立运行，不需要 TechFlow 主仓库或线上数据。

## 如何参与

1. 先查看 [Issues](https://github.com/pigWolfy/microsoft-china-employee-toolkit/issues)，了解已有讨论；发现错误或想提议较大的改动，可以先开 Issue。
2. Fork 本仓库，克隆你的 Fork，在自己的分支上修改。
3. 在本地运行并检查相关功能，至少在 `server/` 目录执行 `npm run build`。
4. 向本仓库的 `main` 分支发起 Pull Request，说明修改内容、验证方式；界面改动请附截图。

小的文字纠错也可以直接通过 GitHub 的文件编辑界面提交 Pull Request。

## 本地开发

需要 Node.js 20.9+ 和 npm。在克隆的仓库中运行：

```bash
cd server
npm ci
npm run dev
```

打开 `http://localhost:3000/`。基础页面和公开接口无需 `.env.local`。本地数据从空目录开始，薪资样本表为空属于正常现象。首次加载页面还会请求外部 CDN，离线时部分样式或资源可能无法显示。

修改页面请编辑仓库根目录的 `index.html`、`sw.js`、`manifest.webmanifest` 或图标。`server/public/` 是启动和构建时自动复制的产物，不要直接修改；编辑根目录文件后重启开发服务。接口在 `server/src/app/api/`，推送任务在 `server/scripts/send-payday.mjs`。服务端细节见 [server/README.md](server/README.md)。

开发管理员功能、老板评分或推送提醒时，将 `server/.env.example` 复制为 `server/.env.local`，按需填写自己的测试配置。`ADMIN_TOKEN` 和 `BOSS_ANON_SALT` 应分别使用随机值；推送需要自行生成 VAPID 密钥。不要使用线上密钥或线上数据，也不要提交 `.env.local`、`server/data/` 或包含个人信息的测试文件。

## 内容与提交要求

- 修改福利、薪资或劳动相关内容时，尽量在 Pull Request 中说明公开来源、适用地区和核对日期；不确定的内容请标明待核实。
- 不要上传内部文档、员工个人信息、账号凭据或未经授权公开的材料。
- 保持改动聚焦；提交前运行 `npm run build`，并手动检查受影响的页面或接口。

项目的原创源代码采用 [MIT License](LICENSE)。提交 Pull Request 表示同意你的贡献按该许可证发布。