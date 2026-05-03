# 闪传

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rain0002009/shan-chuan)

基于 Cloudflare Workers + Durable Objects + Vite + React 的匿名实时传输助手。

## 功能特性

- 无需登录，创建或加入房间后即可实时互传内容
- 支持文本、图片、文件实时传输
- 房主/加入者角色区分，在线人数实时刷新
- 房间有效期 1 小时，倒计时结束后房主可再次开启房间
- 单个文件大小限制为 8MB

## 技术栈

- Cloudflare Workers
- Cloudflare Durable Objects（单类多实例）
- React + Vite
- UnoCSS + ahooks
- TypeScript

## 本地开发

```bash
pnpm install
pnpm run dev
```

启动后访问：`http://127.0.0.1:8787`

## 检查与构建

```bash
pnpm run typecheck
pnpm run build:web
```

## 部署到 Cloudflare

```bash
pnpm dlx wrangler login
pnpm run deploy
```

`pnpm run deploy` 会先执行前端构建，再部署 Worker 与静态资源。

## 目录说明

- `src/index.ts`：Worker 路由与 API / WS 入口
- `src/room-durable-object.ts`：房间与房主锁状态（Durable Object）
- `src/shared.ts`：共享协议、类型与工具函数
- `web/src/App.tsx`：前端主逻辑与交互
- `web/src/styles.css`：样式
- `wrangler.toml`：Cloudflare 部署配置

## 运行说明

- 文件传输为实时转发，不做持久化存储
- 文本历史仅保留每个活跃房间最近 40 条
- 在免费额度场景下，建议保持单文件 8MB 以内
