.PHONY: run build test test-go test-web test-browser fmt vet docker

run: ## Server lokal starten (http://localhost:8080)
	go run . -data ./data

build: ## Statisches Binary bauen
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o stadtplaner .

test: test-go test-web ## Alle schnellen Tests

test-go:
	go vet ./... && go test ./...

test-web:
	node --test web/tests/*.test.mjs

test-browser: ## Optional: Playwright + Chromium nötig
	node web/tests/browser/run.cjs

fmt:
	gofmt -w .

vet:
	go vet ./...

docker:
	docker build -t stadtplaner .
