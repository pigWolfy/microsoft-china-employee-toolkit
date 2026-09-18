# 微软中国离职福利清单

一个面向微软中国员工的非官方离职清单和计算工具。在线版本：[wzkiwi.com/benefits/ms](https://wzkiwi.com/benefits/ms/)。本仓库是该页面的独立静态前端源码。

## 包含什么

- 离职前需要检查的福利清单，可按优先级和类别筛选
- 发薪日与节假日提示
- 离职补偿和未休假期折算计算器
- 可安装的 PWA 页面与离线缓存

## 本地运行

无需构建。用任意静态服务器托管仓库根目录，例如：

```bash
python -m http.server 8000
```

打开 `http://localhost:8000/`。不要直接用 `file://` 打开，Service Worker 需要 HTTP 或 HTTPS。

## 部署

把仓库根目录的 `index.html`、`manifest.webmanifest`、`sw.js` 和两个 SVG 图标放到同一个 URL 目录。页面和 PWA 资源使用相对路径，可部署在域名根路径或子路径。CDN 上的 Tailwind CSS、QRCode.js 和 Google Fonts 需要联网加载。

页面中原有的匿名数据提交、统计和推送提醒需要同源的 `/api/benefits`、`/api/compensation`、`/api/boss`、`/api/stats`、`/api/push` 接口。此静态仓库没有这些服务，静态部署时相应功能无法使用，清单和本地计算器仍可使用。副本不会向原站点提交数据。

## 更新源码

此仓库由 TechFlow 主仓库中的 `deploy/benefits-standalone/` 导出。导出脚本位于主仓库的 `scripts/export-benefits-open-source.py`。请在主仓库修改后重新导出并同步此仓库。

## 说明

这是非官方社区整理内容，不代表微软或其人力资源部门。福利、劳动规则和软件许可可能因地区、雇佣合同及时间变化而不同。办理前请以公司正式政策、当地规定和个人协议为准。Microsoft 及相关标志归其权利人所有。

## 许可证

源代码按 [MIT License](LICENSE) 发布。外部链接、第三方服务和商标不包含在授权范围内。