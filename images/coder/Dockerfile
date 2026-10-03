# imp coder image: images/base plus Claude Code, for running a coding agent
# in an imp. Each release publishes it as ghcr.io/zgeoff/imp-coder:X.Y.Z, so a
# host adds it with `imp image add` and builds nothing.
#   docker build -t imp/coder images/coder
# The published images/base, pinned by digest. A bump to a newer base is a
# reviewed change; check it with gh attestation verify (docs/guides/images.md).
FROM ghcr.io/zgeoff/imp-base:0.29.0@sha256:1851f631ea77f3a99b6f1f9af8ca8868434f4cd066158bcf9def8678c29b0c21

# Claude Code's native linux-x64 binary, the file its installer downloads,
# at an exact version. It needs no Node. The sum comes from the release's
# manifest.json, whose signature names Anthropic's release key
# (31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE,
# https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing).
# A bump is a reviewed change; set both ARGs from a checked manifest:
#   R=https://downloads.claude.ai/claude-code-releases/$VERSION
#   curl -fsSLO "$R/manifest.json" -O "$R/manifest.json.sig"
#   curl -fsSL https://downloads.claude.ai/keys/claude-code.asc | gpg --import
#   gpg --verify manifest.json.sig manifest.json
#   jq -r '.platforms["linux-x64"].checksum' manifest.json
# host/check-coder-image.sh checks the image against both.
ARG CLAUDE_CODE_VERSION=2.1.287
ARG CLAUDE_CODE_SHA256=3920489a5109cff5786a1a392c25277408ff22bc796d5edb9c16a60e5a1718f0

RUN curl -fsSL -o /usr/local/bin/claude \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/linux-x64/claude" \
 && echo "${CLAUDE_CODE_SHA256}  /usr/local/bin/claude" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/claude

# The image is the pin: no background update and no `claude update`, which
# would install another version under ~/.local.
ENV DISABLE_UPDATES=1
