# ChordV 发布中心服务器接入清单

这份清单只用于服务器落地，不代表要立刻执行。

## 1. 目录准备

推荐目录：

```bash
/www/wwwroot/chordv/current
/www/wwwroot/chordv/releases
```

- `current` 放代码
- `releases` 放发布中心安装包
- 两者必须分开

可先在服务器执行：

```bash
cd /www/wwwroot/chordv/current
pnpm prepare:release-storage /www/wwwroot/chordv/releases
```

## 2. API 环境变量

服务器上 API 至少要补这 3 个变量：

```bash
CHORDV_PUBLIC_BASE_URL=https://v.baymaxgroup.com
CHORDV_RELEASE_STORAGE_ROOT=/www/wwwroot/chordv/releases
CHORDV_RELEASE_MAX_UPLOAD_BYTES=1073741824
```

说明：
- `CHORDV_PUBLIC_BASE_URL` 用来生成安装包下载地址
- `CHORDV_RELEASE_STORAGE_ROOT` 是安装包真实落盘目录
- `CHORDV_RELEASE_MAX_UPLOAD_BYTES` 是后台单文件上传上限

## 3. 路由要求

继续沿用同域名：

- `/`：后台前端
- `/api/*`：Node API
- `/api/downloads/releases/:artifactId`：安装包下载

第一版不要把 `releases` 目录直接暴露成静态目录，仍然走 API 下载。

## 4. 发布前检查

后台发布中心在正式发布前，至少要确认：

1. 已经上传安装包或配置外链
2. 点击“校验安装包”显示 `可发布`
3. 点击下载地址能正常下载
4. 主下载产物是正确的平台文件

## 5. 安全上线原则

不要再用粗暴整包覆盖的方式。

建议顺序：

1. 备份线上 `.env`
2. 备份 PM2 配置
3. 准备 `releases` 目录
4. 更新 API 与后台前端
5. 需要时执行 `pnpm --filter @chordv/api db:push`
6. 平滑重启 API
7. 再人工检查发布中心页面和下载链路
