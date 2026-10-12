# 部署与维护

推荐 Linux 单文件安装：网页已经内嵌，无需 Go、Node.js、Docker 或额外网页目录。默认只开放 **TCP 8080**，使用 WebSocket，固定默认 **8 路**，可在页面调整到 **30 路**。

## 安装

适用于 amd64/ARM64、使用 systemd 的现代 Linux，需 `curl`、`tar`、`sha256sum` 和 sudo：

```sh
curl -fsSL https://raw.githubusercontent.com/lhy8888/testspeed/v0.1.1/deploy/manage.sh | sudo bash -s -- install
```

安装后打开 `http://服务器IP:8080`。允许客户端访问该端口；脚本不会修改防火墙或 Docker。脚本从 [GitHub Releases](https://github.com/lhy8888/testspeed/releases/latest) 下载对应架构的包，校验 SHA256，安装后检查健康状态；失败时自动恢复旧文件和服务状态。

| 内容 | 位置 |
| --- | --- |
| 可执行文件与管理脚本 | `/opt/testspeed/testspeed`、`/opt/testspeed/manage.sh` |
| 配置 | `/etc/testspeed/testspeed.env` |
| systemd 服务 | `/etc/systemd/system/testspeed.service` |

服务通过 systemd `DynamicUser` 以非 root 用户运行。管理脚本需 sudo；不需要手动创建系统账户。

## 更新与常用操作

```sh
sudo /opt/testspeed/manage.sh update
```

更新使用最新正式版，保留现有配置和 unit，并重启服务。指定版本、回退也用同一命令，例如 `sudo /opt/testspeed/manage.sh update v0.1.1`。首次安装也可在 `install` 后指定版本。旧版包缺少管理脚本时，更新保留当前已安装的管理脚本；初次安装应选择 v0.1.1 或更新版本。

| 操作 | 命令 |
| --- | --- |
| 查看服务状态 | `sudo /opt/testspeed/manage.sh status` |
| 查看安装版本 | `sudo /opt/testspeed/manage.sh version` |
| 持续查看日志 | `sudo /opt/testspeed/manage.sh logs`，按 Ctrl+C 退出 |
| 重启 / 停止 | `sudo /opt/testspeed/manage.sh restart` / `sudo /opt/testspeed/manage.sh stop` |
| 卸载，保留配置 | `sudo /opt/testspeed/manage.sh uninstall` |
| 卸载并删除配置 | `sudo /opt/testspeed/manage.sh purge` |

`uninstall` 删除应用、管理脚本、版本文件和服务 unit，保留配置；`purge` 还删除 `testspeed.env`。其他文件和证书不会递归删除，Docker 容器也不会被操作。卸载后管理脚本已经删除；再次清理配置可使用首次安装的 curl 入口，将末尾动作换为 `purge`。

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
| `MAX_CONCURRENT_TEST_REQUESTS` | `128` | 服务端测量请求总上限，范围 1–4096；不是在线用户数 |
| `UPLOAD_SESSION_LIMIT` | `256` | 短期上传会话上限，范围 1–4096 |
| `TEST_DOWNLOAD_DURATION_MS` | `10000` | 下载计量窗口，范围 1000–60000 ms，不含预热 |
| `TEST_UPLOAD_DURATION_MS` | `10000` | 上传计量窗口，范围 1000–60000 ms，不含预热 |
| `TEST_WARMUP_MS` | `1500` | 预热下限，范围 0–10000 ms；网页根据 RTT 自适应延长 |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 空 | 同时指定证书及密钥，直接提供 HTTPS |

默认并发 8 是客户端配置的一部分，没有 `DEFAULT_STREAMS` 环境变量。用户可在页面自行调整。HTTP 单端口连接池有效上限 4 路；四个独立数据端口有效上限 24 路。

</details>

旧版本升级不会覆盖显式的 `MAX_TEST_STREAMS=24`、监听端口或 TLS 设置。要切换到新的单端口 WebSocket、最大 30 路默认配置：

```sh
sudo /opt/testspeed/manage.sh mode websocket
```

这只调整测速传输、测量端口列表及并发上限，保留 `ADDR` 和 TLS 配置；页面默认 8 路，可自行选择其他数量。可选的 `mode http` 启用 HTTP 模式及四个额外数据端口 8081–8084，最大 24 路；应同时允许客户端访问这些端口。

使用自定义 HTTPS 时，更新和模式切换会使用 `PUBLIC_ORIGIN` 检查健康状态。若没有设置公开 origin，可以显式指定健康 URL；私有 CA 可以单独提供，TLS 验证保持开启：

```sh
sudo env TESTSPEED_HEALTH_URL=https://speed.example.com:8443/healthz TESTSPEED_HEALTH_CA=/path/to/ca.pem /opt/testspeed/manage.sh update
```

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
sudo git clone --depth 1 --branch v0.1.1 https://github.com/lhy8888/testspeed.git /opt/testspeed-src
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml up --build --detach
```

Docker Snap 使用其可访问的公共目录，并添加 Snap override：

```sh
sudo git clone --depth 1 --branch v0.1.1 https://github.com/lhy8888/testspeed.git /var/snap/docker/common/testspeed-src
sudo docker compose --project-directory /var/snap/docker/common/testspeed-src -f /var/snap/docker/common/testspeed-src/compose.yaml -f /var/snap/docker/common/testspeed-src/compose.snap.yaml up --build --detach
```

两种方式默认都只发布 8080。Snap 的路径限制可能让 `/opt` 中确实存在的文件报 ENOENT；override 只移除其已知 AppArmor 兼容问题相关的 `no-new-privileges`，保留非 root 用户、只读文件系统和全部 capability drop。我们已验证配置合并和标准 Docker 上的运行；**没有在真实 Snap/AppArmor 内核环境验证**。

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
sudo git -C /opt/testspeed-src checkout v0.1.1
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml up --build --detach
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml logs --follow
```

后续发布时将 checkout 的版本换为对应 tag。保留本地配置和修改；Git 有冲突时先处理修改，不使用强制 reset。`restart`、`stop`、`ps` 也可作为上述 Compose 命令的动作。可选 HTTP 模式再增加 `-f 对应目录/compose.http.yaml`，同时开放数据端口。

卸载该项目的容器和网络：

```sh
sudo docker compose --project-directory /opt/testspeed-src -f /opt/testspeed-src/compose.yaml down
```

`down` 不删除源码，也不影响其他项目的容器。Snap 使用相应公共目录及 Snap override。确认部署不再使用后，源码目录可手动归档或删除；教程不执行递归删除，以免误删本地配置、证书或其他文件。

## 验证范围

安装脚本的校验失败、配置保留、原子替换、失败回滚和定点卸载使用隔离目录及假的 systemctl/curl 做自动测试；这不是实际 systemd 安装证明。实际发布包的下载、SHA 校验、解压及服务启动结果另见 [验证记录](github-validation.md)。
