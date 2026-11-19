package com.drivehub.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

val AppJson = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false; encodeDefaults = true }

@Serializable
data class VersionInfo(
    @SerialName("server_version") val serverVersion: String,
    @SerialName("api_version") val apiVersion: Int,
    @SerialName("min_app_version") val minAppVersion: String,
    @SerialName("min_web_version") val minWebVersion: String = "",
)

@Serializable
data class TokenPair(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    @SerialName("expires_in") val expiresIn: Long = 0,
    @SerialName("session_id") val sessionId: String = "",
)

@Serializable data class LoginBody(val login: String, val password: String, @SerialName("totp_code") val totpCode: String? = null)
@Serializable data class TicketBody(val ticket: String, val code: String)
@Serializable data class RefreshBody(@SerialName("refresh_token") val refreshToken: String)
@Serializable data class PathBody(val path: String)
@Serializable data class RenameBody(val path: String, @SerialName("new_name") val newName: String)
@Serializable data class NewUpload(val path: String, val size: Long, val overwrite: Boolean = true)
@Serializable data class ClaimBody(val code: String, val pin: String? = null)

@Serializable
data class UploadSession(val id: String, val path: String, val size: Long, val offset: Long, @SerialName("chunk_size") val chunkSize: Long)

@Serializable
data class AuthStatus(
    val initialized: Boolean = true,
    @SerialName("open_registration") val openRegistration: Boolean = false,
    @SerialName("oauth_providers") val oauthProviders: List<String> = emptyList(),
    val me: JsonElement? = null,
)

@Serializable
data class FsItem(
    val name: String,
    val path: String,
    @SerialName("is_dir") val isDir: Boolean,
    val size: Long = 0,
    @SerialName("modified_unix") val modifiedUnix: Long? = null,
    @SerialName("mount_kind") val mountKind: String? = null,
    @SerialName("read_only") val readOnly: Boolean? = null,
)

@Serializable
data class ListResp(val path: String, val total: Int = 0, val page: Int = 0, @SerialName("per_page") val perPage: Int = 0, val items: List<FsItem> = emptyList())

@Serializable
data class SearchHit(
    val mount: String = "", val path: String, val name: String, val ext: String = "",
    val size: Long = 0, @SerialName("is_dir") val isDir: Boolean = false,
    @SerialName("modified_unix") val modifiedUnix: Long? = null, val score: Float = 0f,
)

@Serializable
data class SearchResp(val enabled: Boolean = true, val total: Int = 0, val hits: List<SearchHit> = emptyList(), val message: String? = null)

@Serializable
data class NewShare(
    val paths: List<String>, val name: String? = null, val perm: String? = null,
    val days: Long? = null, val pin: String? = null,
    @SerialName("random_pin") val randomPin: Boolean = false,
    @SerialName("max_downloads") val maxDownloads: Long? = null,
)

@Serializable
data class Share(
    val id: Long, val code: String, val name: String? = null, val perm: String = "download",
    val items: List<String> = emptyList(), val pin: String? = null,
    @SerialName("has_pin") val hasPin: Boolean = false,
    @SerialName("expires_at") val expiresAt: Long? = null,
    val visits: Long = 0, val downloads: Long = 0, val revoked: Boolean = false, val status: String = "active",
    val url: String = "", @SerialName("url_with_pin") val urlWithPin: String? = null,
    @SerialName("pickup_code") val pickupCode: String = "",
    @SerialName("direct_url") val directUrl: String? = null,
)

@Serializable
data class SharedItem(
    val name: String, val path: String, @SerialName("is_dir") val isDir: Boolean = false,
    val size: Long = 0, val missing: Boolean = false,
)

/** Response of GET /api/s/{code} and POST /api/s/claim (pickup). */
@Serializable
data class ShareOpen(
    val id: Long = 0, val code: String, val name: String? = null, val owner: String? = null,
    val perm: String = "download", val items: List<SharedItem> = emptyList(), val token: String,
    @SerialName("allow_download") val allowDownload: Boolean = true,
    @SerialName("downloads_left") val downloadsLeft: Long? = null,
)

@Serializable
data class ShareList(val path: String = "/", val perm: String = "download", val items: List<SharedItem> = emptyList())

@Serializable data class ErrorBody(val error: String = "")

/** Body of HTTP 426 / 400 from the server's version gate (`Compat` serialised with tag `status`). */
@Serializable
data class CompatBody(
    val status: String = "",
    @SerialName("min_version") val minVersion: String? = null,
    @SerialName("server_api_version") val serverApiVersion: Int? = null,
    val reason: String? = null,
)
