# 测速节点协议 v2

网页、控制接口与测速连接由同一个节点进程提供。默认只需一个网页端口，传输采用 WebSocket，固定使用 8 路并发，用户可手动选择 1–30 路；HTTP 传输及额外数据端口作为可选配置保留。所有测量禁用压缩、缓存和中间代理转换；不存在节点自动选择。HTTP 错误响应使用 JSON，例如 {"error":"..."}，测量窗口结束的 HTTP 上传响应另外提供机器可读的 code。

## 配置

GET /api/config 返回 protocolVersion: 2、nodes、test、performance 和 features。nodes 首版只有一个节点，baseUrl 为空表示网页所在控制服务。

performance 的默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| transport | websocket | 默认 WebSocket；TEST_TRANSPORT=http 可选择 HTTP |
| measurementOrigins | 网页所在 origin | HTTP 可配置独立数据 origin；默认不要求额外端口 |
| defaultStreams | 8 | 默认固定并发数；不超过部署上限 |
| maxStreams | 30 | 部署允许的并发上限；HTTP 还受浏览器连接池容量限制 |
| defaultMode | manual | 固定用户选择的并发；auto 是可选模式 |
| downloadBlockBytes | 26214400 | 服务端共享 25 MiB 数据块 |
| uploadBlockBytes | 26214400 | 客户端随机 Blob 基块 |
| maxUploadBodyBytes | 1073741824 | 可选 HTTP 会话上传的单请求体上限；WebSocket 消息另有限制 |

test 提供 downloadDurationMs、uploadDurationMs（默认各 10000）、warmupMs（默认 1500）、minStreams（默认 8）、maxStreams（默认 30）和 pingSamples（8）。预热与测量窗口独立；客户端根据 HTTP RTT 延长预热，最大 10 秒。

WebSocket 使用 HTTP/1.1 连接升级，每路占用独立 TCP，不按普通 HTTP 请求的每 origin 6 路额度分配。可选 HTTP 模式下，每个专用数据 origin 最多分配 6 路请求；控制 origin 最多分配 4 路，为延迟和上传进度保留连接。HTTP 客户端按 origin 去重、按容量分配，不能将不同路径当作不同 TCP 连接池。

## 延迟

GET /api/ping?nonce=<unique>

返回 nodeId 和 RFC3339 serverTime。客户端用单调时钟计算完整 HTTP 响应的往返时间，不使用客户端与服务器墙上时钟差值。

## WebSocket 传输

同一个网页端口提供以下 HTTP/1.1 Upgrade 路径：

```text
GET /api/ws?direction=probe
GET /api/ws?direction=download&run=<opaque-id>
GET /api/ws?direction=upload&session=<upload-session-id>
```

升级后首先发送一条 text JSON，提供服务端接收连接的 ID 与协议：

```json
{"type":"ready","connectionId":"opaque-id","protocol":"HTTP/1.1"}
```

之后测量数据使用 binary 消息，不使用 Base64。WebSocket 不协商 permessage-deflate 压缩。浏览器 Origin 必须与网页 origin 一致；HTTPS 网页使用 wss，证书验证不能关闭。

`direction=probe` 发送 4 KiB（4096 字节）有限 binary 消息后，以正常关闭码 1000 结束连接。探测不带下载 run，不创建上传会话，其字节不计入正式测量。

客户端在空闲 RTT 取样结束后、正式窗口开始前进行这次 WebSocket 探测，超时根据 RTT 设置为 5–8 秒。无法确认 WebSocket 可用时，在本次测速开始前切换到下面的 HTTP 探测流程；默认只使用网页 origin 的 HTTP 回退最多 4 路。页面明确显示实际传输、并发上限及手动并发的调整，例如 8 路或 30 路调整为 4 路。原配置不被覆盖，下一次测速重新尝试 WebSocket；正式窗口中途不切换传输。

