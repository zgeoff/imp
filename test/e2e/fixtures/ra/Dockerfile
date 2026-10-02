# e2e-ra: busybox and ra-send, so the ipv6 suite can play a guest that
# tries to be its host's router. A static binary keeps the image small.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY ra-send.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /ra-send ra-send.go

FROM busybox:1.37
COPY --from=build /ra-send /usr/local/bin/ra-send
