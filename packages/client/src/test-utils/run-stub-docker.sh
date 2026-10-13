#!/bin/bash
# The docker CLI that createStubDockerBin puts on PATH: an amd64 host engine
# with the Dockerfile frontend, for impd's host builds and adds. The directory
# above its own holds docker.log, which gets each call's arguments; images, a
# `<ref> <id>` line per image the engine has (the id without `sha256:`);
# inspect/<id>.json, that image's `image inspect` answer; and exports/<id>.tar,
# the files of a container made from it. It pulls nothing, and any call it
# lacks fails and names itself.
root=${0%/*}/..
echo "$*" >>"$root/docker.log"

# the id of the image named $1; fails for an image the engine lacks
find_image() {
  local ref id
  while read -r ref id; do
    if [[ $ref == "$1" ]]; then
      echo "$id"
      return 0
    fi
  done <"$root/images"
  return 1
}

case "$*" in
  "version --format "*) echo '"linux" "amd64"' ;;
  "image inspect --format {{.Id}} docker/dockerfile:"*)
    echo 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    ;;
  "export "*) cat "$root/exports/$2.tar" ;;
  "rm -f "*) ;;
  *)
    if [[ $# -eq 3 && "$1 $2" == "image inspect" ]] && id=$(find_image "$3"); then
      cat "$root/inspect/$id.json"
    elif [[ $# -eq 3 && $1 == create && $3 == /bin/true ]] && id=$(find_image "$2"); then
      echo "$id"
    else
      echo "the stub docker has no $*" >&2
      exit 1
    fi
    ;;
esac
