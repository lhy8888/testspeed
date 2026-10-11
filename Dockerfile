ARG GO_VERSION=1.27.2
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/testspeed .

FROM scratch
COPY --from=build /out/testspeed /testspeed
USER 65532:65532
EXPOSE 8080 8081 8082 8083 8084
ENTRYPOINT ["/testspeed"]
