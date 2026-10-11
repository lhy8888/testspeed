# GitHub 上传前全面编译与测试

本轮在当前云环境重新执行，使用 Go 1.27.2、Node.js 26.11.1、Playwright 1.64.0 和 Chromium 154.0.8037.57。以下是提交前的实际结果，GitHub 服务端 Actions 状态需另行查看，不能由本地结果推断。

## 编译、静态检查与单元测试

- `go test -race -count=1 ./...`：27 项后端测试通过，实际运行而非仅使用测试缓存。
- `go vet ./...`、所有 Go 文件的 `gofmt` 检查：通过。
- `node --check` 检查全部网页 JS 和测试 MJS，`node --test tests/*.test.mjs`：22 项通过，无跳过。
- `actionlint` 1.7.12 检查 GitHub Actions 工作流：通过。
- `git diff --cached --check`：通过。

应用和原生吞吐工具均以 `CGO_ENABLED=0`、`-trimpath`、`-ldflags='-s -w'` 编译，8 个目标共 16 个二进制全部通过：

| 系统 | 架构 |
| --- | --- |
| Linux | amd64、arm64、386 |
| macOS | amd64、arm64 |
| Windows | amd64、arm64 |
| FreeBSD | amd64 |

Linux amd64 二进制已启动并通过协议 v2 功能就绪检查；其他目标仅验证交叉编译，未在对应操作系统运行。

## Docker 与部署

- Docker 无缓存构建通过，最终镜像为 scratch。
- 临时测试容器以 `65532:65532`、只读文件系统、移除全部 capabilities、no-new-privileges 运行，就绪检查通过；测试后已删除。
- `docker compose config --quiet` 通过；原有生产容器继续运行，未被测试容器替换。
- `tools/readiness.py` 验证网页、协议 v2、四个数据 origin、CORS、持续及有限长度下载、上传字节确认、会话创建与清理。
- Go 集成测试使用显式信任的证书，验证 TLS 1.3、网页控制 HTTP/2、数据 HTTP/1.1，未关闭证书验证。

## 真实浏览器全流程

完整 `tests/browser-smoke.mjs` 通过，手动并发对应服务端 TCP 峰值如下；全部结束后活跃逻辑流和测速 TCP 为 0。

| 手动流数 | 下载 | 上传 | TCP 峰值 |
| ---: | ---: | ---: | ---: |
| 1 | 8.69 Gbps | 7.41 Gbps | 1 |
| 4 | 9.02 Gbps | 7.28 Gbps | 4 |
| 12 | 9.05 Gbps | 7.33 Gbps | 12 |
| 24 | 8.91 Gbps | 6.98 Gbps | 24 |

320 像素移动布局、上传停止和完整重测、持续传输释放与会话删除、503 完整恢复、浏览器离线取消、配置失败和重连取消均通过。后台取消使用显式模拟 hidden/visibilitychange；headless 原生标签切换未覆盖。

默认完整测量窗口下，三组 `tests/browser-accuracy.mjs` 全部通过：

| 共享下载 / 上传预算 | HTTP 延迟模型 | 下载结果 | 上传结果 | 空闲 HTTP RTT |
| --- | ---: | ---: | ---: | ---: |
| 20 / 10 Mbps | 80 ms | 19.959 Mbps | 9.961 Mbps | 83.6 ms |
| 1000 / 1000 Mbps | 150 ms | 866.857 Mbps | 959.132 Mbps | 153 ms |
| 1000 / 1000 Mbps | 300 ms | 879.772 Mbps | 961.885 Mbps | 304 ms |

独立 Worker 网络事件确认四个数据 origin 共享限速预算；上传未触发 OPTIONS 预检，测量按服务端实际接收字节计数。CDP 限速不模拟物理 TCP ACK RTT、丢包或拥塞窗口；回环速率不代表物理网卡线速或真实公网容量。

## 可复现验证与工件

GitHub 工作流见 [ci.yml](../.github/workflows/ci.yml)，触发 push、pull request 或手动运行。固定官方 Actions 完整 SHA、明确 Bash pipefail，保存二进制/校验和以及浏览器日志/截图 14 天。

当前云环境的 SDK 配套 Chromium 下载域名被网络策略拒绝，因此本轮显式使用已安装 Chromium 154；CI 会安装 Playwright 1.64.0 配套 Chromium，云端执行仍需单独确认。当前环境 GitHub API 访问返回 Forbidden，不能据此声称 Actions 服务端已通过。

本轮原始 stdout、截图和 JSON 汇总位于 `/workspace/shared/testspeed-github-validation/`；16 个编译产物及 `SHA256SUMS` 位于 `/workspace/shared/testspeed-github-builds/`。这些不提交到源码仓库。
