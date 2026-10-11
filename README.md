# testspeed

一个简洁的浏览器测速平台，适用于公网和企业内网。首版只使用一个测速节点，前端网页和测速 API 由同一个 Go 进程提供。

- 原生 JavaScript 页面，无前端编译步骤、CDN、数据库或第三方在线服务依赖。
- Go 标准库后端，网页内嵌在单个可执行文件中。
- 并行下载、上传测速，以及空闲延迟、下载/上传负载下延迟、抖动和 HTTP 请求失败率。
- 实时速度曲线、进度、停止和重新测速，支持桌面和手机。
- 面向 1G / 10G / 100G 量级设计：持续内存数据流、Web Worker 统计、RTT 自适应预热、自动探测或手动指定并发。
- 默认最多 24 路测速流，页面显示服务端实际观测的 TCP 连接和协议，Mbps/Gbps 自动切换。
- 可直接提供 HTTP 或 HTTPS；节点协议独立于页面，为后续多节点扩展保留入口。

## 启动

需要 Go **1.27.2** 或更新的正式稳定版。应用本身不需要 Node.js；Node.js 仅用于开发测试。

```sh
go run .
```

网页和控制接口默认监听 `:8080`，同一进程还监听 `8081–8084` 四个 HTTP/1.1 测速端口，形成独立浏览器连接池。部署后访问服务器的 8080 端口，点击「开始测速」；防火墙需同时允许测速端口。企业内网不需要连接外部测速服务。

若只允许一个端口，可以用 `MEASUREMENT_PORTS='' go run .` 启动。此时为延迟和上传进度保留连接，最多使用 4 路测速流。多个端口仍然是同一台服务器、同一个测速节点。

### 单文件部署

```sh
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/testspeed .
./bin/testspeed
```

只需复制生成的 `testspeed` 可执行文件，网页已经内嵌在其中。跨平台编译可设置 `GOOS` 和 `GOARCH`，例如 `GOOS=linux GOARCH=arm64`。

### Docker Compose

```sh
docker compose up --build -d
docker compose logs -f
```

默认映射宿主机 `8080–8084`。容器以非 root 用户运行，文件系统只读。关闭服务使用 `docker compose down`。

更改网页端口时，还要设置浏览器实际访问的公开 origin，保证跨端口 CORS 一致，例如：

```sh
PORT=9000 PUBLIC_ORIGIN=http://your-server:9000 docker compose up --build -d
```

`your-server` 替换为客户端访问的 IP 或域名。数据端口默认仍为 8081–8084；若改变外部映射，应同时配置 `MEASUREMENT_ORIGINS`。

也可以直接构建、启动容器：

```sh
docker build -t testspeed:local .
docker run --rm --name testspeed -p 8080-8084:8080-8084 testspeed:local
```

### HTTPS

公网建议使用可信证书。可由现有反向代理终止 TLS，也可以让应用直接提供 HTTPS：

```sh
ADDR=:8443 TLS_CERT_FILE=/path/to/fullchain.pem TLS_KEY_FILE=/path/to/key.pem ./bin/testspeed
```

证书和密钥必须同时指定。应用直接提供 TLS 时最低版本为 TLS 1.3，所有数据端口也使用同一证书并固定 HTTP/1.1；网页端口支持 HTTP/2。容器部署时将证书目录只读挂载，并设置环境变量及相应端口映射；文件权限需允许容器用户 `65532:65532` 读取证书和密钥。

如果已有 Nginx 代理，测速路径应关闭缓存、压缩和请求/响应缓冲，否则结果可能被缓存、压缩或代理吞吐影响。例如在对应的 `location /` 中：

```nginx
proxy_pass http://127.0.0.1:8080;
proxy_http_version 1.1;
proxy_request_buffering off;
proxy_buffering off;
proxy_cache off;
gzip off;
client_max_body_size 1024m;
proxy_read_timeout 90s;
proxy_send_timeout 90s;
```

