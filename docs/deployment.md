# 部署与维护

推荐 Linux 单文件安装：网页已经内嵌，无需 Go、Node.js、Docker 或额外网页目录。默认只开放 **TCP 8080**，使用 WebSocket，固定默认 **8 路**，可在页面调整到 **30 路**。

## 安装

适用于 amd64/ARM64、使用 systemd 的现代 Linux，需 `curl`、`tar`、`sha256sum` 和 sudo：

```sh
curl -fsSL https://raw.githubusercontent.com/lhy8888/testspeed/v0.1.4/deploy/manage.sh | sudo bash -s -- install
```

安装后打开 `http://服务器IP:8080`。允许客户端访问该端口；脚本不会修改防火墙或 Docker。脚本从 [GitHub Releases](https://github.com/lhy8888/testspeed/releases/latest) 下载对应架构的包，校验 SHA256，安装后检查健康状态；失败时自动恢复旧文件和服务状态。

| 内容 | 位置 |
| --- | --- |
| 可执行文件与管理脚本 | `/opt/testspeed/testspeed`、`/opt/testspeed/manage.sh` |
| 配置 | `/etc/testspeed/testspeed.env` |
| systemd 服务 | `/etc/systemd/system/testspeed.service` |
| 可选分享数据 | `/var/lib/testspeed/results.sqlite`，关闭分享时不使用 |

服务通过 systemd `DynamicUser` 以非 root 用户运行。管理脚本需 sudo；不需要手动创建系统账户。

### 直接下载安装包

自动安装脚本支持现代 Linux amd64 / ARM64。其他目标可从下列 v0.1.4 链接下载；先对照 [SHA256SUMS](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/SHA256SUMS) 校验，再解压运行 `testspeed`（Windows 为 `testspeed.exe`）。这些包均已内嵌网页，无需 Go、Node.js 或系统 SQLite。包中的 systemd 管理脚本只适用于 Linux。

| 平台 | 安装包 |
| --- | --- |
| Linux amd64 | [testspeed-linux-amd64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-linux-amd64.tar.gz) |
| Linux ARM64 | [testspeed-linux-arm64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-linux-arm64.tar.gz) |
| Linux x86 32 位 | [testspeed-linux-386.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-linux-386.tar.gz) |
| macOS Intel | [testspeed-darwin-amd64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-darwin-amd64.tar.gz) |
| macOS Apple Silicon | [testspeed-darwin-arm64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-darwin-arm64.tar.gz) |
| Windows x64 | [testspeed-windows-amd64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-windows-amd64.tar.gz) |
| Windows ARM64 | [testspeed-windows-arm64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-windows-arm64.tar.gz) |
| FreeBSD amd64 | [testspeed-freebsd-amd64.tar.gz](https://github.com/lhy8888/testspeed/releases/download/v0.1.4/testspeed-freebsd-amd64.tar.gz) |

## 更新与常用操作

```sh
sudo /opt/testspeed/manage.sh update
```

更新使用最新正式版，保留现有配置和 unit，并重启服务。指定版本、回退也用同一命令，例如 `sudo /opt/testspeed/manage.sh update v0.1.4`。首次安装也可在 `install` 后指定版本。旧版包缺少管理脚本时，更新保留当前已安装的管理脚本；初次安装应选择 v0.1.1 或更新版本。

| 操作 | 命令 |
| --- | --- |
| 查看服务状态 | `sudo /opt/testspeed/manage.sh status` |
| 查看安装版本 | `sudo /opt/testspeed/manage.sh version` |
| 持续查看日志 | `sudo /opt/testspeed/manage.sh logs`，按 Ctrl+C 退出 |
| 重启 / 停止 | `sudo /opt/testspeed/manage.sh restart` / `sudo /opt/testspeed/manage.sh stop` |
| 卸载，保留配置 | `sudo /opt/testspeed/manage.sh uninstall` |
| 卸载并删除配置 | `sudo /opt/testspeed/manage.sh purge` |

`uninstall` 删除应用、管理脚本、版本文件和服务 unit，保留配置；`purge` 还删除 `testspeed.env`。其他文件和证书不会递归删除，Docker 容器也不会被操作。卸载后管理脚本已经删除；再次清理配置可使用首次安装的 curl 入口，将末尾动作换为 `purge`。

可选分享数据库及 Docker 数据卷也会保留。需要删除分享记录时先停用分享，再按下文的数据维护步骤单独处理。

## 页面功能与测试预算

首页保持下载数字为主，点击“更多信息 / Show more info”显示指标与设置；语言可选择中文或 English。页面加载不会自动消耗测速流量。

| 测试项目 | 实际运行 |
| --- | --- |
| 完整测速 `full`（默认） | 空闲延迟、下载、上传及对应负载延迟 |
| 仅下载 `download` | 空闲延迟与下载，跳过上传流量 |
| 仅延迟 `latency` | 小型 HTTP 往返请求，跳过下载和上传测速 |

默认固定完整时长，每方向正式计量 10 秒，预热下限 1.5 秒；网页按 RTT 延长预热。收到真实下载数据即可显示灰色预热速度，最终结果排除预热，下载完成后立即固定，上传结束后再显示上传结果。

自适应时长为可选设置。每方向正式计量至少 `max(5 秒, 8 × RTT)`，多个真实吞吐窗口达到稳定条件，且无请求失败、测量调度异常时才提前结束；自动并发模式还需完成并发收敛。未达到稳定条件时继续到所选最长时长。它不按显示速度倍率或动画生成结果；上传提前结束必须由服务器冻结实际实收字节与计量时长。

流量预算按**每方向**独立设置，0 表示不限，包含该方向的预热。预算是测量数据量阈值，存在已在途消息、每路读取缓冲和有界关闭排空的余量，并非严格的网卡流量封顶；结果记录实际计量字节和预算余量。预算在预热期间耗尽且没有正式计量数据时显示“未测”，已有短测量窗口的结果会标明“达到预算”，不能据此保证 TCP 已充分扩窗。固定时长也可配合预算使用。

### 稳定性、历史与导出

从更多信息打开 `/stability.html`，可采样 1、2 或 5 分钟，显示当前/平均/最低/最高 HTTP 往返时间、P50/P95/P99、相邻成功请求的抖动、请求失败率和 CSV。每次只有一个小型请求，不开展下载或上传测速；慢请求会降低采样频率。页面进入后台、离线或点击停止时会终止测试。**HTTP 请求失败率不是网络丢包率**，失败请求也不会填入延迟分布。

网页保留最近 50 条本地测速历史，可导出当前记录的 JSON、CSV、PNG，或导出全部历史 CSV；清理历史只影响当前浏览器。历史和导出使用允许的测速指标，排除客户端 IP、所在地及令牌，不自动发送给服务器。浏览器禁止本地存储时仍可测速，持久历史可能不可用。

## 配置与旧版本迁移

修改配置后执行 `restart`。例如改变网页端口：

```sh
sudo sed -i 's/^ADDR=.*/ADDR=:9000/' /etc/testspeed/testspeed.env
sudo /opt/testspeed/manage.sh restart
```

随后访问 `http://服务器IP:9000`。HTTPS 可在配置中设置 `TLS_CERT_FILE`、`TLS_KEY_FILE` 和 `PUBLIC_ORIGIN`；证书权限需允许服务用户读取。

<details>
<summary>环境变量与默认值</summary>

以下为应用默认值；安装包的示例配置还设置 `NODE_ID=node-1`。修改配置后重启生效。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ADDR` | `:8080` | 网页和测速监听地址 |
| `TEST_TRANSPORT` | `websocket` | 默认单端口；可选 `http` |
| `MAX_TEST_STREAMS` | `30` | 单次并发上限，范围 1–30；页面默认固定 8 路，上限低于 8 时相应降低 |
| `MEASUREMENT_PORTS` | 空 | 可选 HTTP 数据端口列表；空值不监听额外端口 |
| `PUBLIC_ORIGIN` | 自动推导 | 客户端实际访问的 HTTP/HTTPS origin，不含路径 |
| `MEASUREMENT_ORIGINS` | 自动推导 | 可选 HTTP 测速 origin 列表，显式指定时必须同时设置 `PUBLIC_ORIGIN` |
| `NODE_ID` | `local` | 节点标识 |
| `NODE_NAME` | `默认测速节点` | 节点名称 |
| `SERVER_LOCATION` | 空 | 手动设置服务器所在地文本，优先于自动查询，例如 `中国·上海` |
| `GEOIP_ENABLED` | `true` | 开启 IP 信息查询；`false` 禁用在线和离线查询，保留手填标签 |
| `GEOIP_PROVIDER` | `auto` | `auto` 在线优先、可选 MMDB 补缺/降级；`online` 仅在线；`offline` 仅本地库 |
| `GEOIP_DB_PATH` | 空 | 可选只读授权 MMDB 路径；离线模式必须设置 |
| `CLIENT_NETWORK_LABEL` | 空 | 非公开客户端地址的手填内网标签，例如 `上海园区` |
| `TRUSTED_PROXIES` | 空 | 可信代理 IP/CIDR，逗号分隔；默认忽略转发头，仅使用连接对端 IP |
| `SHARE_DB_PATH` | 空 | 可选 SQLite 分享数据库路径；空值关闭服务端保存 |
| `SHARE_WRITE_TOKEN` | 空 | 可选分享写入令牌，不影响测速；浏览器点击分享时提交 |
| `SHARE_RETENTION_HOURS` | `168` | 分享保留时长，范围 1–8760 小时；过期自动清理 |
| `SHARE_MAX_RESULTS` | `10000` | 分享容量，范围 128–100000；达到上限清理最早记录 |
| `MAX_CONCURRENT_TEST_REQUESTS` | `128` | 服务端测量请求总上限，范围 1–4096；不是在线用户数 |
| `UPLOAD_SESSION_LIMIT` | `256` | 短期上传会话上限，范围 1–4096 |
| `TEST_DOWNLOAD_DURATION_MS` | `10000` | 下载计量窗口，范围 1000–60000 ms，不含预热 |
| `TEST_UPLOAD_DURATION_MS` | `10000` | 上传计量窗口，范围 1000–60000 ms，不含预热 |
| `TEST_WARMUP_MS` | `1500` | 预热下限，范围 0–10000 ms；网页根据 RTT 自适应延长 |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 空 | 同时指定证书及密钥，直接提供 HTTPS |

默认并发 8 是客户端配置的一部分，没有 `DEFAULT_STREAMS` 环境变量。用户可在页面自行调整。HTTP 单端口连接池有效上限 4 路；四个独立数据端口有效上限 24 路。

</details>

### IP、所在地与 ISP/ASN

默认使用 FreeIPAPI 的固定 HTTPS 接口 `https://free.freeipapi.com/api/json/{ip}`，将公开客户端 IP 发送给第三方查询。结果是 IP 网络的近似所在地，不是 GPS，也不保证设备或机房的物理位置；私网、回环等非公开地址不会发送给第三方。断网、查询失败、限速或额度耗尽只影响所在地显示，不阻止测速。

ISP/ASN 按服务商或本地数据库实际返回的字段显示；缺失时留空，不会根据所在地猜测运营商。`GEOIP_PROVIDER=auto` 默认在线查询，配置 MMDB 后补充缺失的所在地/ISP/ASN，并在网络失败或限额时降级；没有库时仍可正常使用在线服务。`online` 仅使用在线结果；`offline` 不进行第三方调用，需要本地库。

服务器所在地优先使用手动设置的 `SERVER_LOCATION`。未设置且启用 GeoIP 时，自动查询只能近似反映服务器的公网出口，代理或 NAT 可能使其不同于实际机房。企业内网可在 `/etc/testspeed/testspeed.env` 中使用：

```ini
SERVER_LOCATION=中国·上海
GEOIP_ENABLED=false
CLIENT_NETWORK_LABEL=上海园区
```

然后执行 `sudo /opt/testspeed/manage.sh restart`。禁用 GeoIP 后仍显示连接来源 IP 和已配置的服务器位置。

经过反向代理时，仅配置该代理实际使用的地址或 CIDR，例如 `TRUSTED_PROXIES=127.0.0.1/32,::1/128`。默认不信任 `Forwarded` / `X-Forwarded-For`；启用后从连接对端开始，自右向左剥离可信代理，使用遇到的首个非可信地址。两类转发头并存时，解析出的客户端必须一致；无效、过长或歧义头回退到实际连接对端。代理应清洗并追加转发头，避免把用户自填的头当作来源。

FreeIPAPI 免费接口额度按服务器公网出口共享，当前为 60 次/分钟。应用采用持续 40 次/分钟、最多 4 次突发的令牌桶，并使用有上限的短期缓存；多个实例共用出口时仍可能触发服务商限额。页面异步加载这些信息，测速流程不等待 GeoIP。

#### 可选离线 MMDB

自行从数据提供方获取与你用途匹配、授权正确的 MMDB；程序不会下载数据库，也不把运行时数据库打包进发布文件。支持 IPinfo Country/ASN/Lite，以及 MaxMind City、Country、ASN、ISP、Enterprise 的相应 schema；Country/ASN 库不保证提供城市。数据库本身的许可独立于应用。

将已取得的数据库放到服务可读路径，例如：

```sh
sudo install -m 0644 ./geoip.mmdb /etc/testspeed/geoip.mmdb
```

在配置中设置并重启：

```ini
GEOIP_PROVIDER=offline
GEOIP_DB_PATH=/etc/testspeed/geoip.mmdb
SERVER_LOCATION=中国·上海
```

离线库无法探测服务器的公网出口，服务器机房应手动设置。要保留在线查询和离线降级，将 provider 改为 `auto`。明确配置的库不存在、不可读或 schema 不受支持时，服务会启动失败，先查看日志并修正路径。更新库后重启以加载新文件；保留原库便于恢复。

旧版本升级不会覆盖显式的 `MAX_TEST_STREAMS=24`、监听端口或 TLS 设置。要切换到新的单端口 WebSocket、最大 30 路默认配置：

```sh
sudo /opt/testspeed/manage.sh mode websocket
```

这只调整测速传输、测量端口列表及并发上限，保留 `ADDR` 和 TLS 配置；页面默认 8 路，可自行选择其他数量。可选的 `mode http` 启用 HTTP 模式及四个额外数据端口 8081–8084，最大 24 路；应同时允许客户端访问这些端口。

使用自定义 HTTPS 时，更新和模式切换会使用 `PUBLIC_ORIGIN` 检查健康状态。若没有设置公开 origin，可以显式指定健康 URL；私有 CA 可以单独提供，TLS 验证保持开启：

```sh
sudo env TESTSPEED_HEALTH_URL=https://speed.example.com:8443/healthz TESTSPEED_HEALTH_CA=/path/to/ca.pem /opt/testspeed/manage.sh update
```

## 可选结果分享

默认不启用服务器数据库。最近 50 条历史和 JSON/CSV/PNG 导出均可直接使用，不需要开启分享。分享按钮将选中的测速报告显式提交到本服务器，记录不包含客户端 IP、地理位置或令牌；报告由客户端提交，**不是服务器认证的速度证明**。

Linux 管理脚本安装后，启用或关闭都用一条命令：

```sh
sudo /opt/testspeed/manage.sh share on
```

`on` 设置 `SHARE_DB_PATH=/var/lib/testspeed/results.sqlite`，为新旧 systemd 安装提供所需的 `StateDirectory=testspeed` 并重启；仍以非 root 身份运行。默认最多 10000 条，保留 168 小时。修改保留时长、容量或可选 `SHARE_WRITE_TOKEN` 后重启；启用令牌时，网页仅在点击分享时要求输入，不写入本地历史或共享链接。令牌保护创建报告，读取仍通过不可预测的分享地址访问。

```sh
sudo /opt/testspeed/manage.sh share off
```

`off` 关闭新建/读取分享接口并重启，保留数据库；再次开启可读取仍未过期的记录。分享完成后可在当前页面撤销刚创建的链接，撤销凭据仅保留在当前页面，不等同于写入令牌。公开分享链接不应包含服务端令牌。

### 分享数据维护

更新、停用、`uninstall` 和 `purge` 均保留 SQLite 分享数据；管理脚本不会递归删除数据目录。备份先 `stop`，复制 `/var/lib/testspeed/results.sqlite`，再 `restart`，避免复制写入中的数据库。恢复时先停止服务，替换同一路径文件并保留服务原有属主和权限，再启动。Docker 使用下文的持久数据卷。

只有确认不再需要任何分享记录时，停用分享后显式删除这个数据库：

```sh
sudo rm -- /var/lib/testspeed/results.sqlite
```

该操作删除所有已保存分享，不会清理浏览器中的本地历史；数据库仍保留时，卸载再安装不会替你清除旧记录。

## 离线企业内网

在联网电脑从 [正式发布页](https://github.com/lhy8888/testspeed/releases/latest) 下载匹配架构的压缩包和 `SHA256SUMS`，一起带入内网服务器。以 amd64 为例，在下载目录执行：

```sh
grep '  testspeed-linux-amd64.tar.gz$' SHA256SUMS | sha256sum --check --strict
tar -xzf testspeed-linux-amd64.tar.gz manage.sh
sudo env TESTSPEED_ARCHIVE="$PWD/testspeed-linux-amd64.tar.gz" TESTSPEED_CHECKSUMS="$PWD/SHA256SUMS" bash manage.sh install
```

ARM64 将文件名中的 `amd64` 换为 `arm64`。脚本再次校验包，不访问 GitHub；两条本地路径必须一起提供。离线更新把最后的 `install` 改为 `update`。

## Docker 部署

需要已经安装的 Docker Engine、现代 Compose 和 Git；不需要宿主机安装 Go / Node.js。单文件安装与 Docker 安装选择一种，避免抢占同一端口。

官方 Docker Engine：

```sh
sudo git clone --depth 1 --branch v0.1.4 https://github.com/lhy8888/testspeed.git /opt/testspeed-src
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml up --build --detach
```

Docker Snap 使用其可访问的公共目录，并添加 Snap override：

```sh
sudo git clone --depth 1 --branch v0.1.4 https://github.com/lhy8888/testspeed.git /var/snap/docker/common/testspeed-src
sudo docker compose --project-directory /var/snap/docker/common/testspeed-src -f /var/snap/docker/common/testspeed-src/compose.yaml -f /var/snap/docker/common/testspeed-src/compose.snap.yaml up --build --detach
```

两种方式默认都只发布 8080。Snap 的路径限制可能让 `/opt` 中确实存在的文件报 ENOENT；override 只移除其已知 AppArmor 兼容问题相关的 `no-new-privileges`，保留非 root 用户、只读文件系统和全部 capability drop。我们已验证配置合并和标准 Docker 上的运行；**没有在真实 Snap/AppArmor 内核环境验证**。

### Docker 可选分享与数据库

在基础配置后增加 `compose.share.yaml`，使用配置名为 `testspeed-results` 的持久数据卷（实际卷名通常带项目名前缀），SQLite 路径同为 `/var/lib/testspeed/results.sqlite`：

```sh
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml -f /opt/testspeed-src/compose.share.yaml up --build --detach
```

Snap 使用公共源码目录，并同时加上 `compose.snap.yaml`。后续 `up`、更新、日志和 `down` 都沿用所选 override；关闭分享时停止该项目后只用基础配置重新启动。可选分享令牌、保留时长和容量按 override 中的环境变量设置；服务器测速进程继续保持非 root、只读根文件系统及 capability drop，只有数据目录可写。

Docker 需要离线 GeoIP 时，自行创建只读挂载 override：把已获授权的宿主机 MMDB bind 到容器 `/etc/testspeed/geoip.mmdb`，设置 `GEOIP_DB_PATH` 和所选 provider。宿主机文件须允许容器用户读取，Snap 还须使用可访问的公共路径；库文件不会由容器自动下载。

已有源码放在 `/opt` 且 Docker 来自 `/snap/bin/docker` 时，可复制到公共目录再运行，保留原目录：

```sh
sudo install -d -m 0755 /var/snap/docker/common/testspeed-src
sudo cp -a /opt/testspeed-src/. /var/snap/docker/common/testspeed-src/
```

确认该副本包含 `compose.snap.yaml`；旧 v0.1.0 没有该文件，应先按下面步骤更新。不要为此重装 Docker 或删除现有容器。

### Docker 更新与维护

官方 Docker 的源码目录是 `/opt/testspeed-src`；Snap 将下面命令中的目录改为 `/var/snap/docker/common/testspeed-src`，并在每个 Compose 命令后增加 `-f /var/snap/docker/common/testspeed-src/compose.snap.yaml`，放在 `up` / `logs` / `down` 之前。

```sh
sudo git -C /opt/testspeed-src fetch --tags origin
sudo git -C /opt/testspeed-src checkout v0.1.4
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml up --build --detach
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml logs --follow
```

后续发布时将 checkout 的版本换为对应 tag。保留本地配置和修改；Git 有冲突时先处理修改，不使用强制 reset。`restart`、`stop`、`ps` 也可作为上述 Compose 命令的动作。可选 HTTP 模式再增加 `-f 对应目录/compose.http.yaml`，同时开放数据端口。

卸载该项目的容器和网络：

```sh
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml down
```

`down` 不删除源码、分享数据卷，也不影响其他项目的容器。Snap 使用相应公共目录及 Snap override；分享部署保留 share override。确认部署不再使用后，源码目录可手动归档或删除；教程不执行递归删除。`down --volumes` 会删除本项目的持久分享数据，仅在确认需要清除全部记录时使用。

## 验证范围

安装脚本的校验失败、配置保留、原子替换、失败回滚和定点卸载使用隔离目录及假的 systemctl/curl 做自动测试；这不是实际 systemd 安装证明。实际发布包的下载、SHA 校验、解压及服务启动结果另见 [验证记录](github-validation.md)。