`direction=download` 从共享随机缓存连续发送数据，初始每条消息为 4 KiB。客户端可发送 text JSON `{"type":"resize","bytes":N}`，将后续消息调整为 1 KiB–1 MiB 范围内的 2 的幂。控制消息最多 4096 字节，字段及大小必须有效。浏览器只能在完整 WebSocket 消息到达后获得 message 事件，因此从小消息开始，而不是要求慢速链路先接收完整 1 MiB。正式下载只统计统一窗口内浏览器实际收到的 binary 字节。

`direction=upload` 使用控制接口创建的上传会话。服务端逐段读取 binary 消息并调用同一个会话计数器，64 KiB 读缓冲不要求整条消息已结束；单条上传消息最多 4 MiB。消息中只计实际读到的有效载荷字节，不计客户端排队量、WebSocket 帧头或掩码。上传类型必须为 binary。

客户端将一份不可变随机 Blob 切为 1 MiB 消息，并限制每条连接的 bufferedAmount 不超过 4 MiB。共享发送循环在提交数据后通过 MessageChannel 让出任务；没有发送空间时进行可取消的 2 ms 等待。排队量不表示服务端接收字节，也不包含全部操作系统缓冲。用户取消或上传出错时，先发起会话 DELETE，再等待连接清理，避免浏览器 close 握手排在尚未发送的数据之后而长时间等待。

上传窗口截止或会话删除会关闭关联 WebSocket，正常关闭码为 1000；服务器退出使用 1001。服务端显式管理升级后的连接，关闭时释放传输名额、TCP 统计及读处理，不依赖 net/http Shutdown 自动回收已经 Hijack 的连接。传输硬超时仍为 90 秒。

## HTTP 模式的连接探测与回退

取得空闲 HTTP RTT 后、正式下载和上传窗口开始前，客户端并行探测配置中的各个测量 origin：

`GET /api/download?bytes=16384&nonce=<unique>`

每次探测请求 16 KiB 有限长度响应，使用 `cache: no-store`，不带 `stream=1`，也不创建正式下载的 run 标识。响应必须成功、类型为 application/octet-stream、未声明非 identity 编码，并实际读到非空数据块；仅收到响应头或错误代理页面不足以确认可用。读到首个非空块后取消剩余响应并释放 reader，无需等待全部 16 KiB。超时根据空闲 RTT 设置，最短 1.5 秒、最长 8 秒；用户取消或设备离线时停止探测，不继续回退或开始测速。

所有探测结束后，客户端为本次测速确定传输来源与并发上限：

- 全部数据 origin 可用时，保留配置中的连接池；配置 8081–8084 四个数据端口时，支持最多 24 条 HTTP 测速流。
- 部分 origin 无法完成探测时，仅保留通过探测的 origin，并按每个独立数据 origin 6 路、控制 origin 4 路重新分配槽位。本次上限同时受原部署配置限制；剩余两个独立数据 origin 时最多 12 路。
- 全部独立数据 origin 不可用时，确认网页所在控制 origin 的同一有限长度下载接口可用。若该控制地址已在这轮探测中失败，不重复请求。通过后回退到控制 origin，本次最多 4 路，为延迟和上传会话轮询保留连接；主站下载接口也不可用时明确报错，不生成完整结果。

手动并发超过本次可用上限时会下调，并向页面提供原请求值与实际值，例如 24 路调整为 12 路或 4 路。自动模式也受本次可用上限限制。探测流量不进入正式测速字节计数；下载和上传使用确定后的同一组来源及各自的新测量窗口。正式测速中途不会再次切换来源或混合回退前后的字节。

探测结果只用于本次测速，不覆盖原始配置。下一次测速重新探测各个配置 origin，恢复可用的端口可重新提供相应容量。

## HTTP 持续下载

GET /api/download?stream=1&run=<opaque-id>&nonce=<unique>

返回持续的 application/octet-stream 响应，Content-Encoding: identity，不设置 Content-Length。HTTP/1.1 使用分块编码，服务器重复输出共享的 25 MiB 随机缓存，直到客户端取消或达到传输超时。

