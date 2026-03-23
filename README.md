# ChordV

ChordV 是一个面向自有订阅体系的代理平台单仓工程，当前包含：
- 运营后台
- API 服务端
- mac / Windows / Android 客户端
- 3x-ui 面板接入
- 发布中心与版本更新检查

## 一、项目结构

- `apps/api`：NestJS 业务 API，负责认证、订阅、节点、团队、计量、发布中心等主业务。
- `apps/admin`：React 运营后台，负责用户、订阅、节点、策略、发布中心等管理功能。
- `apps/desktop`：Tauri + React 客户端，当前覆盖 mac、Windows，并包含 Android 工程骨架与调试链。
- `apps/edge-gateway`：旧中心中转链路相关代码，当前主模式不是它。
- `packages/shared`：共享 DTO、枚举、版本检查类型、运行时类型。

## 二、当前接入模式

当前主模式是：
- `3x-ui 直连`

保留备用模式：
- `中心中转`

当前计量原则：
- 字节权威来源：`3x-ui / Xray client 累计流量`
- 到期、套餐状态、权限控制：`ChordV 中心控制`

## 三、本地开发启动

### 1. 初始化

```bash
pnpm setup:mac
```

它会完成：
- 安装依赖
- 准备数据库
- 生成 Prisma
- 下载桌面端所需 `xray`

### 2. 启动后台整套

```bash
pnpm dev:ops
```

会启动：
- API
- 后台前端
- 开发期需要的配套服务

### 3. 启动桌面端

mac：

```bash
pnpm dev:mac
```

桌面前端单独开发：

```bash
pnpm dev:desktop
```

## 四、环境变量

常用环境变量如下：

- `CHORDV_API_PORT`
  API 端口，默认 `3000`
- `CHORDV_API_BASE_URL`
  前端请求的 API 地址
- `CHORDV_JWT_SECRET`
  JWT 密钥，生产必须配置
- `DATABASE_URL`
  PostgreSQL 连接串
- `CHORDV_PUBLIC_BASE_URL`
  对外公开域名，例如 `https://v.baymaxgroup.com`
- `CHORDV_RELEASE_STORAGE_ROOT`
  发布中心安装包存储目录，例如 `/www/wwwroot/chordv/releases`
- `CHORDV_RELEASE_MAX_UPLOAD_BYTES`
  发布中心单文件最大上传字节数
- `CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS`
  心跳兜底周期
- `CHORDV_SESSION_GRACE_SECONDS`
  会话失联后的宽限时间

## 五、桌面端版本体系

桌面端版本号现在已经**按平台独立**，不再让 mac / Windows / Android 共用一个字段。

版本配置文件：

[/Users/achordchan/Downloads/不同步的桌面/项目/ChordV/apps/desktop/config/platform-versions.json](/Users/achordchan/Downloads/不同步的桌面/项目/ChordV/apps/desktop/config/platform-versions.json)

例如：
- `macos`
- `windows`
- `android`
- `ios`

这意味着：
- 你可以单独发布 `mac 1.0.2`
- 同时保持 `windows = 1.0.2`
- 不会再出现“只改了 mac，Windows 版本判断也被带歪”的问题

### 版本规则

未来版本号，**除非有特殊要求，一律使用第三位递增**，例如：

- `1.0.1`
- `1.0.2`
- `1.0.3`

默认只使用正式版版本号，不再保留测试渠道和相关文案。

## 六、桌面端打包

### 1. 按平台读取版本

```bash
pnpm --filter @chordv/desktop version:platform macos
pnpm --filter @chordv/desktop version:platform windows
pnpm --filter @chordv/desktop version:platform android
```

### 2. 按平台打包桌面端

mac：

```bash
pnpm --filter @chordv/desktop tauri:build:platform macos
```

Windows：

```bash
pnpm --filter @chordv/desktop tauri:build:platform windows
```

说明：
- 打包脚本会按平台自动读取对应版本号
- 不会再共用一个桌面版本号

### 3. 产物目录

交付目录：

- mac：`output/release/macos`
- Windows：`output/release/windows`
- Android：`output/release/android`

## 七、Android 调试

```bash
pnpm --filter @chordv/desktop android:doctor
pnpm --filter @chordv/desktop android:build
pnpm --filter @chordv/desktop android:install -- --launch
pnpm --filter @chordv/desktop android:logcat -- --clear
pnpm --filter @chordv/desktop android:smoke
```

用途：
- `android:doctor`：检查 JDK、SDK、NDK、adb、真机
- `android:build`：构建 arm64 调试包
- `android:install`：安装到手机
- `android:logcat`：过滤 Android 运行时日志
- `android:smoke`：输出真机联调步骤

## 八、发布中心

当前发布中心已经支持：
- 创建发布记录
- 按平台和渠道管理版本
- 上传安装包
- 自动生成下载地址
- 自动计算文件大小
- 自动计算 `SHA-256`
- 发布前校验主下载产物是否可用
- 客户端应用内检查更新

当前不做：
- 增量更新
- 静默自动安装
- 前端热更新
- Android AAB 自分发更新
- iOS 内置更新

### 当前更新策略

#### mac / Windows
- 应用内检查更新
- 展示更新日志
- 下载完整安装包
- 用户手动安装

#### Android
- 应用内检查更新
- 下载或跳转 APK
- 用户手动安装

#### iOS
- 只保留版本提示和下载说明占位

## 九、发布中心服务器落地

推荐服务器变量：

```bash
CHORDV_PUBLIC_BASE_URL=https://v.baymaxgroup.com
CHORDV_RELEASE_STORAGE_ROOT=/www/wwwroot/chordv/releases
CHORDV_RELEASE_MAX_UPLOAD_BYTES=1073741824
```

推荐先准备发布目录：

```bash
pnpm prepare:release-storage /你的发布目录
```

例如：

```bash
pnpm prepare:release-storage /www/wwwroot/chordv/releases
```

推荐目录结构：
- 代码目录：`/www/wwwroot/chordv/current`
- 发布目录：`/www/wwwroot/chordv/releases`

不要把安装包放进 `current`，避免发版覆盖时误删。

## 十、交付与测试建议

正式交付前至少要确认：

### mac
- 登录
- 拉节点
- 连接 / 断开
- 后台立即断网
- 取消节点授权
- 到期
- 流量耗尽
- 关闭窗口后隐藏，不直接退出

### Windows
- 安装
- 登录
- 连接 / 断开
- 不弹黑窗
- 能真实上网
- 断开后系统代理恢复
- 后台强制事件断开

### Android
- 安装 APK
- 登录
- 连接
- 断开
- 后台强制事件
- VPN 回收

## 十一、当前实现边界

当前已经完成的重点能力：
- 3x-ui 主模式
- 团队共享计量
- 节点 client 生命周期控制
- 桌面端强制事件断开
- 发布中心
- 平台独立版本号

当前仍属于后续持续打磨项：
- Android 真机稳定性继续联调
- iOS 原生运行时
- 更完整的下载器
- 发布中心文件上传体验优化
- 多平台更细的设置项
