#!/usr/bin/env sh
set -eu
app_version=$(sed -n 's/^[[:space:]]*Version = "\([^"]*\)"/\1/p' internal/version/version.go)
go_version=$(sed -n 's/^[[:space:]]*Go      = "\([^"]*\)"/\1/p' internal/version/version.go)
module_go=$(awk '$1=="go"{print $2}' go.mod)
tool_go=$(awk '$1=="golang"{print $2}' .tool-versions)
make_version=$(awk '/^VERSION :=/{print $3}' Makefile)
docker_go=$(sed -n 's/^ARG GO_VERSION=//p' Dockerfile)
[ -n "$app_version" ] && [ "$app_version" = "$make_version" ]
[ "$go_version" = "$module_go" ]
[ "$go_version" = "$tool_go" ]
[ "$go_version" = "$docker_go" ]
echo "version=$app_version go=$go_version"
