# 服务端运行说明

这个目录是独立的 Next.js 16 服务。`npm run dev` 和 `npm run build` 会先将仓库根目录的静态页面复制到 `public/`；根路由返回该页面，五组接口使用同一域名下的 `/api/*`。

## 配置

复制 `.env.example` 为 `.env.local` 后填写。真实值只存本机或部署平台的密钥配置中。

| 变量 | 用途 |
|---|---|
| `ADMIN_TOKEN` | 管理员查看原始投稿、薪资样本、统计及治理避雷榜；不配置则所有管理操作拒绝访问 |
| `BOSS_ANON_SALT` | 匿名评分指纹的随机盐；不配置则评分写入返回 503 |
| `BOSS_PUBLIC` | `1` 开放避雷榜读写；默认私有，需管理员 token |
| `BENEFITS_DATA_DIR` | JSONL 数据目录；本地默认 `server/data`，生产环境应设为持久化绝对路径 |
| `FEEDBACK_WEBHOOK_URL` | 可选，收到福利建议时通知管理员 |
| `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` | Web Push 密钥；不配置则无法订阅和发送 |
| `VAPID_SUBJECT` | 发送方联系地址，例如 `mailto:you@example.com` |
| `PAGE_URL` | 推送通知打开的完整页面地址 |
| `SUBSCRIPTIONS_FILE` | 可选，覆盖推送任务读取的订阅文件；默认使用数据目录中的 `push-subscriptions.jsonl` |

管理员口令和匿名盐应分别生成随机值，例如运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。不要复用示例值，也不要把真实配置加入 Git。

## 接口与数据

| 接口 | 功能 | 数据文件 |
|---|---|---|
| `/api/benefits` | 匿名福利建议、管理员审核列表 | `benefits-suggestions.jsonl` |
| `/api/compensation` | 薪资 midpoint 聚合与匿名样本 | `ms-compensation.jsonl` |
| `/api/boss` | 老板避雷榜评分与治理 | `boss-ratings.jsonl` |
| `/api/stats` | 页面事件与管理统计 | `pageviews.jsonl`、`pwa-events.jsonl`、`ip-geo-cache.json` |
| `/api/push` | 推送订阅的增删与公钥 | `push-subscriptions.jsonl` |

这些文件会存储投稿、薪资样本、IP 或设备信息及推送订阅，必须放在私有持久化目录中，定期备份，不能提交到公开仓库。统计管理页可能调用 `ip-api.com` 解析 IP 地理信息。管理员访问目前使用 URL 中的 `token` 参数，部署时必须启用 HTTPS，并避免分享带 token 的链接。

## 发薪日推送

安装依赖：`npm ci`。在 `.env.local` 配好 VAPID 密钥、`VAPID_SUBJECT`、`PAGE_URL`，并让推送任务使用与接口相同的 `BENEFITS_DATA_DIR`。任务只会在命中提醒日时发送；每月发薪日按倒数第三个工作日计算，法定节假日以 HR 通知为准。

用 `PUSH_DRY=1` 和 `PUSH_FORCE=1` 可检查筛选逻辑而不发送通知。生产环境每天在 `Asia/Shanghai` 时区运行一次，例如：

```cron
TZ=Asia/Shanghai
0 9 * * * cd /opt/microsoft-china-employee-toolkit/server && /usr/bin/npm run send:payday
```

任务通过 `node --env-file=.env.local` 加载配置。部署时应确保该文件只对服务账号可读，或者用部署平台的环境变量并直接运行 `node scripts/send-payday.mjs`。

## 构建

```bash
npm ci
npm run build
npm start
```

部署时请把 `BENEFITS_DATA_DIR` 指向不随版本更新删除的目录。`server/public/` 是构建时复制的文件，不需要手动编辑。