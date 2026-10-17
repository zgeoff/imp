# shellcheck shell=bash
# . load-env-file.sh FILE: export each KEY=value line of FILE into the
# shell that sources it, read as docker run --env-file reads a file: no
# expansion, quotes kept, leading space and a trailing CR dropped, blank
# lines and # comments skipped. A bare KEY line, which docker would take from
# its own environment, is skipped. host/entrypoint sources it for
# IMP_ENV_FILE, which the NixOS module mounts from tmpfs, so the settings
# and secrets never reach Docker's config on the host's disk.
#
# A value may be secret, so an error names the line, never its text.

load_env_file_line=0
while IFS= read -r load_env_file_text || [ -n "$load_env_file_text" ]; do
  load_env_file_line=$((load_env_file_line + 1))
  load_env_file_text=${load_env_file_text%$'\r'}
  load_env_file_text=${load_env_file_text#"${load_env_file_text%%[![:space:]]*}"}
  case $load_env_file_text in
    '' | '#'*) continue ;;
    *=*) ;;
    *) continue ;;
  esac
  if ! [[ ${load_env_file_text%%=*} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "load-env-file: $1 line $load_env_file_line has no valid variable name" >&2
    return 1
  fi
  export "${load_env_file_text?}"
done <"${1:?usage: . load-env-file.sh FILE}"
unset load_env_file_line load_env_file_text
