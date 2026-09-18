# 微软中国员工工具箱

面向微软中国员工及校友的非官方工具箱，汇集福利清单、发薪日、薪资参考和离职补偿计算。线上页面：[wzkiwi.com/benefits/ms](https://wzkiwi.com/benefits/ms/)。本项目与微软没有官方关联。

## 功能

- 福利清单、优先级与类别筛选
- 发薪日、假期和股票区间参考
- 离职补偿与未休假折算计算器
- 匿名福利建议、薪资 midpoint 样本、老板避雷榜
- 页面统计和发薪日 Web Push 提醒

## 完整本地运行

需要 Node.js 20.9+。服务端会从仓库根目录同步静态文件，页面与 `/api/*` 接口在同一个地址运行。

```bash
cd server
npm ci
cp .env.example .env.local
# 在 .env.local 中配置 ADMIN_TOKEN、BOSS_ANON_SALT 等变量
npm run dev
```

打开 `http://localhost:3000/`。生产构建使用 `npm run build` 和 `npm start`。配置、接口、数据目录和推送任务详见 [服务端说明](server/README.md)。

没有配置管理员口令时，管理接口会拒绝访问；没有配置 VAPID 密钥时，推送订阅不可用。请勿把 `.env.local` 或 `server/data/` 提交到 Git。

## 仅托管静态页面

仓库根目录的 `index.html`、`sw.js`、`manifest.webmanifest` 和两个 SVG 图标可由任意静态服务器托管；例如在仓库根目录运行 `python -m http.server 8000`。此模式可使用清单、发薪日和本地计算器，但投稿、薪资样本、避雷榜、统计和推送提醒需要服务端。PWA 需要 HTTPS 或 localhost。首次加载的 Tailwind CSS、QRCode.js 和 Google Fonts 来自外部 CDN。

页面请求部署站点自身的 `/api/*`，不会向原站点发送用户提交的数据。原项目中的 PNG 截图、`home.html` 和 nginx 配置不被此页面引用，因此不在运行包中。

## 目录

| 路径 | 用途 |
|---|---|
| `index.html`、`sw.js`、`manifest.webmanifest`、`icon*.svg` | 静态页面与 PWA |
| `server/src/app/api/` | 页面使用的五组 Next.js 接口 |
| `server/scripts/send-payday.mjs` | 每日运行的推送任务 |
| `server/data/` | 本地 JSONL 数据，已忽略，不随源码发布 |

页面从 TechFlow 主仓库的 `deploy/benefits-standalone/` 导出。主仓库的 `scripts/export-benefits-open-source.py` 用于同步静态文件；服务端可独立运行，不连接原站点的数据目录。

## 说明与许可证

本内容由社区整理，仅供参考。福利、劳动规则和许可条款可能因地区、雇佣合同与时间而变化，请以正式政策和个人协议为准。Microsoft 及相关标志归其权利人所有。

原创源代码按 [MIT License](LICENSE) 发布；外部链接、第三方服务和商标不包含在授权范围内。