# e2e-git: git and the OpenSSH client for the ssh-agent forwarding suite.
# Commands run as `dev`, not root, so the socket's owner and the peer-uid
# check mean something; sudo lets the suite act as root and as nobody.
FROM alpine:3.22
RUN apk add --no-cache git openssh-client setpriv sudo \
 && adduser -D -s /bin/sh dev \
 && echo 'dev ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/dev
USER dev
WORKDIR /home/dev
