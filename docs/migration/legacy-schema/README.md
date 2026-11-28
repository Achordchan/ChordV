# 旧 Prisma 结构快照

这里只保留两个逐字节归档的旧结构资料，扩展名为 `.snapshot`，不属于工作区、构建入口或数据库迁移源，不运行 Prisma generator、seed 或 db-push：

| 文件 | 原位置 | SHA256 |
| --- | --- | --- |
| `schema.prisma.snapshot` | `apps/api/prisma/schema.prisma` | `3c368f9edfd2ab99ad50e8fb101bbf862fba11853fde4af2f75cc3be4a00e0f2` |
| `schema.init.prisma.snapshot` | `apps/api/prisma/schema.init.prisma` | `65d0ce6c40955a82ede84a779c4869f999edacc5495bbda072c818e72857ea7f` |

唯一可执行迁移源是 `apps/server/internal/database/migrations/`。旧 27 份 SQL 已与原迁移逐字节核对后去重；Go 新增迁移单独保存。旧库接管使用 Go 内嵌的真实系统目录契约 `contracts/legacy-prisma.json`，不读取本目录的快照，不能把快照文件交给旧脚本自动基线。

原文件仍可从 Git 历史追溯；精确清理路径、源文件 hash 和保留范围见 `../legacy-backend-cleanup.json`。本轮没有操作生产数据库。
