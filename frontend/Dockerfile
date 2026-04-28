FROM rust:1.95-bookworm AS builder

WORKDIR /app

COPY src ./src
COPY static ./static
COPY Cargo.toml Cargo.lock ./

RUN cargo build --release

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=builder /app/target/release/frontend /usr/local/bin/frontend
COPY --from=builder /app/static ./static

ENV RUST_LOG=info

CMD ["frontend"]
