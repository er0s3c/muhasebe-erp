#!/usr/bin/env bash
# Input is data, never a shell command. Sourced by the VPS installer.
LICENSE_IMAGE_REPOSITORY=ghcr.io/er0s3c/muhasebe-erp-license

require_setup_files() {
  local root=$1 file missing=0
  for file in deploy/compose.runtime.yml deploy/compose.host-tunnel.yml deploy/compose.managed-tunnel.yml \
    deploy/Caddyfile.tunnel deploy/init-prod.sh tools/setup-input.sh tools/backup-vps.sh \
    tools/deploy-vps.sh tools/restore-vps.sh tools/configure-deploy.sh tools/resume-setup-vps.sh; do
    if [[ ! -f "$root/$file" ]]; then
      printf 'Eksik kurulum dosyası: %s\n' "$file" >&2
      missing=1
    fi
  done
  if [[ $missing == 1 ]]; then
    echo 'Bu klasörde tam kurulum paketi yok. Düzeltme arşivi tek başına kurulamaz; tam lisans-vps arşivini açıp içindeki tools/setup-vps.sh dosyasını çalıştırın.' >&2
    return 1
  fi
}

trim_input() {
  local value=$1
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

default_image_prompt() {
  local root=$1 image
  # Installer source commits can exist before their container is published.
  # Only use the explicit image recorded when the distribution kit was built.
  if [[ -f "$root/RUNTIME_IMAGE" ]]; then
    image=$(normalize_image_input "$(cat "$root/RUNTIME_IMAGE")") || return 1
    printf 'docker pull %s' "$image"
  fi
}

prompt_input() {
  local target=$1 prompt=$2 initial=${3:-} answer
  if [[ -t 0 ]]; then
    # Readline provides cursor movement, Home/End, Delete and Backspace.
    IFS= read -r -e -i "$initial" -p "$prompt" answer || return 1
  else
    IFS= read -r -p "$prompt" answer || return 1
  fi
  answer=$(trim_input "$answer")
  printf -v "$target" '%s' "${answer:-$initial}"
}

normalize_image_input() {
  local value
  value=$(trim_input "$1")
  if [[ $value =~ ^docker[[:space:]]+pull[[:space:]]+(.+)$ ]]; then
    value=$(trim_input "${BASH_REMATCH[1]}")
  fi
  if [[ $value =~ ^ghcr\.io/er0s3c/muhasebe-erp-license(@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$ ]]; then
    printf '%s' "$value"
  else
    echo 'İmaj geçersiz. docker pull ghcr.io/er0s3c/muhasebe-erp-license:SÜRÜM veya aynı imajın @sha256 adresini girin.' >&2
    return 1
  fi
}

resolve_image_digest() {
  local requested=$1 digests candidate
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$requested") || return 1
  while IFS= read -r candidate; do
    if [[ $candidate =~ ^ghcr\.io/er0s3c/muhasebe-erp-license@sha256:[a-f0-9]{64}$ ]]; then
      if [[ $requested == *@sha256:* && $candidate != "$requested" ]]; then continue; fi
      printf '%s' "$candidate"
      return 0
    fi
  done <<< "$digests"
  echo 'İndirilen imajın sabit SHA256 adresi doğrulanamadı; kurulum ayarları oluşturulmadı.' >&2
  return 1
}
