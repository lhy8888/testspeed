.PHONY: run build test check docker bench

run:
	go run .

build:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/testspeed .

test:
	go test -race ./...
	node --test tests/*.test.mjs

check:
	go vet ./...

docker:
	docker compose up --build -d

bench:
	go run ./tools/throughput -url http://127.0.0.1:8080 -streams 1,4,12,24 -duration 3s