客户端在 Worker 中持续读取并丢弃数据，只计入统一测量窗口内实际读取的字节。所有并发流共享同一窗口，结束时取消；不在每个 25 MiB 块后重新发起 HTTP 请求。

有限长度诊断接口仍支持 GET /api/download?bytes=N，默认 8 MiB，允许 1–64 MiB，返回准确 Content-Length。非法或重复 bytes 参数返回 400。

## 服务端上传计量

1. POST /api/upload-sessions，JSON 请求体包含 warmupMs 和 durationMs。返回 201 和会话快照，其中 id 是临时测量标识。
2. 默认使用 /api/ws?direction=upload&session=<id> binary 消息传输。HTTP 模式向数据 origin 发送 POST /api/upload?session=<id>&nonce=<unique>，请求体为原始二进制数据，单请求最多 1 GiB。HTTP 请求体由不可变 Blob 引用组合，不使用 Base64 或 multipart。
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

HTTP 上传外层 Blob 不设置 Content-Type，浏览器直接发送简单 CORS POST，避免每个大块请求都产生预检 RTT。数据仍为原始二进制，服务端不做文本转换。完整 HTTP 请求接收后返回 bytes、durationMs 确认；实际上传速度不依赖等待这些确认。

HTTP 窗口已完成但请求体尚未完整接收时返回 409：

    {"error":"upload measurement window is complete; body was not fully consumed","code":"session_finished"}

这表示正常窗口截止，不是成功接收整块请求体。未知或过期会话返回 404，超限请求体返回 413。会话默认最多 256 个，TTL 为 90 秒，取消和退出清理活动请求。

无 session 的 POST /api/upload 仍可用于诊断，最大 64 MiB，并仅在完整接收后确认字节。

## TCP 观测

GET /api/connection-stats?run=<download-run-id>

返回该次 WebSocket 或 HTTP 下载的 activeRequests、activeTcpConnections、peakTcpConnections、connectionsObserved、protocols 和 scope。WebSocket 首条 ready JSON 提供 connectionId、protocol；HTTP 响应头提供 X-Test-Connection-ID、X-Test-Protocol，跨 origin 的 CORS 响应显式暴露这些头。

连接 ID 来自 Go 接收连接的 ConnContext。默认 HTTP/1.1 升级的每路 WebSocket 对应一条独立 TCP；可选 HTTP/2 上的多条普通 HTTP 请求只计为一条 TCP。累计 ID 数不等于同时活跃连接数。scope: server 表示服务端观测：经过反向代理时是代理上游连接，不能称为浏览器到代理的 TCP 数量。

单端口模式仍可并行处理多条测速请求，不表示单线程或单 TCP 连接。页面区分逻辑测速流数与服务端观测 TCP 数，并展示当前值与峰值，不能用配置的流数代替实际连接统计。

## 健康、CORS 与边界

- GET /healthz 返回 status: ok 和 nodeId。
- 网页端口提供控制接口及 WebSocket，默认不监听额外数据端口；显式配置的数据端口固定 HTTP/1.1，只提供 HTTP 测量接口。
- 跨 origin 请求只允许规范化的网页 origin；PUBLIC_ORIGIN 和 MEASUREMENT_ORIGINS 可显式配置公开地址。CSP 同时限制页面和 Worker 的连接目标。
- 方法不匹配返回 405，未知 API 返回 404；不会返回网页代替错误。
- 默认活跃传输总上限 128，繁忙返回 503 和 Retry-After: 1，控制与健康接口不占这些名额。
- 响应采用 Cache-Control: no-store, no-cache, must-revalidate, no-transform。
- 传输硬超时为 90 秒；测量时长 1–60 秒，预热 0–10 秒，短期状态有数量与 TTL 上限。

后续多节点实现必须保持字节计数、单调时钟窗口及错误语义一致。多端口只是同节点连接池，节点发现和选择属于后续配置层。
