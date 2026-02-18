# 闪传

基于 Cloudflare Workers + Durable Objects + Vite + React 的匿名实时传输助手。

Features:
- share text in real-time
- share images and files in real-time
- no login required
- modern colorful single-page UI

## 本地运行

```bash
pnpm install
pnpm run dev
```

打开 `http://127.0.0.1:8787`。

## 部署到 Cloudflare（免费账户）

```bash
pnpm dlx wrangler login
pnpm run deploy
```

`pnpm run deploy` 会先执行前端构建（Vite），再部署 Worker 与静态资源。

## 说明

- file limit is set to 8 MB per file for reliability on free-tier limits
- text history keeps the latest 40 text messages in memory per active room
- file transfers are real-time only and not persisted
