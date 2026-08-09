-- Walking Skeleton 的最小 schema。
-- Step 2 会用 Alembic 迁移替代这里，并建出 DESIGN.md 里的全部业务表。
--
-- 注意：docker-entrypoint-initdb.d 里的脚本**只在数据卷为空时执行一次**。
-- 改了这个文件要生效，必须 `docker compose down -v` 清掉卷再起。

-- ---------------------------------------------------------------------------
-- sync_op：同步日志。既是幂等键的载体，也是全量审计轨迹。
-- ---------------------------------------------------------------------------
CREATE TABLE sync_op (
    -- 客户端生成的 UUID。幂等的全部秘密就在这一列上的主键约束。
    op_id       UUID        PRIMARY KEY,
    -- 服务端单调序号，客户端靠它拉增量（cursor）
    seq         BIGSERIAL   NOT NULL UNIQUE,
    client_id   TEXT        NOT NULL,
    entity      TEXT        NOT NULL,
    op_type     TEXT        NOT NULL,
    payload     JSONB       NOT NULL,
    -- 客户端本地递增序号，用于保证同一设备内的操作顺序
    client_seq  BIGINT      NOT NULL,
    -- 客户端时间：离线期间的真实发生时刻（不可信，仅作参考）
    client_ts   TIMESTAMPTZ NOT NULL,
    -- 服务端时间：权威时序，冲突解决以它为准
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 业务副作用已生效的时刻。NULL = 收到了但没应用成功
    applied_at  TIMESTAMPTZ
);

-- 增量拉取只关心已生效的记录
CREATE INDEX sync_op_applied_seq_idx ON sync_op (seq) WHERE applied_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ping_event：骨架期的假业务表，只为验证链路。Step 2 会被真实表替代。
-- ---------------------------------------------------------------------------
CREATE TABLE ping_event (
    id         BIGSERIAL   PRIMARY KEY,
    -- 第二道防线：即使 sync_op 的幂等判断被绕过，
    -- 这个 UNIQUE 约束仍然让重复写入在数据库层失败。
    op_id      UUID        NOT NULL UNIQUE REFERENCES sync_op(op_id) ON DELETE CASCADE,
    label      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
