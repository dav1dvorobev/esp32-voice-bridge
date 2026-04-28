use tower_http::services::ServeDir;

const STATIC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/static");

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let port = std::env::var("FRONTEND_PORT").unwrap_or("80".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .inspect_err(|e| tracing::error!("failed to bind: {e}"))
        .unwrap();
    let app = axum::Router::new()
        .fallback_service(ServeDir::new(STATIC_DIR).append_index_html_on_directories(true));
    tracing::info!("started on port {}", port);
    axum::serve(listener, app)
        .await
        .inspect_err(|e| tracing::error!("failed to run `{}`: {e}", env!("CARGO_PKG_NAME")))
        .unwrap();
}
