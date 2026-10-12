# 验证记录

## v0.1.3：更快的真实速度显示与正常上传关闭

2026-10-12 完成以下候选版本本地检查。完整跨平台、容器与浏览器 CI 结果见 [GitHub Actions](https://github.com/lhy8888/testspeed/actions/workflows/ci.yml) 对应提交，正式安装包校验与部署另外使用实际下载的发布资产。

- `go test -race ./...` 通过（8.543 秒），`go vet ./...` 通过。新增持续 1 MiB 上传的 8 路正常截止、最多 1 秒关闭宽限及冻结字节、可信 TLS 正常关闭测试；保留真正提前断连、DELETE、30 路连接和服务关闭测试。
- `node --test tests/*.test.mjs` 68 项全部通过。快启动保持首个延迟失败后的重试预算、总计 8 次空闲尝试、传输全部清理后补齐采样和取消；HTTP/WebSocket 预热预览只使用实际收到的字节，零时间不产生虚假速度，预热字节不进入最终结果或正式曲线。
- Playwright 1.64.0 的完整界面测试通过。应用延迟模型为 212ms，真实 TCP 传输预算为下载 120Mbps / 上传 60Mbps、按 30 路分配。默认 8 路开始后 754.2ms 显示灰色真实预热速度，手动 30 路重测为 666.1ms，均在正式计量前、且没有正式 `data-mbps`；原 8 次串行空闲探测仅采样等待就需约 2326ms。
- 默认 8 路测得下载 31.923Mbps / 上传 15.988Mbps，手动 30 路为 107.771Mbps / 54.355Mbps，失败率均为 0，实际 TCP 峰值 8 / 30、结束归零。下载最终值先于上传显示，上传预热保持 0；末尾补齐空闲样本但不回跳阶段，语言和 320 像素布局检查保持通过。
- 不限速 raw CDP 检查不启用 Network 或观察 WebSocket 二进制帧。默认 8 路下载 7.853Gbps、上传 6.085Gbps，8 条上传连接全部以 `1000/session_finished` 正常结束，没有 1006；下载、上传及所有 ping 的失败计数均为 0，TCP 峰值 8、结束为 0，实际完整空闲采样为 8 次。Logo、灰色 0、真实预热预览、独立网络信息、语言持久化、320 像素布局和 13 个教程复制命令通过。该速度是本机浏览器回环路径，不能代表网卡容量。
- 不限速手动 30 路检查也通过：下载 6.769Gbps、上传 6.089Gbps，30 条上传连接全部正常 `1000/session_finished`，无 1006；所有测量和 ping 失败计数为 0，实际 TCP 峰值 30、结束为 0。两轮 raw CDP 检查使用独立浏览器，无额外网络预算，未观察二进制帧。

该模型延迟 HTTP ping 响应和初始 TCP 转发，**不是物理 TCP ACK RTT 模拟**。上述预算与速度用于验证流程、连接数和计量，不能代表网卡或服务器容量。原 v0.1.2 正式包的不限速本机浏览器检查暴露了上传截止时的 TCP 复位问题：下载与所有 ping 成功，部分正常截止连接返回 1006；旧失败工件保留在 `/workspace/shared/testspeed-v012-release-artifact-diagnostic/`。v0.1.3 修复关闭帧交付，不隐藏这些失败、不放宽失败率断言。

当前工件：`/workspace/shared/testspeed-v013-validation/unit-tests.log`、`/workspace/shared/testspeed-v013-candidate-ui/ui-report.json`、`/workspace/shared/testspeed-v013-candidate-unrestricted-eight/` 和 `/workspace/shared/testspeed-v013-candidate-unrestricted-thirty/`，包含对应报告、关闭事件摘要与截图。

## v0.1.2：IP 所在地、初始状态与新标识

2026-10-12 在当前 Linux 云环境对候选版本完成以下检查。运行时沿用 Go 1.27.2、Node.js 26.11.1、Playwright 1.64.0 和 Chromium 154。

- 全部 Go 竞态测试和 `go vet` 通过；JavaScript 单元及部署事务测试 **62 项全部通过**。
- 新增网络信息浏览器套件 **3 项全部通过**。延迟返回所在地信息不阻止测速；收到数据前停止时仍显示灰色 `0`、尚未产生 `data-mbps` 测量值，也没有残留数据连接。
- 完整 8→30 路界面检查发现固定 5 秒握手超时提前关闭浏览器仍在排队的连接；原生事件确认这些连接尚未 open、ready 或接收数据。启动预算已按并发和 RTT 调整，30 路低 RTT 使用 11 秒、最大 30 秒。5 项回归验证覆盖延迟握手、真正超时、及时取消、服务器上传字节和保留真实失败计数。
- 通过模拟网络信息响应验证恶意标签仅作为文本显示、中英切换无需重新查询、320 像素手机布局，以及私网和关闭查询状态。响应中的 IP、国家和所在地标签均为测试夹具，**不是真实公网 GeoIP 查询结果**。
- 网络信息接口模拟返回 503 时，真实默认 8 路 WebSocket 测速仍完整结束：下载 **117.47 Mbps**、上传 **59.97 Mbps**，真实 TCP 代理共享预算为 120/60 Mbps。服务端 TCP 峰值为 8，结束后活跃连接为 0、传输失败为 0，上传会话已删除。
- 使用 Playwright 1.64.0 的完整界面套件通过连续 8→30 路测速：两者请求失败率均为 0，实际 TCP 峰值分别为 8/30，结束后活跃数均为 0。初始灰色 `0`、下载结束后转为黑色且上传期间保留结果、上传窗口结束后显示结果、中英切换不重置测速、语言保存、更多内容默认收起和 320 像素手机布局全部通过，浏览器异常列表为空。8 路测得下载 31.8341 Mbps、上传 15.9883 Mbps；30 路为 109.7949/55.6791 Mbps。真实测试代理采用 120/60 Mbps 预算和分频设置 30，这些数值不代表网卡容量。
- 候选 scratch 镜像实际构建、单端口启动与接口检查通过。运行时包含 121 个公共 CA 根证书，以非 root、只读文件系统和 `cap_drop: ALL` 运行；真实网络信息接口的私网与查询不可用状态不会阻断服务。

当前 Codex 网络策略拒绝对 FreeIPAPI 的直接 HTTPS CONNECT 请求，返回 403，因此本轮没有验证外部服务的真实地理数据或成功查询。允许 `free.freeipapi.com` 的网络配置草稿已保存，仍需在环境设置中发布后才会生效。所在地功能的响应处理由确定性夹具验证，测速数据则经过真实浏览器和 TCP 连接传输。

本轮未新增真实 10G/100G 网卡、真实 systemd 安装或 Snap/AppArmor 测试。GitHub Actions 的结果以候选提交对应的运行记录为准；以上记录仅包含已经完成的本地检查。

本轮网络信息报告位于 `/workspace/shared/testspeed-v012-validation/network-info-report.json`；修复后的完整 8→30 界面报告位于 `/workspace/shared/testspeed-v012-fixed-ui-playwright164/ui-report.json`。原生握手事件保留于 `/workspace/shared/testspeed-v012-native-ws-trace-2/`；模拟时钟回归验证保留真实超时计数和原测量窗口。

## v0.1.1：单端口、8–30 路与极简界面

2026-10-12 在当前 Linux 云环境完成。Go 1.27.2、Node.js 26.11.1、Playwright 1.64.0、Chromium 154；原生实例分别验证默认 WebSocket、HTTP 多端口和 HTTP 单端口。

- 全部 Go 竞态测试、`go vet` 和 `go mod verify` 通过。
- JavaScript 单元及部署事务测试 **55 项全部通过，无跳过**。其中部署脚本使用隔离目录和假的 systemctl/curl 验证，不能算真实 systemd 安装。
- WebSocket 浏览器套件 10 项结果通过：默认 8 路、手动 1/4/8/16/30 路、手机停止与重测、离线/后台停止、真实 Upgrade 拒绝后的 HTTP 回退，以及慢速链路。
- 每次完整 WebSocket 测试分别核对下载 run 和上传会话的服务端 TCP 峰值，均等于请求的路数；上传页面结果与最终服务器字节及窗口一致。正常完整测试失败率为 0，结束后连接与会话释放。
- 新增真实 WSS 测试：信任测试证书并验证证书链，单端口 8 条独立连接，双方确认 TLS 1.3 和 HTTP/1.1 Upgrade；未关闭证书验证。
- 修复并验证上传窗口截止的关闭竞态：正常结束发送 `1000 / session_finished`；提前断线不会被标为成功。
- HTTP 网络访问套件 6 项通过：四端口受阻回退 4 路、两端口可达使用 12 路、全部可达实际 24 路、不可达报错、取消探测、单端口完整传输。阻断规则明确作用于 DedicatedWorker。
- 独立界面套件通过：默认隐藏更多内容，下载实时显示，上传期间下载最终值保持且上传值尚未显示；完成后显示上传；中英切换不重测、不丢结果；语言选择可保存；320 像素手机展开与折叠无横向溢出。
- 最终 scratch 镜像构建通过。Compose 5.5.1 的默认单端口配置和 Snap override 在普通 Docker 上实际启动、非 root/只读/cap_drop ALL 及接口检查通过；可选 HTTP override 合并通过。真实 Snap/AppArmor 和真实 systemd 安装仍不在当前云机器的验证范围内。

WebSocket 功能套件通过真实 TCP 代理限制测试流量，30 路总预算为下载 120 Mbps / 上传 60 Mbps，避免 DevTools 观察二进制帧本身造成大量数据搬运。这些结果用于连接、计量和界面验证，**不是服务器容量基准**。另以 5/2 Mbps 的真实传输预算和 150 ms 控制请求延迟测试默认 8 路，测得下载 4.515 Mbps、上传 2.097 Mbps、空闲 HTTP RTT 153 ms；这不是物理 TCP ACK RTT 模拟。

主要工件位于 `/workspace/shared/testspeed-v011-final-websocket/`、`/workspace/shared/testspeed-v011-final-ui/`、`/workspace/shared/testspeed-v011-http-network/` 和 `/workspace/shared/testspeed-v011-validation/`。GitHub Actions 会另行执行跨平台编译、容器、完整 HTTP 流程与限速检查，结果以对应运行记录为准。

## v0.1.0：历史 HTTP 模式记录

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
