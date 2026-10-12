# testspeed

一个适用于公网和企业内网的单节点测速平台。原生 JavaScript 网页内嵌在 Go 二进制中，前后端部署在同一台服务器；基础测速无需数据库、CDN或前端构建。

- 默认单端口、固定 **8 路**并发，最多 **30 路**，保留自动适配模式。
- 收到真实下载数据后立即显示预热速度；下载完成立即保留结果，上传完成后再显示上传结果。
- 接近 fast.com 的简洁界面，更多指标和设置默认收起，支持中文 / English。
- 下载、上传、空闲与负载下延迟、抖动、实时曲线，以及服务端实际观测的 TCP 连接数。
- 完整测速、仅下载、仅延迟；固定时长默认开启，可选稳定后提前结束和每方向流量预算。
- 显示客户端 IP、IP 网络所在地、ISP/ASN 和服务器所在地；可选离线 MMDB，查询独立于测速。
- 独立连接稳定性页面、最近 50 条本地历史、JSON / CSV / PNG 导出；SQLite 结果分享可选，默认关闭。
- Web Worker 计量、RTT 自适应预热、共享随机内存数据，适合进一步扩展高带宽与多节点能力。

## 部署与维护

[**打开独立部署教程**](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/deployment.md) · [下载最新安装包](https://github.com/lhy8888/testspeed/releases/latest)

教程提供安装、更新、指定版本回退、日志、重启、停止、卸载和配置清理命令，包含 Docker 与 Snap 部署。应用运行后，也可在网页的“部署教程”入口打开同一套操作说明。

默认仅需开放 TCP 8080，网页与所有测速连接共用该端口。安装包包含内嵌网页的可执行文件、维护脚本、systemd 示例、部署教程和原生吞吐客户端；每次发布提供 SHA256SUMS。

## 测速方式

默认每路使用独立 WebSocket 连接，通过 HTTP/1.1 Upgrade 建立；手动模式固定8路，可调整至30路。选择自动模式后，根据 RTT 和实测增益调整并发。WebSocket 被代理阻断时可回退普通 HTTP，并明确提示实际可用并发。

下载统计浏览器在测量窗口实际收到的字节；上传由服务器在单调时钟窗口统计实际读到的字节，客户端排队量不计入结果。下载消息从小块开始并按速度增大，上传每路排队量有上限。

测速结果反映客户端到当前节点的路径与两端能力。延迟是 HTTP 请求往返时间；请求失败率不是网络丢包率。经过反向代理时，服务端观测的 TCP 指代理到后端的连接。

GeoIP 默认通过固定 HTTPS 的 FreeIPAPI 查询，并发送公开客户端 IP；私网地址不查询第三方。ISP/ASN 仅显示服务或授权数据库实际提供的信息。结果是 IP 网络的近似所在地，不是 GPS。查询失败不影响测速，可配置离线 MMDB、禁用查询或手动设置内网标签，详见 [部署配置](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/deployment.md#ip所在地与-ispasn)。

本地历史和导出只包含允许的测速指标，排除 IP、所在地和令牌；分享由用户点击提交，属于客户端报告，不代表服务器认证的速度。连接稳定性页面使用真实 HTTP 往返采样，请求失败率不等于网络丢包率。

1G / 10G / 100G 的测量还取决于网卡、TCP 窗口、CPU、TLS、浏览器和代理。内存循环数据不能保证任何机器测满100G。设计与边界见 [性能说明](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/performance.md)。

## 开发

需要 Go **1.27.2** 或更新的正式稳定版。网页无编译步骤；开发测试使用 Node.js **26.11.1**，WebSocket、MMDB 和纯 Go SQLite 依赖由 go.mod/go.sum 固定并校验。

```sh
make build
make test
make check
make run
```

网页在 Go 编译时嵌入，修改 web/ 后需要重新构建并重启。

浏览器测试使用 Playwright 1.64.0 和 Chromium。GitHub Actions 完成竞态检测、JavaScript 测试、八个目标的交叉编译、容器部署，以及 WebSocket 和可选 HTTP 模式的真实浏览器验证。功能测试的限速预算和回环结果不代表实际线路容量。

[验证记录](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/validation.md) · [GitHub 验证流程](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/github-validation.md) · [协议说明](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/protocol.md)

在当前 Codex 云环境开发时，先执行 `source /workspace/shared/cloud-toolchain/activate.sh`；云环境启动步骤已独立保存。

## 扩展

首版只有一个节点。配置接口提供节点列表、控制地址和传输能力，测速引擎与界面分离。后续可以部署实现相同协议的节点，再加入节点选择策略。目前只展示 IP 网络所在地，不根据位置自动选择节点。

[更新记录](https://github.com/lhy8888/testspeed/blob/v0.1.4/CHANGELOG.md)

[LibreSpeed 源码参考与实现取舍](https://github.com/lhy8888/testspeed/blob/v0.1.4/docs/librespeed-reference.md) · [LibreSpeed](https://github.com/librespeed/speedtest) 的程序许可为 LGPL-3.0-or-later；本项目相关功能独立实现，未移植其 Worker 或后端源码。
