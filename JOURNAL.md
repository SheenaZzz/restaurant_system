# 工程日志

> **每天记，事后补是编不出来的。** 这份日志是 deep dive 的全部弹药 ——
> 面试里最强的回答永远是「我量到了 X，所以改成了 Y，结果变成 Z」。

三类条目，按需记：

- **决策** — 选了什么 / 否掉了什么 / 为什么 / 代价
- **测量** — 改动前后的具体数字
- **故障** — 现象 / 我的错误假设 / 怎么定位 / 根因

---

## 2026-08-08 — Step 0 环境搭建

**决策：项目移出 OneDrive 同步目录**
- 选了 `C:\Users\Welcome\dev\restaurant_system`，否掉了 `Desktop`（OneDrive 同步）
- 原因：`node_modules` 有数万个小文件，OneDrive 实时同步会拖慢构建、锁文件、偶发损坏；
  `.gitignore` 管不了 OneDrive
- 代价：不再自动云备份 → 靠 git remote 兜底

**决策：Docker Desktop 而非原生 Postgres**
- 原因：生产环境（店内 Ubuntu 主机）用 Docker Compose，本地保持一致，避免"我本地能跑"
- 代价：Windows 上要走 WSL2，安装较重

**故障：以为 Docker 装失败了**
- 现象：`C:\Program Files\Docker` 不存在，`docker` 命令 not found
- 错误假设：安装器失败了
- 定位：读 `%LOCALAPPDATA%\Docker\install-log.txt`，末行是 `Installation succeeded`
- 根因：Docker Desktop 4.85 默认改为**用户级安装**，装到
  `%LOCALAPPDATA%\Programs\DockerDesktop`；且 PATH 变更不会作用于已打开的终端
- 教训：**先读安装日志再下结论**

---

## 模板

```
## YYYY-MM-DD — Step N 主题

**决策：**
- 选了 / 否掉了 / 为什么 / 代价

**测量：**
- 指标：改前 → 改后

**故障：**
- 现象 / 错误假设 / 定位过程 / 根因
```
