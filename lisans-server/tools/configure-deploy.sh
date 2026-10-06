#!/usr/bin/env bash
# Root configures a dedicated account; its key can execute ONLY the immutable-digest deployment command.
set -euo pipefail
[[ $EUID == 0 && $# == 1 && -f $1 ]] || { echo 'sudo erp-license-configure-deploy /tam/yol/deploy.pub'; exit 1; }
key=$(cat "$1")
[[ $key != *$'\n'* ]] || exit 1
read -r type data _ <<< "$key"
[[ $type == ssh-ed25519 && $data =~ ^[A-Za-z0-9+/=]+$ ]] || { echo 'Tek bir Ed25519 açık anahtar gerekli.'; exit 1; }
ssh-keygen -lf "$1" >/dev/null
user=erp-license-deploy
if ! id "$user" >/dev/null 2>&1; then useradd --create-home --shell /bin/bash "$user"; fi
home=$(getent passwd "$user" | cut -d: -f6)
[[ $home == /home/erp-license-deploy ]] || { echo 'Dağıtım hesabı beklenen dizinde değil'; exit 1; }
# Not a Docker-group member: access to the Docker socket would grant unrestricted root.
if id -nG "$user" | tr ' ' '\n' | grep -qx docker; then gpasswd -d "$user" docker; fi
chown root:root "$home"; chmod 755 "$home"
install -d -m 755 -o root -g root "$home/.ssh"
printf 'restrict,command="sudo -n /usr/local/sbin/erp-license-deploy" %s %s\n' "$type" "$data" > "$home/.ssh/authorized_keys"
chmod 644 "$home/.ssh/authorized_keys"; chown root:root "$home/.ssh/authorized_keys"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/erp-license-deploy ""\n' "$user" > /etc/sudoers.d/erp-license-deploy
chmod 440 /etc/sudoers.d/erp-license-deploy
visudo -cf /etc/sudoers.d/erp-license-deploy
echo 'GitHub: LICENSE_DEPLOY_USER=erp-license-deploy. SSH kimliğini başka güvenilir kanaldan doğrulayarak KNOWN_HOSTS kaydedin.'
