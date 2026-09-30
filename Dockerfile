# syntax=docker/dockerfile:1
# Ein einziges Dockerfile baut das komplette Projekt: Go-Backend mit
# eingebetteter Web-Oberfläche. Keine weiteren Build-Werkzeuge nötig.
#
#   docker build -t stadtplaner .
#   docker run --rm -p 8080:8080 -v stadtplaner-data:/data stadtplaner

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/stadtplaner . \
 && mkdir -p /out/data

# Minimales Laufzeit-Image mit CA-Zertifikaten (für HTTPS zu den OSM-Diensten).
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/stadtplaner /stadtplaner
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV ADDR=:8080 \
    DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
USER nonroot:nonroot
ENTRYPOINT ["/stadtplaner"]
