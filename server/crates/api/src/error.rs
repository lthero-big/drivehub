use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use drivehub_storage::StorageError;
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

#[derive(Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self(StatusCode::NOT_FOUND, msg.into())
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, msg.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorBody { error: self.1 })).into_response()
    }
}

impl From<StorageError> for ApiError {
    fn from(e: StorageError) -> Self {
        let code = match &e {
            StorageError::NotFound(_) => StatusCode::NOT_FOUND,
            StorageError::AlreadyExists(_) => StatusCode::CONFLICT,
            StorageError::Unsupported(_) => StatusCode::NOT_IMPLEMENTED,
            StorageError::Config(_) => StatusCode::BAD_REQUEST,
            StorageError::Backend(_) => StatusCode::BAD_GATEWAY,
        };
        Self(code, e.to_string())
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
