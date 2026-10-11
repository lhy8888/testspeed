#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repository_root"

for required_file in README.md deploy/testspeed.service deploy/testspeed.env.example; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Missing package file: %s\n' "$required_file" >&2
    exit 1
  fi
done

distribution_directory="$repository_root/artifacts/dist"
staging_directory="$repository_root/bin/release"
mkdir -p "$distribution_directory" "$staging_directory"

targets=(
  linux/amd64
  linux/arm64
  linux/386
  darwin/amd64
  darwin/arm64
  windows/amd64
  windows/arm64
  freebsd/amd64
)
archives=()

for target in "${targets[@]}"; do
  target_os=${target%/*}
  target_architecture=${target#*/}
  package_name="testspeed-$target_os-$target_architecture"
  package_directory="$staging_directory/$package_name"
  mkdir -p "$package_directory"

  extension=''
  if [[ "$target_os" == windows ]]; then extension='.exe'; fi
  application_name="testspeed$extension"
  client_name="throughput$extension"

  printf 'Building %s\n' "$package_name"
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_architecture" \
    go build -trimpath -ldflags='-s -w' -o "$package_directory/$application_name" .
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_architecture" \
    go build -trimpath -ldflags='-s -w' -o "$package_directory/$client_name" ./tools/throughput

  cp README.md "$package_directory/README.md"
  cp deploy/testspeed.service "$package_directory/testspeed.service"
  cp deploy/testspeed.env.example "$package_directory/testspeed.env.example"
  chmod 755 "$package_directory/$application_name" "$package_directory/$client_name"
  chmod 644 "$package_directory/README.md" "$package_directory/testspeed.service" "$package_directory/testspeed.env.example"

  archive_name="$package_name.tar.gz"
  tar -czf "$distribution_directory/$archive_name" -C "$package_directory" \
    "$application_name" "$client_name" README.md testspeed.service testspeed.env.example
  archives+=("$archive_name")
done

(
  cd "$distribution_directory"
  sha256sum "${archives[@]}" > SHA256SUMS
  sha256sum --check SHA256SUMS
)
printf 'Release packages: %s\n' "$distribution_directory"
