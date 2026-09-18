# 微软中国员工工具箱

一个面向微软中国员工及校友的非官方工具箱，涵盖福利清单、发薪日、薪资参考和离职补偿计算。在线版本：[wzkiwi.com/benefits/ms](https://wzkiwi.com/benefits/ms/)。本仓库是该页面的独立静态前端源码。

## 包含什么

- 离职前需要检查的福利清单，可按优先级和类别筛选
- 发薪日与节假日提示
- 各职级薪资参考（聚合数据需要后端接口）
- 离职补偿和未休假期折算计算器
- 可安装的 PWA 页面与离线缓存

## 静态与服务端功能

本仓库是**静态前端**，不是完整的线上系统。页面的 HTML、样式和主要计算逻辑在浏览器运行；线上版还连接 TechFlow 的服务端接口。

| 功能 | 仅托管本仓库时 |
|---|---|
| 福利清单、筛选、发薪日、假期、股票区间、离职补偿与未休假计算 | 可用，数据和计算逻辑写在 `index.html` 中 |
| PWA 安装与页面离线缓存 | HTTPS 或 localhost 下可用；首次加载仍需网络取得 CDN 资源 |
| 补充福利信息 | 需要 `POST /api/benefits`，静态托管无法提交 |
| 薪资 midpoint 聚合表及匿名提交 | 需要 `GET/POST /api/compensation`，静态托管无法读取或提交 |
| 老板避雷榜 | 需要 `/api/boss`，静态托管时保持隐藏 |
| 访问统计 | 需要 `/api/stats`，静态托管时不会记录 |
| 发薪日推送提醒 | 需要 `/api/push`、VAPID 密钥和定时发送任务；仅有 Service Worker 不会发送提醒 |

服务端接口及用户数据**没有**包含在本仓库。页面会向部署站点自身的 `/api/*` 请求，不会向原站点提交数据。若需复刻线上全部功能，还需单独部署上述接口和定时任务。静态资源依赖 Tailwind CSS、QRCode.js 和 Google Fonts 的外部 CDN。

## 本地运行

无需构建。用任意静态服务器托管仓库根目录，例如：

```bash
python -m http.server 8000
```

打开 `http://localhost:8000/`。不要直接用 `file://` 打开，Service Worker 需要 HTTP 或 HTTPS。

## 部署

把仓库根目录的 `index.html`、`manifest.webmanifest`、`sw.js` 和两个 SVG 图标放到同一个 URL 目录。页面和 PWA 资源使用相对路径，可部署在域名根路径或子路径。CDN 上的 Tailwind CSS、QRCode.js 和 Google Fonts 需要联网加载。

上述服务端功能需要另行部署；仅上传静态文件即可运行清单与计算器。主仓库中的 PNG 截图、`home.html` 和 nginx 配置未被此页面引用，因此未包含在静态发布包中。

## 更新源码

此仓库由 TechFlow 主仓库中的 `deploy/benefits-standalone/` 导出。导出脚本位于主仓库的 `scripts/export-benefits-open-source.py`。请在主仓库修改后重新导出并同步此仓库。

## 说明

这是非官方社区整理内容，不代表微软或其人力资源部门。福利、劳动规则和软件许可可能因地区、雇佣合同及时间变化而不同。办理前请以公司正式政策、当地规定和个人协议为准。Microsoft 及相关标志归其权利人所有。

## 许可证

源代码按 [MIT License](LICENSE) 发布。外部链接、第三方服务和商标不包含在授权范围内。