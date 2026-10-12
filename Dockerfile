# syntax=docker/dockerfile:1
ARG GO_VERSION=1.27.2
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      SSL_CERT_FILE=/run/secrets/proxy_ca go mod download; \
    else \
      go mod download; \
    fi
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/testspeed .

FROM scratch
COPY --from=build /out/testspeed /testspeed
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/testspeed"]
