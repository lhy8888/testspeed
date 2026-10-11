# 协议 v2 验证结果

2026-10-11 在当前 Linux 云环境完成以下验证。运行时为 Go 1.27.2、Node.js 26.11.1；Playwright 使用 Chromium 154。实例有 5 个可用 CPU 核心，最终容器为 `testspeed-testspeed-1`，镜像 ID 前缀 `9fe4dede`。

## 自动检查

- `go test -race ./...`：通过。覆盖持续下载与取消、上传进行中实际字节计数、24 路读者的最终结果冻结、会话清理与容量限制、真实 TCP / HTTP 流统计、CORS、配置边界和 IPv6 origin。
- `go vet ./...`：通过。
- `node --test tests/*.test.mjs`：22 项全部通过，未跳过。覆盖统一计时窗口、RTT/BDP、自动并发回退、origin 连接池容量、重复 Blob 引用、预热、部分传输失败、取消与 Worker 代际隔离。
- 新增小数 RTT 回归：300.123 ms 延迟产生整数毫秒预热，满足后端上传会话 JSON 契约。真实 300 ms 浏览器验证曾发现该问题，取整修复已部署并复测通过。

## 实际浏览器流程与 TCP

`tests/browser-smoke.mjs` 对运行中的服务执行默认完整窗口测速，验证逻辑流和服务端观测 TCP 峰值一致，完成后两者活跃数归零。

| 手动测速流 | 下载 | 上传 | 服务端 TCP 峰值 |
| ---: | ---: | ---: | ---: |
| 1 | 7.98 Gbps | 7.34 Gbps | 1 |
| 4 | 8.51 Gbps | 6.56 Gbps | 4 |
| 12 | 8.65 Gbps | 7.49 Gbps | 12 |
| 24 | 9.22 Gbps | 7.28 Gbps | 24 |

以上为云实例回环路径，不是物理网卡或公网容量。320 像素手机视口完整测速、上传停止与重试通过，页面无横向溢出。

还验证了上传会话删除后返回 404、持续下载退出释放计数、停止后无继续传输、503 后完整重试、真实浏览器离线事件取消、配置 503 和延迟重连的取消、无缓存/无压缩及唯一请求地址。页面无未捕获 JavaScript 异常。Headless Chromium 切换标签不会隐藏原页面，因此后台取消通过显式设置 hidden 并触发 visibilitychange 验证；这不是浏览器原生切换标签覆盖。

## 限速与高 HTTP RTT

`tests/browser-accuracy.mjs` 使用 Chromium CDP 对实际 Worker HTTP 流量设置共享限速预算，数据连接没有按 origin 倍增预算。独立网络接收事件用于交叉检查下载量。每个阶段测量 10 秒，预热至少 1.5 秒，并随 RTT 增加。

| CDP 下载 / 上传预算 | HTTP 延迟模型 | 页面下载 | 页面上传 | 空闲 HTTP RTT |
| --- | ---: | ---: | ---: | ---: |
| 20 / 10 Mbps | 80 ms | 19.965 Mbps | 9.988 Mbps | 83.2 ms |
| 1 / 1 Gbps | 150 ms | 898.38 Mbps | 958.71 Mbps | 153 ms |
| 1 / 1 Gbps | 300 ms | 883.63 Mbps | 959.60 Mbps | 304 ms |

300 ms 场景耗时 30.467 秒，下载/上传负载 HTTP RTT 为 306/303 ms，TCP 峰值 8，结束时活跃数 0。独立网络事件计算下载为 865.41 Mbps；其事件交付与计时边界不同于 Worker 读取窗口，因此不能要求逐字节结果相同。

上传按服务器在窗口内收到的字节计量，不依赖整个 1 GiB 请求体确认，也不计浏览器仍在排队的数据。上传未发生 OPTIONS 预检。三个上传阶段的 Worker 快照中，JavaScript 已用堆约 0.56–2.23 MB，backing storage 约 41–59 MB，说明重复 Blob 引用未在 Worker 中直接物化 1 GiB 数组；这是阶段快照，不是整个浏览器进程的内存峰值。

CDP 增加 HTTP 请求延迟并限制真实 HTTP 流量，**不模拟物理 TCP ACK RTT、丢包或拥塞窗口**。上述测试可验证浏览器计时、共享预算、上传计数和高 HTTP 延迟流程，不能替代真实高 RTT 公网链路的 TCP 性能验证。

## 原生后端容量

`tools/throughput` 用原生 HTTP/1.1 客户端读取持续响应，预热 0.5 秒、统一测量 3 秒，全部零错误：

| 流数 / 观测 TCP | 下载有效载荷吞吐 |
| ---: | ---: |
| 1 / 1 | 48.59 Gbps |
| 4 / 4 | 85.93 Gbps |
| 12 / 12 | 96.10 Gbps |
| 24 / 24 | 83.92 Gbps |

原始记录为 `/workspace/shared/testspeed-download-benchmark.jsonl`。这是本机 HTTP/内存/CPU 路径能力，不是浏览器、TLS 或实际 100G 网卡结果。更多并发未必带来更高吞吐。

## 部署验证

- 当前 Docker Compose 已运行：网页/控制 8080，四个数据端口 8081–8084，同一个非 root、只读文件系统 Go 容器。
- `python3 tools/readiness.py` 对当前最终容器通过：网页、健康、协议 v2、四个 origin/CORS、持续与有限长度下载、实际上传和会话删除。
- 已比较容器提供的网页和 JS 资源与当前源码，确保嵌入的是最新版本。
- 最新二进制重新构建通过。临时直接 HTTPS 实例使用显式信任的本地测试证书，验证 TLS 1.3、网页控制 HTTP/2、四个数据端口 HTTP/1.1、CORS、下载和上传；未关闭证书验证。
- 可复用工具安装脚本再次实际执行通过。

当前平台没有可用的对外端口映射工具，交互浏览器运行时缺少平台管理的认证配置。服务在云环境内实际运行，但尚无可从用户本机直接打开的在线预览地址。没有将 localhost 或私网地址冒充外部入口。

## 工件与边界

- 当前真实桌面运行界面：`/workspace/shared/testspeed-v2.png`。
- 验证汇总：`/workspace/shared/testspeed-v2-validation.json`。
- 最终 300 ms 复测原始日志：`/workspace/shared/testspeed-v2-300ms.log`。
- 其他桌面、手机和三组限速截图：`/tmp/testspeed-browser-v2/`。

未测试真实 10G/100G 网卡、企业交换路径、公网高 RTT TCP ACK、多用户负载或物理链路丢包。当前实现和计数范围已验证；任何特定机器的最高线路吞吐仍需在目标环境实测。
