#!/usr/bin/env bash
# Linux/systemd installation and maintenance. Never sources configuration as code.
set -euo pipefail

action=${1:-help}
argument=${2:-}
if (( $# > 2 )); then printf 'Too many arguments\n' >&2; exit 2; fi

test_root=${TASK_TEST_ROOT:-}
if [[ -n "$test_root" ]]; then
  [[ "$test_root" == /* && "$test_root" != / ]] || { printf 'Invalid TASK_TEST_ROOT\n' >&2; exit 2; }
  [[ -n "${TESTSPEED_SYSTEMCTL:-}" && -n "${TESTSPEED_CURL:-}" ]] || { printf 'Test mode requires explicit fake systemctl and curl\n' >&2; exit 2; }
elif [[ "$action" != help && $(id -u) != 0 ]]; then
  printf 'Run this command with sudo\n' >&2; exit 1
fi

application_directory="$test_root/opt/testspeed"
configuration_directory="$test_root/etc/testspeed"
binary="$application_directory/testspeed"
manager="$application_directory/manage.sh"
version_file="$application_directory/VERSION"
configuration="$configuration_directory/testspeed.env"
unit="$test_root/etc/systemd/system/testspeed.service"
systemctl_command=${TESTSPEED_SYSTEMCTL:-systemctl}
curl_command=${TESTSPEED_CURL:-curl}
stage=''
transaction=0
was_active=0
was_enabled=0
temporary_files=()

fail() { printf 'testspeed: %s\n' "$*" >&2; exit 1; }

managed_path() {
  case "$1" in
    binary) printf '%s' "$binary" ;;
    manager) printf '%s' "$manager" ;;
    version) printf '%s' "$version_file" ;;
    configuration) printf '%s' "$configuration" ;;
    unit) printf '%s' "$unit" ;;
  esac
}

atomic_file() {
  local source=$1 target=$2 mode=$3 temporary
  temporary=$(mktemp "$target.new.XXXXXX")
  temporary_files+=("$temporary")
  install -m "$mode" -- "$source" "$temporary"
  mv -fT -- "$temporary" "$target"
}

backup_installation() {
  local name path
  mkdir -p "$stage/backup"
  for name in binary manager version configuration unit; do
    path=$(managed_path "$name")
    if [[ -e "$path" ]]; then cp -p -- "$path" "$stage/backup/$name"; fi
  done
  if "$systemctl_command" is-active --quiet testspeed.service; then was_active=1; fi
  if "$systemctl_command" is-enabled --quiet testspeed.service; then was_enabled=1; fi
  transaction=1
}

rollback_installation() {
  local name path failed=0
  printf 'Installation failed; restoring the previous files and service state\n' >&2
  "$systemctl_command" stop testspeed.service >/dev/null 2>&1 || true
  if (( ! was_enabled )); then "$systemctl_command" disable testspeed.service >/dev/null 2>&1 || true; fi
  for name in binary manager version configuration unit; do
    path=$(managed_path "$name")
    if [[ -f "$stage/backup/$name" ]]; then
      atomic_file "$stage/backup/$name" "$path" "$(stat -c '%a' "$stage/backup/$name")" || failed=1
    else
      rm -f -- "$path" || failed=1
    fi
  done
  "$systemctl_command" daemon-reload || failed=1
  if (( was_enabled )); then "$systemctl_command" enable testspeed.service >/dev/null || failed=1; fi
  if (( was_active )); then "$systemctl_command" restart testspeed.service || failed=1; fi
  return "$failed"
}

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if (( transaction )); then
    rollback_installation || printf 'Rollback needs attention; check systemctl status testspeed\n' >&2
  fi
  for temporary in "${temporary_files[@]}"; do rm -f -- "$temporary"; done
  if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$result"
}
trap cleanup EXIT

configuration_value() {
  local key=$1 file=$2 line name value=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || continue
    name=${line%%=*}
    name=${name//[[:space:]]/}
    [[ "$name" == "$key" ]] || continue
    value=${line#*=}
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
  done < "$file"
  printf '%s' "$value"
}

health_url() {
  local file=$1 address host port certificate public_origin
  if [[ -n "${TESTSPEED_HEALTH_URL:-}" ]]; then
    [[ "$TESTSPEED_HEALTH_URL" == http://* || "$TESTSPEED_HEALTH_URL" == https://* ]] || fail 'TESTSPEED_HEALTH_URL must use HTTP or HTTPS'
    printf '%s' "$TESTSPEED_HEALTH_URL"; return
  fi
  certificate=$(configuration_value TLS_CERT_FILE "$file")
  if [[ -n "$certificate" || -n "$(configuration_value TLS_KEY_FILE "$file")" ]]; then
    public_origin=$(configuration_value PUBLIC_ORIGIN "$file")
    [[ "$public_origin" == https://* ]] || fail 'TLS is configured: set TESTSPEED_HEALTH_URL to a trusted HTTPS health URL'
    printf '%s/healthz' "${public_origin%/}"; return
  fi
  address=$(configuration_value ADDR "$file")
  address=${address:-:8080}
  [[ "$address" =~ ^(.*):([0-9]+)$ ]] || fail 'Cannot derive health URL from ADDR; set TESTSPEED_HEALTH_URL'
  host=${BASH_REMATCH[1]}; port=${BASH_REMATCH[2]}
  if [[ ${#port} -gt 5 ]] || (( 10#$port < 1 || 10#$port > 65535 )); then fail 'Invalid ADDR port'; fi
  case "$host" in
    ''|0.0.0.0) host=127.0.0.1 ;;
    '[::]') host='[::1]' ;;
  esac
  [[ "$host" =~ ^([a-zA-Z0-9.-]+|\[[a-zA-Z0-9:.%_-]+\])$ ]] || fail 'Cannot safely derive health URL; set TESTSPEED_HEALTH_URL'
  printf 'http://%s:%s/healthz' "$host" "$port"
}

wait_health() {
  local url=$1 expected_version=${2:-} attempt body
  local status_pattern='"status"[[:space:]]*:[[:space:]]*"ok"'
  local version_pattern='"version"[[:space:]]*:[[:space:]]*"([^"]*)"'
  local options=(--fail --silent --show-error --connect-timeout 2 --max-time 3)
  if [[ -n "${TESTSPEED_HEALTH_CA:-}" ]]; then options+=(--cacert "$TESTSPEED_HEALTH_CA"); fi
  for attempt in {1..15}; do
    if body=$("$curl_command" "${options[@]}" "$url" 2>/dev/null) && "$systemctl_command" is-active --quiet testspeed.service; then
      if [[ "$body" == \{*\} && "$body" =~ $status_pattern ]]; then
        if [[ -z "$expected_version" ]]; then return; fi
        if [[ "$body" =~ $version_pattern && "${BASH_REMATCH[1]}" == "$expected_version" ]]; then return; fi
      fi
    fi
    if (( attempt < 15 )); then sleep 1; fi
  done
  fail 'Service did not become healthy; the update will be rolled back'
}

extract_package() {
  local archive=$1 member listing
  mkdir -p "$stage/payload"
  tar -tzf "$archive" > "$stage/members"
  for member in testspeed testspeed.service testspeed.env.example manage.sh VERSION; do
    if ! grep -Fxq -- "$member" "$stage/members"; then
      case "$member" in manage.sh|VERSION) continue ;; *) fail "Package is missing $member" ;; esac
    fi
    listing=$(tar -tvzf "$archive" -- "$member")
    [[ "$listing" == -* && "$listing" != *$'\n'* ]] || fail "Package member must be a single regular file: $member"
    tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$stage/payload" -- "$member"
  done
}

install_package() {
  local version=${argument:-latest} architecture archive_name base_url checksum_line health_config url package_version expected_health_version=''
  [[ "$version" == latest || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Use a stable version such as v0.1.1, or omit the version for latest'
  if [[ "$action" == update && ! -f "$binary" ]]; then fail 'No installation found; use install'; fi
  case "$(uname -m)" in x86_64|amd64) architecture=amd64 ;; aarch64|arm64) architecture=arm64 ;; *) fail 'Supported Linux architectures: amd64 and arm64' ;; esac
  archive_name="testspeed-linux-$architecture.tar.gz"
  stage=$(mktemp -d /tmp/testspeed-install.XXXXXX)
  if [[ -n "${TESTSPEED_ARCHIVE:-}" || -n "${TESTSPEED_CHECKSUMS:-}" ]]; then
    [[ -n "${TESTSPEED_ARCHIVE:-}" && -n "${TESTSPEED_CHECKSUMS:-}" ]] || fail 'Provide TESTSPEED_ARCHIVE and TESTSPEED_CHECKSUMS together'
    cp -- "$TESTSPEED_ARCHIVE" "$stage/$archive_name"
    cp -- "$TESTSPEED_CHECKSUMS" "$stage/SHA256SUMS"
  else
    base_url=https://github.com/lhy8888/testspeed/releases
    if [[ "$version" == latest ]]; then base_url+=/latest/download; else base_url+="/download/$version"; fi
    "$curl_command" --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$stage/$archive_name" "$base_url/$archive_name"
    "$curl_command" --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$stage/SHA256SUMS" "$base_url/SHA256SUMS"
  fi
  checksum_line=$(awk -v wanted="$archive_name" '{ name=$2; sub(/^\*/, "", name); if (name==wanted) print }' "$stage/SHA256SUMS")
  [[ -n "$checksum_line" && "$checksum_line" != *$'\n'* ]] || fail 'Checksum list must contain exactly one entry for this archive'
  printf '%s\n' "$checksum_line" > "$stage/selected-checksum"
  (cd "$stage"; sha256sum --check --strict selected-checksum)
  extract_package "$stage/$archive_name"
  [[ -f "$stage/payload/manage.sh" || -f "$manager" ]] || fail 'This old package has no management script; install v0.1.1 or later first'
  package_version=$version
  if [[ -f "$stage/payload/VERSION" ]]; then
    package_version=$(cat "$stage/payload/VERSION")
    [[ "$package_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Invalid package VERSION'
    [[ "$version" == latest || "$package_version" == "$version" ]] || fail 'Package VERSION does not match the requested tag'
    expected_health_version=$package_version
  fi
  health_config=$configuration
  if [[ ! -f "$health_config" ]]; then health_config="$stage/payload/testspeed.env.example"; fi
  url=$(health_url "$health_config")
  install -d -m 0755 "$application_directory" "$configuration_directory" "$(dirname "$unit")"
  backup_installation
  atomic_file "$stage/payload/testspeed" "$binary" 0755
  if [[ -f "$stage/payload/manage.sh" ]]; then atomic_file "$stage/payload/manage.sh" "$manager" 0755; fi
  if [[ ! -f "$configuration" ]]; then atomic_file "$stage/payload/testspeed.env.example" "$configuration" 0644; fi
  if [[ ! -f "$unit" ]]; then atomic_file "$stage/payload/testspeed.service" "$unit" 0644; fi
  printf '%s\n' "$package_version" > "$stage/version"
  atomic_file "$stage/version" "$version_file" 0644
  "$systemctl_command" daemon-reload
  if [[ "$action" == install ]]; then "$systemctl_command" enable testspeed.service; fi
  "$systemctl_command" restart testspeed.service
  wait_health "$url" "$expected_health_version"
  transaction=0
  printf 'testspeed %s ready. Binary: %s; configuration: %s\n' "$package_version" "$binary" "$configuration"
}

set_mode() {
  [[ -f "$binary" && -f "$configuration" ]] || fail 'Install testspeed first'
  local transport=$argument ports='' maximum=30 url expected_health_version=''
  case "$transport" in websocket) ;; http) ports=8081,8082,8083,8084; maximum=24 ;; *) fail 'Use mode websocket or mode http' ;; esac
  stage=$(mktemp -d /tmp/testspeed-install.XXXXXX)
  awk -v transport="$transport" -v ports="$ports" -v maximum="$maximum" '
    BEGIN { wanted["TEST_TRANSPORT"]=transport; wanted["MEASUREMENT_PORTS"]=ports; wanted["MEASUREMENT_ORIGINS"]=""; wanted["MAX_TEST_STREAMS"]=maximum }
    /^[[:space:]]*[A-Z_]+[[:space:]]*=/ { key=$0; sub(/=.*/, "", key); gsub(/[[:space:]]/, "", key); if (key in wanted) { if (!seen[key]++) print key "=" wanted[key]; next } }
    { print }
    END { for (key in wanted) if (!seen[key]) print key "=" wanted[key] }
  ' "$configuration" > "$stage/mode.env"
  url=$(health_url "$stage/mode.env")
  backup_installation
  atomic_file "$stage/mode.env" "$configuration" "$(stat -c '%a' "$configuration")"
  "$systemctl_command" restart testspeed.service
  if [[ -f "$version_file" ]]; then
    expected_health_version=$(cat "$version_file")
    if [[ "$expected_health_version" == v0.1.0 || ! "$expected_health_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then expected_health_version=''; fi
  fi
  wait_health "$url" "$expected_health_version"
  transaction=0
  printf 'Transport: %s; maximum streams: %s. Existing ADDR/TLS settings preserved.\n' "$transport" "$maximum"
}

remove_installation() {
  [[ -z "$argument" ]] || fail 'This action takes no version argument'
  if [[ -f "$unit" ]]; then
    "$systemctl_command" disable --now testspeed.service
    rm -f -- "$unit"
    "$systemctl_command" daemon-reload
  fi
  rm -f -- "$binary" "$manager" "$version_file"
  rmdir "$application_directory" 2>/dev/null || true
  if [[ "$action" == purge ]]; then
    rm -f -- "$configuration"
    rmdir "$configuration_directory" 2>/dev/null || true
    printf 'Removed managed application, unit and configuration files\n'
  else
    printf 'Removed application; configuration retained at %s\n' "$configuration"
  fi
}

case "$action" in
  install|update) install_package ;;
  mode) set_mode ;;
  status) "$systemctl_command" status --no-pager testspeed.service ;;
  logs)
    if [[ -n "$test_root" && -z "${TESTSPEED_JOURNALCTL:-}" ]]; then fail 'Test logs require an explicit fake journalctl'; fi
    "${TESTSPEED_JOURNALCTL:-journalctl}" --unit testspeed.service --lines 50 --follow ;;
  restart|stop) "$systemctl_command" "$action" testspeed.service ;;
  version) [[ -f "$version_file" ]] || fail 'No installed version metadata'; cat "$version_file" ;;
  uninstall|purge) remove_installation ;;
  help) printf 'Usage: manage.sh install|update [vX.Y.Z]\n       manage.sh mode websocket|http\n       manage.sh status|version|logs|restart|stop|uninstall|purge\n' ;;
  *) fail 'Unknown action; use help' ;;
esac
