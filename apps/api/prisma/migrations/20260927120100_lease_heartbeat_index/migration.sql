-- 后台在线列表按“近期有心跳”的连接查询（当前连接与近一天的最后心跳）。
-- 单独一个迁移、只有这一条语句：CONCURRENTLY 不能在事务里执行，建索引期间不阻塞租约的连接、心跳与撤销写入。
-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "NodeSessionLease_lastHeartbeatAt_idx" ON "NodeSessionLease"("lastHeartbeatAt");
