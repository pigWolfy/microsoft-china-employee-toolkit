# 贡献指南

感谢补充信息或改进工具。请按自己方便的方式参与；这个仓库能独立运行，不需要 TechFlow 主仓库或线上数据。

## 不写代码也能参与

- [补充或纠正福利信息](https://github.com/pigWolfy/microsoft-china-employee-toolkit/issues/new?template=benefit.yml)：填写名称、建议内容即可；公开来源、地区和时间如果知道再补充。不需要 Fork、安装 Node 或运行项目。
- [反馈页面或功能问题](https://github.com/pigWolfy/microsoft-china-employee-toolkit/issues/new?template=bug.yml)：描述现象即可；截图和复现步骤有助于排查，但不是必填。
- 也可以在[线上页面](https://wzkiwi.com/benefits/ms/)点击「补充福利信息」。这会进入站点的审核流程，默认不会作为公开 GitHub Issue 展示。

GitHub Issue 对所有人公开，请勿上传内部文档、员工个人信息、账号凭据或未经授权公开的材料。不确定的信息可以标明「待核实」。

## 直接修改文件

小型内容或文字修改：在 GitHub 打开 `index.html`，点击编辑按钮，修改后选择“Propose changes”，按提示发起 Pull Request。无需本地运行；仓库会自动检查能否构建。福利清单从 `index.html` 中的 `const benefits = [` 开始。

较大的页面或接口修改：Fork 本仓库，在自己的分支修改，并向 `main` 发起 Pull Request。说明改了什么、如何检查；界面变化可附截图。修改福利、薪资或劳动相关内容时，尽量说明公开来源、适用地区和核对日期。维护者会审核并把合并的页面内容同步到线上站点；合并 Pull Request 本身不会立即更新线上页面。

## 本地开发（可选）

需要 Node.js 20.9+ 和 npm。在克隆的仓库中运行：

```bash
cd server
npm ci
npm run dev
```

打开 `http://localhost:3000/`。基础页面和公开接口无需 `.env.local`。本地数据从空目录开始，薪资样本表为空属于正常现象。首次加载页面还会请求外部 CDN，离线时部分样式或资源可能无法显示。

修改页面请编辑仓库根目录的 `index.html`、`sw.js`、`manifest.webmanifest` 或图标。`server/public/` 是启动和构建时自动复制的产物，不要直接修改；编辑根目录文件后重启开发服务。接口在 `server/src/app/api/`，推送任务在 `server/scripts/send-payday.mjs`。服务端细节见 [server/README.md](server/README.md)。

开发管理员功能、老板评分或推送提醒时，将 `server/.env.example` 复制为 `server/.env.local`，按需填写自己的测试配置。`ADMIN_TOKEN` 和 `BOSS_ANON_SALT` 应分别使用随机值；推送需要自行生成 VAPID 密钥。不要使用线上密钥或线上数据，也不要提交 `.env.local`、`server/data/` 或包含个人信息的测试文件。

代码改动可以在 `server/` 目录运行 `npm run build`；无法本地运行时，也可以先提交 Pull Request，查看自动构建结果，再根据反馈修改。

项目的原创源代码采用 [MIT License](LICENSE)。提交 Pull Request 表示同意你的贡献按该许可证发布。
