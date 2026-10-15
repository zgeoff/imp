# e2e-ws: a WebSocket echo server on :8080, to test the wake proxy's
# WebSocket relay. A static binary on busybox keeps the image small.
# isn-probe reads the guest's TCP ISN secret, for the boot templates suite.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY ws-echo.go isn-probe.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /ws-echo ws-echo.go \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /isn-probe isn-probe.go

FROM busybox:1.37
COPY --from=build /ws-echo /isn-probe /usr/local/bin/
COPY rootfs/ /
