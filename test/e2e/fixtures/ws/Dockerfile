# e2e-ws: a WebSocket echo server on :8080, to test the wake proxy's
# WebSocket relay. A static binary on busybox keeps the image small.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY ws-echo.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /ws-echo ws-echo.go

FROM busybox:1.37
COPY --from=build /ws-echo /usr/local/bin/ws-echo
COPY rootfs/ /
