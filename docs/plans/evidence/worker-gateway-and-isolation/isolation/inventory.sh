#!/usr/bin/env bash
# What isolation tooling this host has. Read-only; installs nothing.
# One command:  bash inventory.sh > inventory.out
set -u
echo "## host"
uname -srm; grep -m1 'model name' /proc/cpuinfo; nproc; echo "load: $(cat /proc/loadavg)"
echo; echo "## docker"
docker version --format 'client {{.Client.Version}} server {{.Server.Version}}' 2>&1 | cat
docker info --format 'runtimes={{range $k,$v := .Runtimes}}{{$k}} {{end}}default={{.DefaultRuntime}} cgroup=v{{.CgroupVersion}} driver={{.CgroupDriver}} storage={{.Driver}} os={{.OperatingSystem}}' 2>&1 | cat
docker info --format '{{range .SecurityOptions}}{{.}}{{"\n"}}{{end}}' 2>&1 | cat
docker info 2>&1 | grep -E 'Backing Filesystem|Docker Root Dir' | cat
echo "contexts:"; docker context ls 2>&1 | cat
echo "rootless socket: $(ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock" 2>&1)"
echo "system socket: $(ls -l /var/run/docker.sock 2>&1)"
echo "user in docker group: $(id -nG | tr ' ' '\n' | grep -qx docker && echo yes || echo no)"
echo; echo "## other runtimes / sandboxes"
for c in runsc kata-runtime firecracker podman nsjail crun youki firejail dockerd-rootless.sh rootlesskit bwrap systemd-run unshare; do
  printf '%-22s %s\n' "$c" "$(command -v $c || echo absent)"
done
echo; echo "## user namespaces and LSMs"
sysctl kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns kernel.apparmor_restrict_unprivileged_unconfined 2>&1
echo "user.max_user_namespaces = $(cat /proc/sys/user/max_user_namespaces)"
echo "lsm: $(cat /sys/kernel/security/lsm)"
python3 -c 'import ctypes; l=ctypes.CDLL(None); print("landlock ABI:", l.syscall(444, None, 0, 1))' 2>&1
echo "cgroup fs: $(stat -fc %T /sys/fs/cgroup)"
echo "user@ delegated controllers: $(cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.subtree_control 2>&1)"
echo; echo "## probes"
bwrap --ro-bind / / --unshare-all --die-with-parent true; echo "bwrap --unshare-all: exit $?"
unshare -Ur true; echo "unshare -Ur: exit $?"
systemd-run --user --scope --quiet -p MemoryMax=64M -p TasksMax=32 true; echo "systemd-run --user --scope MemoryMax/TasksMax: exit $?"
echo "swap: $(swapon --show=NAME,SIZE,USED --noheadings | tr '\n' ' ')"
