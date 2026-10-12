# LibreSpeed 参考与 testspeed 的实现取舍

分析日期：2026-10-12。本记录依据 LibreSpeed [v6.3.0](https://github.com/librespeed/speedtest/releases/tag/v6.3.0)，固定提交 `f82467403459e7b8dae893a0522024627a37746b`，以及官方 Go 后端固定提交 `59cff12d1b95b3f80acd8a42b0156aa4fde440de`。二者是独立仓库，不能混用版本号。本次源码分析没有运行其公网测速，也不能证明其节点实际带宽。

testspeed v0.1.4 借鉴可配置阶段、节省测试时间/流量、ISP/ASN 降级、连接稳定性和结果导出的功能思想；代码依据现有 JavaScript Worker、Go 会话和 WebSocket 协议独立实现，没有移植上游 Worker 或 PHP/Go 后端源码。首页继续保持下载数字为主，更多功能默认收起。

## 上游如何运行

主线程配置参数和节点，Worker 进行并发 XHR 下载、Blob 上传、HTTP 延迟与 IP 查询，主线程约每 200ms 读取状态。下载通过 `onprogress.loaded` 增量统计收到的数据，请求完成后重启；PHP 每请求生成 1 MiB 随机块后循环输出，Go 后端在启动时生成共享块。上传复用随机数据组成 Blob，主要根据浏览器上传进度计数；PHP/Go 消费请求体不等于具有服务器统一窗口的上传计量。

参数随入口不同：Worker 基础默认先 IP/Ping，再下载和上传，单方向最大 15 秒并启用自动缩时；现代页面的 `settings.json` 使用下载优先、固定 12 秒和零预热。因此不能把一个页面的行为说成整个项目默认，也不能把内存块大小当成 100G 能力证明。

固定源码引用：

- [页面控制器](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/speedtest.js)：Worker 启停、状态轮询和节点管理。
- [测速 Worker](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/speedtest_worker.js)：参数、下载增量、上传进度、预热、`time_auto`、Ping。
- [现代页面参数](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/settings.json) 与 [入口配置](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/config.json)。
- [PHP 下载后端](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/backend/garbage.php) 与 [Go 后端](https://github.com/librespeed/speedtest-go/blob/59cff12d1b95b3f80acd8a42b0156aa4fde440de/web/web.go)：共享随机数据与请求体消费。
- [IP/ISP 后端](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/backend/getIP.php)、[稳定性 Worker](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/stability_worker.js)、[结果保存](https://github.com/librespeed/speedtest/tree/f82467403459e7b8dae893a0522024627a37746b/results)。

## v0.1.4 如何借鉴

| 功能思想 | testspeed 实现 | 原理与约束 |
| --- | --- | --- |
| 可配置测试阶段 | [speedtest.js](../web/speedtest.js)、[app.js](../web/app.js) | `full`、`download`、`latency` 直接跳过未选择的传输，未测阶段保留空值，避免把跳过项目算作 0 Mbps。 |
| 提前结束与流量控制 | [speedtest.js](../web/speedtest.js)、[sessions.go](../sessions.go) | 固定时长默认；可选自适应观察真实窗口，预算包含预热，结果记录结束原因及实际窗口。 |
| ISP/ASN 降级 | [network.go](../network.go)、[network_mmdb.go](../network_mmdb.go) | 在线异步查询、可选 MMDB 补缺或离线；不探测或猜测库未提供的城市/运营商。 |
| 长期连接稳定性 | [stability-worker.js](../web/stability-worker.js)、[stability.html](../web/stability.html) | 小型同节点 HTTP 请求，单请求采样、有界历史、分布与 CSV；失败率不标成 packet loss。 |
| 历史、导出和分享 | [results.js](../web/results.js)、[share.go](../share.go) | 最近 50 条本地历史、JSON/CSV/PNG；分享是可选 SQLite 客户端报告，用户显式提交。 |
| 多节点选择 | 尚未加入 | 当前单节点保持简单，已有节点配置接口供后续扩展。 |

### 真实窗口，而非按速度奖励缩时

上游 `time_auto` 给较高吞吐累积“时间奖励”，让配置时长提前耗尽；它没有检查 TCP 收敛或连续窗口稳定度。其默认 `overheadCompensationFactor=1.06` 又会按经验系数放大有效吞吐。testspeed 不采用这两种数字口径：

```text
最终 Mbps = 正式窗口收到的 payload 字节 × 8 ÷ 实际计量秒数 ÷ 1,000,000
# 预热收到的字节可用于灰色即时预览，排除在最终 measuredBytes 外。
# 浏览器排队量不是上传计量，上传使用服务端读取与单调时钟。
```

自适应每方向至少计量 `max(5000ms, 8 × RTT)`。最近三个不少于 1 秒的真实吞吐窗口须保持低变异、无明显下降和无持续爬升；请求失败、负载 Ping 失败或调度异常阻止提前稳定结束。自动并发模式还必须收敛。上传稳定结束向服务器提交原因，服务器至少验证 5 秒真实窗口，再冻结计量时长和字节；服务器不会接受客户端提供的速度或累计字节作为计量。

预算对下载和上传分别应用，包含预热。到达预算、稳定结束、耗尽时间是不同原因，取消不冒充完成。预算阈值不是网卡总流量上限：并发在途读取、已发送队列和有界关闭排空仍有余量；若尚无正式计量数据，结果为空并标明预算提前耗尽。高 RTT 或高速链路预算过小，会在 TCP 充分扩窗前结束。

### 保留现有连接和关闭语义

多路 XHR 不保证多条 TCP：HTTP/1.1 有同源连接池限制，HTTP/2 可复用连接。testspeed 默认使用 8 条独立 HTTP/1.1 Upgrade WebSocket，最多 30 条，显示服务器实际观测的 TCP 数；HTTP 回退保留其有效上限提示。

下载复用启动时生成的 25 MiB 只读随机块与预制消息；上传每路排队有上限，服务器按实际 body read 计量。正常窗口、稳定或预算结束都保留关闭码 1000，关闭排空限定时间和字节且不进入已冻结计量。延续 v0.1.3 的真实首字节灰色预览，不引入仪表摆动或虚构速度。

### 信息、历史与诊断的边界

GeoIP 仍独立于测速流程，保留短超时、限流、有界缓存和显式可信代理。私网地址不查询第三方，手填园区/机房标签与公网 IP 近似位置分开。MMDB 单文件启动时读取，用户自行取得合法授权的库；数据库不能自动获知服务器公网出口，也不保证 City/Country/ASN 库同时包含所有字段。

稳定性测试记录每次真实时间、成功延迟或失败原因。失败 HTTP 请求不等于 IP 包丢失，不给失败填造假延迟；失败请求也中断相邻抖动的配对。导出保留事实值，不把有限样本推断成物理带宽或线路证明。

本地记录与分享使用允许字段，排除客户端 IP、所在地和令牌。SQLite 默认关闭，显式开启才持久化用户提交报告；到期、容量、写令牌和撤销均属于报告管理，不能把报告称为服务器认证的测速结果。

## 来源与许可

LibreSpeed 主仓及其 Go 后端 README 均声明 **GNU Lesser General Public License，版本 3 或更新版本**，参见固定版本的 [主仓许可说明](https://github.com/librespeed/speedtest/blob/f82467403459e7b8dae893a0522024627a37746b/README.md#license) 和 [Go 后端许可说明](https://github.com/librespeed/speedtest-go/blob/59cff12d1b95b3f80acd8a42b0156aa4fde440de/README.md#license)。本记录引用源码以解释功能与算法；相关新增实现没有复制上游代码。

运行数据库的许可由数据提供方单独决定，本项目不自动下载或分发上游运行数据库。仅用于 schema 测试的少量 MMDB 夹具，其固定来源、哈希和许可列在 [testdata/geoip/README.md](../testdata/geoip/README.md)，不会嵌入应用或发布包。

功能部署说明见 [独立教程](deployment.md)，验证范围见 [验证记录](validation.md)。回环和限速模型可验证计量、并发及异常处理，不能替代真实 10G/100G 网卡、TLS、浏览器和线路容量验证。
