# 迁移前部署资料

本目录是旧 Node/NestJS 服务、Prisma 和 Docker Compose 的历史部署实现，不是当前 MyGo/Go 服务的部署入口。保留文件用于核对尚未改动的线上版本；本次重构不运行这些脚本，也不将其打入新的 Go 服务端发布包。

当前本地启动、构建和测试入口见仓库根 README；Go 服务配置见 `apps/server/README.md`，发布协议见 `docs/migration/github-releases.md`。新服务端包包含 Go 二进制、管理后台静态资源、数据库迁移和显式配置说明，不依赖本目录的 Node 入口或后台发布中心。

本地验收不代表已迁移生产环境；现有线上服务、数据库和面板配置保持原状。
