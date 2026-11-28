# 本机 HTTP 图床夹具

`image-provider.mjs` 只供测试导入，不接生产配置、不启动数据库或主 QA 服务。监听固定为 `127.0.0.1`，默认使用随机端口；图片仅存内存，单张限 10 MiB、总计限 32 MiB 和 100 张，停止时取消延迟、断开连接并清空文件。

```js
import { createImageProvider } from "./image-provider.mjs";
const provider = await createImageProvider();
try {
  const config = provider.getConfig(); // baseUrl、apiToken、uploadFolder
  // 只交给独立测试 API 配置或权限 0600 的临时文件，不打印 config/credentials。
  await provider.setMode("http503");
  await provider.setMode("timeout", { delayMs: 30000 });
  await provider.setMode("success");
  const state = provider.snapshot(); // 不含凭据，可核对文件、计数、延迟状态。
} finally {
  await provider.stop();
}
```

导出接口：`createImageProvider({port=0,mode="success",delayMs=30000})` 返回 `origin`、`credentials={apiToken,controlToken}`、`getConfig()`、`setMode(mode,{delayMs}?)`、`snapshot()`、`events` 和幂等 `stop()`。通过 `events` 的 `change` 事件等待上传/删除/延迟状态，避免轮询。模式别名 `http_503`、`delay` 分别对应 `http503`、`timeout`；timeout 表示延迟后成功，超过调用方超时才产生真实超时，默认 30 秒大于 Go 图床请求的 20 秒超时。

- `POST /upload?returnFormat=full&uploadFolder=e2e`：Bearer `apiToken`，真实 multipart，唯一文件字段 `file`，仅接收 PNG 实际字节；文件 part 类型接受浏览器的 `image/png` 和 Go `CreateFormFile` 默认的 `application/octet-stream`。原始文件字节保留，响应 `{success:true,url:"/file/e2e/<随机前缀>-<原文件名>"}`。
- `GET /api/manage/list`：Bearer `apiToken`，支持 `search`、`dir`、`recursive`、`start`、`count`，返回 Go 管理接口所需文件元数据。`GET` 或 `DELETE /api/manage/delete/<文件路径>` 删除文件；`?folder=true` 删除指定目录内文件，缺失返回 404。
- `GET /file/<文件路径>`：不要求令牌，供浏览器 `<img>` 直接显示；随机文件路径、仅本机访问，不对外托管。`GET/POST /__test/control` 仅在本测试夹具中存在，使用独立 Bearer `controlToken` 读取状态或写入 `{mode,delayMs}`，不能用图床 API 令牌控制。

运行 `node --test tests/e2e/image-provider.test.mjs` 验证真实 HTTP 上传、PNG 字节/CRC/解压、鉴权、搜索、删除、503、延迟、取消、超时、路径拒绝和停止清理。夹具自测通过只证明测试站点自身可用，不代表后台 UI 或生产图床已验收。
