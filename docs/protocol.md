# 测速节点协议 v2

网页、控制接口与多个测速 origin 由同一个节点进程提供。所有测量响应禁用缓存、压缩和中间代理转换；不存在节点自动选择。错误响应使用 JSON，例如 {"error":"..."}，测量窗口结束的上传响应另外提供机器可读的 code。

## 配置

GET /api/config 返回 protocolVersion: 2、nodes、test、performance 和 features。nodes 首版只有一个节点，baseUrl 为空表示网页所在控制服务。

performance 的默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| measurementOrigins | 网页同主机的 8081–8084 origin | 独立 HTTP/1.1 数据连接池 |
| maxStreams | 24 | 实际部署支持的逻辑流数上限 |
| defaultMode | auto | 自动探测有效并发，可由用户改为 manual |
| downloadBlockBytes | 26214400 | 服务端共享 25 MiB 数据块 |
| uploadBlockBytes | 26214400 | 客户端随机 Blob 基块 |
| maxUploadBodyBytes | 1073741824 | 会话中每个请求体最多 1 GiB |

test 提供 downloadDurationMs、uploadDurationMs（默认各 10000）、warmupMs（默认 1500）、minStreams（2）、maxStreams（24）和 pingSamples（8）。预热与测量窗口独立；客户端根据 HTTP RTT 延长预热，最大 10 秒。

HTTP/1.1 每个专用数据 origin 最多分配 6 路请求。混合使用控制 origin 时，该 origin 最多分配 4 路，为延迟和上传进度保留连接。客户端按 origin 去重、按容量分配，不能将不同路径当作不同 TCP 连接池。

## 延迟

GET /api/ping?nonce=<unique>

返回 nodeId 和 RFC3339 serverTime。客户端用单调时钟计算完整 HTTP 响应的往返时间，不使用客户端与服务器墙上时钟差值。

## 持续下载

GET /api/download?stream=1&run=<opaque-id>&nonce=<unique>

返回持续的 application/octet-stream 响应，Content-Encoding: identity，不设置 Content-Length。HTTP/1.1 使用分块编码，服务器重复输出共享的 25 MiB 随机缓存，直到客户端取消或达到传输超时。

客户端在 Worker 中持续读取并丢弃数据，只计入统一测量窗口内实际读取的字节。所有并发流共享同一窗口，结束时取消；不在每个 25 MiB 块后重新发起 HTTP 请求。

有限长度诊断接口仍支持 GET /api/download?bytes=N，默认 8 MiB，允许 1–64 MiB，返回准确 Content-Length。非法或重复 bytes 参数返回 400。

## 服务端上传计量

1. POST /api/upload-sessions，JSON 请求体包含 warmupMs 和 durationMs。返回 201 和会话快照，其中 id 是临时测量标识。
2. 向数据 origin 发送 POST /api/upload?session=<id>&nonce=<unique>，请求体为原始二进制数据，单请求最多 1 GiB。浏览器由不可变 Blob 引用组合请求体，不使用 Base64 或 multipart。
3. 在控制 origin 轮询 GET /api/upload-sessions/<id>。服务端窗口从首次读取到正数字节时开始，在预热后按单调时钟统计收到的字节。
4. 快照 finished 为 true 时，以冻结的服务端 measuredBytes / measurementElapsedMs 计算最终上传速度，取消剩余请求并 DELETE /api/upload-sessions/<id> 清理会话。

快照包含：

| 字段 | 含义 |
| --- | --- |
| id、started、finished | 会话标识及窗口状态 |
| measuredBytes、totalBytes | 窗口内接收字节及含预热的总接收字节 |
| measurementElapsedMs、durationMs、warmupMs | 服务端测量时长及设置 |
| mbps | 服务端实际字节计算的当前速率 |
| activeRequests | 活跃传输请求数 |
| activeTcpConnections、peakTcpConnections | 服务端活跃及峰值 TCP 连接数 |
| connectionsObserved、protocols、scope | 累计观测连接、HTTP 协议及观测范围 |

服务端流式读取，采用 64 KiB 缓冲池和原子计数，不保存整块请求体。窗口边界精度受每条请求最后一次读缓冲影响。最终状态使用同步屏障冻结，不会在完成后继续增加。

上传外层 Blob 不设置 Content-Type，浏览器直接发送简单 CORS POST，避免每个大块请求都产生预检 RTT。数据仍为原始二进制，服务端不做文本转换。完整请求接收后返回 bytes、durationMs 确认；实际上传速度不依赖等待这些确认。

窗口已完成但请求体尚未完整接收时返回 409：

    {"error":"upload measurement window is complete; body was not fully consumed","code":"session_finished"}

这表示正常窗口截止，不是成功接收整块请求体。未知或过期会话返回 404，超限请求体返回 413。会话默认最多 256 个，TTL 为 90 秒，取消和退出清理活动请求。

无 session 的 POST /api/upload 仍可用于诊断，最大 64 MiB，并仅在完整接收后确认字节。

## TCP 观测

GET /api/connection-stats?run=<download-run-id>

返回该次持续下载的 activeRequests、activeTcpConnections、peakTcpConnections、connectionsObserved、protocols 和 scope。响应头也提供 X-Test-Connection-ID、X-Test-Protocol，跨 origin 的 CORS 响应显式暴露这些头。

连接 ID 来自 Go 接收连接的 ConnContext，同一 HTTP/2 TCP 上的多条请求只计为一条 TCP。累计 ID 数不等于同时活跃连接数。scope: server 表示服务端观测：经过反向代理时是代理上游连接，不能称为浏览器到代理的 TCP 数量。

## 健康、CORS 与边界

- GET /healthz 返回 status: ok 和 nodeId。
- 网页端口提供控制接口；数据端口固定 HTTP/1.1，只提供测量接口。
- 跨 origin 请求只允许规范化的网页 origin；PUBLIC_ORIGIN 和 MEASUREMENT_ORIGINS 可显式配置公开地址。CSP 同时限制页面和 Worker 的连接目标。
- 方法不匹配返回 405，未知 API 返回 404；不会返回网页代替错误。
- 默认活跃传输总上限 128，繁忙返回 503 和 Retry-After: 1，控制与健康接口不占这些名额。
- 响应采用 Cache-Control: no-store, no-cache, must-revalidate, no-transform。
- 传输硬超时为 90 秒；测量时长 1–60 秒，预热 0–10 秒，短期状态有数量与 TTL 上限。

后续多节点实现必须保持字节计数、单调时钟窗口及错误语义一致。多端口只是同节点连接池，节点发现和选择属于后续配置层。