若代理开启了 Brotli，也应为测速响应关闭它。代理需要分别暴露数据端口或独立 origin；数据端口对浏览器保留 HTTP/1.1，避免 HTTP/2 合并 TCP 连接。使用 `PUBLIC_ORIGIN` 和 `MEASUREMENT_ORIGINS` 明确指定客户端访问地址，后端不信任任意转发头来猜测 origin。代理与 Go 服务可以部署在同一台服务器上。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ADDR` | `:8080` | 监听地址，可设置 `127.0.0.1:8080` 仅接受本机代理请求 |
| `NODE_ID` | `local` | 节点标识 |
| `NODE_NAME` | `默认测速节点` | 页面显示的节点名称 |
| `MAX_CONCURRENT_TEST_REQUESTS` | `128` | 同时进行的下载和上传请求总数，范围 1–4096 |
| `MEASUREMENT_PORTS` | `8081,8082,8083,8084` | 同进程的测速端口；空字符串启用单端口模式 |
| `MAX_TEST_STREAMS` | `24` | 单次测试流数上限，范围 1–64，实际受 origin 连接池容量限制 |
| `PUBLIC_ORIGIN` | 自动推导 | 网页的公开 HTTP/HTTPS origin，不含路径 |
| `MEASUREMENT_ORIGINS` | 自动推导 | 公开测速 origin 列表，用逗号分隔；显式指定时需要 `PUBLIC_ORIGIN` |
| `UPLOAD_SESSION_LIMIT` | `256` | 活跃上传会话上限，范围 1–4096 |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 空 | 可选 HTTPS 证书及密钥路径 |
| `TEST_DOWNLOAD_DURATION_MS` | `10000` | 下载测量窗口时长，不含预热，范围 1000–60000 毫秒 |
| `TEST_UPLOAD_DURATION_MS` | `10000` | 上传测量窗口时长，不含预热，范围 1000–60000 毫秒 |
| `TEST_WARMUP_MS` | `1500` | 预热下限，范围 0–10000 毫秒；客户端根据 RTT 自动延长，最多 10 秒 |

每位用户会同时使用多条传输连接，因此请求并发上限不是在线用户数。上限耗尽时传输 API 返回 503，延迟、配置和健康检查仍可访问。持续下载受取消和 90 秒传输超时约束；上传会话中的单个请求体最大 1 GiB，流式读取不整块分配内存。有限长度下载和无会话上传的单请求上限仍为 64 MiB。

应用默认不自动开始测速，避免页面打开就消耗大量流量。正式测速会尽量使用可用带宽，结果取决于客户端到这台服务器之间的路径，以及服务器网卡、CPU、代理和当前负载。

## 测速含义

下载和上传使用不可压缩数据、多条连接和预热，按实际传输的总字节数及测量窗口计算速率，而不是把每条请求的瞬时速度相加。页面自动选择 Mbps/Gbps，1 Mbps = 1,000,000 bit/s，1 Gbps = 1,000,000,000 bit/s。

延迟是浏览器发起 HTTP 请求的往返时间，包含浏览器调度和服务端处理；它不是 ICMP ping。空闲延迟取样本中位数，抖动反映相邻样本的延迟变化。负载下延迟在下载、上传期间分别采样。请求失败率表示 HTTP 测量请求的失败比例，**不代表网络数据包丢包率**。

下载在 Worker 中统计实际收到的响应字节；上传由服务器在单调时钟窗口内统计实际接收字节，尚未整块确认的数据也能准确计入，客户端排队的字节不计入。页面流量估算不包含协议开销和仍在途中、服务器未收到的数据。浏览器切到后台、网络断开或测试被停止时，不将未完成测量当作完整结果。后端只保留有上限的短期测量会话，不保存历史或客户端资料；浏览器保存上次结果和本地设置。

测速流数不等于 TCP 数：HTTP/2 可复用连接。页面单独显示服务端观测的连接；经过反向代理时，它统计代理到后端的 TCP。预热和并发探测是基于 RTT 与实测增益的启发式调节，手动模式可用于比较不同设置。

10G/100G 测速仍需要相应的网卡、真实链路、TCP 窗口和 CPU/浏览器能力。25 MiB 循环数据只能避免分配和请求间隙，不能消除这些边界。详细设计、带宽时延积和后端原生吞吐测试见 [docs/performance.md](docs/performance.md)。

## 开发与验证

```sh
make build
make test
make check
```

`make test` 执行 Go 竞态检测及 JavaScript 单元测试。浏览器端到端测试使用 Playwright 和 Chromium，针对真实传输、取消重试、错误反馈及移动端布局：

```sh
BASE_URL=http://127.0.0.1:8080 node tests/browser-smoke.mjs
BASE_URL=http://127.0.0.1:8080 node tests/browser-accuracy.mjs
```

测试机需提供 Playwright 和 Chromium，可通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 指定。第一个脚本验证完整用户流程；第二个使用 Chromium 网络限速检查结果准确性。测试截图和报告保存于 `/tmp/testspeed-browser-v2`，可用 `TEST_ARTIFACT_DIR` 修改。已验证的结果见 [docs/validation.md](docs/validation.md)。

在本云环境中，先执行 `source /workspace/shared/cloud-toolchain/activate.sh` 激活已验证的最新稳定工具链，再执行以上命令。修改网页后需要重启 `go run .` 或重新编译，因为网页资源是在编译时嵌入的。

### GitHub Actions

[编译与测试工作流](.github/workflows/ci.yml) 在 push、pull request 或手动触发时运行，固定 Go 1.27.2、Node.js 26.11.1、Playwright 1.64.0，并将官方 Actions 固定到完整提交 SHA：

- 检查 Go 格式、`go vet`、不复用测试缓存的竞态检测、JavaScript 语法及单元测试。
- 交叉编译应用和原生吞吐客户端：Linux amd64/arm64/386、macOS amd64/arm64、Windows amd64/arm64、FreeBSD amd64；编译通过不代表已在这些目标系统运行验证。
- 构建 scratch 镜像，以只读文件系统和非 root 用户运行，检查网页、四个测速端口及上传会话协议。
- 在实际 Chromium 中顺序运行完整桌面/手机流程、1/4/12/24 路 TCP 并发、取消重试和断网检查；随后运行默认的 20/10 Mbps、80 ms 以及双向 1 Gbps、150/300 ms HTTP 延迟模型。

工作流只使用隔离的 CI 测试容器。成功编译的压缩包及 SHA256SUMS、浏览器截图和日志保存在该次 Actions 运行的 artifacts 中，保留 14 天。限速模型与 CI 回环结果用于功能和计量验证，不作为真实物理网卡吞吐证明。

本轮上传前的完整编译矩阵、竞态检测、容器与浏览器实测见 [docs/github-validation.md](docs/github-validation.md)。

## 后续扩展

`GET /api/config` 提供协议版本、节点列表、测速参数、测量 origin 和能力声明。首版仍只有一个节点；多个数据端口扩展浏览器连接池，不代表多个节点。客户端测速引擎独立于页面，通过节点的控制地址和数据 origin 调用协议 v2。

增加多节点时，可先部署实现同一协议的节点服务，再扩展配置中的节点列表和节点选择策略。跨域节点还需显式配置 HTTPS、允许来源和页面连接策略。首版不进行地理定位或自动选择节点，也不引入这些基础设施。

API 定义见 [docs/protocol.md](docs/protocol.md)。
