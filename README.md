# testspeed

一个简洁的浏览器测速平台，适用于公网和企业内网。首版只使用一个测速节点，前端网页和测速 API 由同一个 Go 进程提供。

- 原生 JavaScript 页面，无前端编译步骤、CDN、数据库或第三方在线服务依赖。
- Go 标准库后端，网页内嵌在单个可执行文件中。
- 并行下载、上传测速，以及空闲延迟、下载/上传负载下延迟、抖动和 HTTP 请求失败率。
- 实时速度曲线、进度、停止和重新测速，支持桌面和手机。
- 面向 1G / 10G / 100G 量级设计：持续内存数据流、Web Worker 统计、RTT 自适应预热、自动探测或手动指定并发。
- 默认最多 24 路测速流，页面显示服务端实际观测的 TCP 连接和协议，Mbps/Gbps 自动切换。
- 可直接提供 HTTP 或 HTTPS；节点协议独立于页面，为后续多节点扩展保留入口。

## 安装与启动

### Linux 安装包（推荐，无需 Go / Node.js / Docker）

当前正式版 **v0.1.0**。前端网页已经内嵌在可执行文件中，下载后不需要另找网页目录或安装前端依赖。

- [Linux x86_64 / amd64 安装包](https://github.com/lhy8888/testspeed/releases/download/v0.1.0/testspeed-linux-amd64.tar.gz)
- [Linux ARM64 安装包](https://github.com/lhy8888/testspeed/releases/download/v0.1.0/testspeed-linux-arm64.tar.gz)
- [SHA256 校验清单](https://github.com/lhy8888/testspeed/releases/download/v0.1.0/SHA256SUMS)
- [全部平台安装包 / 最新正式版](https://github.com/lhy8888/testspeed/releases/latest)

适用于使用 systemd 的现代 Linux 服务器，需要 `curl`、`tar`、`sha256sum` 和 sudo 权限。复制下面整段执行，自动选择 x86_64 或 ARM64 包，校验后安装并启动：

```sh
bash <<'INSTALL_TESTSPEED'
set -eu
TESTSPEED_VERSION=v0.1.0
case "$(uname -m)" in
  x86_64) TESTSPEED_ARCH=amd64 ;;
  aarch64|arm64) TESTSPEED_ARCH=arm64 ;;
  *) echo "请从 GitHub Releases 选择与你的系统匹配的安装包" >&2; exit 1 ;;
esac
TESTSPEED_PACKAGE="testspeed-linux-$TESTSPEED_ARCH.tar.gz"
TESTSPEED_BASE_URL="https://github.com/lhy8888/testspeed/releases/download/$TESTSPEED_VERSION"
TESTSPEED_DOWNLOAD_DIR="$(mktemp -d)"
cd "$TESTSPEED_DOWNLOAD_DIR"

curl --fail --location --retry 2 "$TESTSPEED_BASE_URL/$TESTSPEED_PACKAGE" --output "$TESTSPEED_PACKAGE"
curl --fail --location --retry 2 "$TESTSPEED_BASE_URL/SHA256SUMS" --output SHA256SUMS
awk -v package="$TESTSPEED_PACKAGE" '$2 == package { print }' SHA256SUMS > SHA256SUMS.selected
test "$(wc -l < SHA256SUMS.selected)" -eq 1
sha256sum --check SHA256SUMS.selected
tar -xzf "$TESTSPEED_PACKAGE"

sudo install -d -m 0755 /opt/testspeed /etc/testspeed
sudo install -m 0755 testspeed /opt/testspeed/testspeed
if ! sudo test -e /etc/testspeed/testspeed.env; then
  sudo install -m 0644 testspeed.env.example /etc/testspeed/testspeed.env
fi
sudo install -m 0644 testspeed.service /etc/systemd/system/testspeed.service
sudo systemctl daemon-reload
sudo systemctl enable testspeed.service
sudo systemctl restart testspeed.service
sudo systemctl --no-pager status testspeed.service
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/healthz
INSTALL_TESTSPEED
```

默认网页地址：`http://服务器IP:8080`。把“服务器IP”替换为客户端可以访问的 IP 或域名；服务器防火墙和云安全组需允许 **TCP 8080–8084**。8080 提供网页和控制接口，8081–8084 提供独立 HTTP/1.1 测速连接池，仍然是同一台服务器、同一个进程、同一个节点。

| 内容 | 安装位置 / 命令 |
| --- | --- |
| 可执行文件（内嵌网页） | `/opt/testspeed/testspeed` |
| 配置文件 | `/etc/testspeed/testspeed.env` |
| systemd 服务文件 | `/etc/systemd/system/testspeed.service` |
| 查看日志 | `sudo journalctl -u testspeed.service -f` |
| 重启 / 停止 | `sudo systemctl restart testspeed.service` / `sudo systemctl stop testspeed.service` |

修改配置后执行 `sudo systemctl restart testspeed.service`。若只允许一个端口，在配置文件中设置 `MEASUREMENT_PORTS=`，此时最多使用 4 路测速流。服务通过 systemd 动态用户运行，配置文件由服务管理器读取。

更新时修改上述 `TESTSPEED_VERSION` 后重新执行安装命令；二进制会被替换、服务会重启，现有 `/etc/testspeed/testspeed.env` 会保留。无外网的企业内网可先在联网机器下载对应压缩包和 SHA256SUMS，再带入服务器校验并执行安装部分。

如果已经修改 `ADDR` 或启用 HTTPS，更新时把最后一行健康检查地址改为实际监听地址。

### Docker Compose：直接从 GitHub 安装

需要先安装 Docker Engine 和 Compose 插件；源码安装路径为 **/opt/testspeed-src**，不需要宿主机安装 Go 或 Node.js：

```sh
sudo git clone --depth 1 --branch v0.1.0 https://github.com/lhy8888/testspeed.git /opt/testspeed-src
sudo docker compose --project-directory /opt/testspeed-src --file /opt/testspeed-src/compose.yaml up --build --detach
sudo docker compose --project-directory /opt/testspeed-src --file /opt/testspeed-src/compose.yaml logs --follow
```

部署后访问 `http://服务器IP:8080`，同样需要允许 TCP 8080–8084。容器以非 root 用户运行，文件系统只读。停止使用 `sudo docker compose --project-directory /opt/testspeed-src --file /opt/testspeed-src/compose.yaml down`。二进制安装和 Docker 安装选择一种即可，避免占用相同端口。

更改网页端口时，同时设置实际访问的公开 origin，保证跨端口 CORS 一致：

```sh
sudo env PORT=9000 PUBLIC_ORIGIN=http://your-server:9000 docker compose --project-directory /opt/testspeed-src --file /opt/testspeed-src/compose.yaml up --build --detach
```

`your-server` 替换为客户端访问的 IP 或域名。数据端口默认仍为 8081–8084；若改变外部映射，应同时配置 `MEASUREMENT_ORIGINS`。

### Compose 提示找不到配置文件

先检查文件，再显式指定配置路径。检出版本标签时出现 detached HEAD 是正常提示，不影响运行。

```sh
sudo ls -l /opt/testspeed-src/compose.yaml
sudo docker compose --project-directory /opt/testspeed-src --file /opt/testspeed-src/compose.yaml config --quiet
```

配置检查通过时没有输出，然后执行上面的启动命令。若显式指定仍失败，记录错误以及以下输出，用于确认 Docker / Compose 安装来源和实际执行路径：

```sh
sudo docker compose version
command -v docker
sudo sh -c 'command -v docker'
```

Docker 的 Snap 安装可能限制读取 /opt；只有确认使用 Snap 且文件访问被拒绝时，才将源码放到该安装允许访问的目录。不要为此删除已有源码或容器。

### 从 GitHub 源码编译（可选）

需要 Go **1.27.2** 或更新的正式稳定版，以及 Git。以下命令直接下载仓库、构建并安装到相同的二进制路径：

```sh
TESTSPEED_SOURCE_DIR="$(mktemp -d)"
git clone --depth 1 --branch v0.1.0 https://github.com/lhy8888/testspeed.git "$TESTSPEED_SOURCE_DIR"
cd "$TESTSPEED_SOURCE_DIR"
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/testspeed .
sudo install -d -m 0755 /opt/testspeed
sudo install -m 0755 bin/testspeed /opt/testspeed/testspeed
/opt/testspeed/testspeed
```

这是前台运行方式。长期运行时可按安装包教程安装 `deploy/testspeed.service` 和 `deploy/testspeed.env.example`。跨平台编译可设置 `GOOS` 和 `GOARCH`，例如 `GOOS=linux GOARCH=arm64`。

### HTTPS

公网建议使用可信证书。可由现有反向代理终止 TLS，也可以让应用直接提供 HTTPS：

```sh
ADDR=:8443 TLS_CERT_FILE=/path/to/fullchain.pem TLS_KEY_FILE=/path/to/key.pem /opt/testspeed/testspeed
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
