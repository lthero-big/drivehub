package com.drivehub.app.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius
import com.drivehub.app.ui.theme.kindTint
import java.text.DateFormat
import java.util.Date

fun copyText(ctx: Context, text: String) {
    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
        .setPrimaryClip(ClipData.newPlainText("DriveHub", text))
}

@Composable
internal fun <T> produceLoad(key: Any, block: suspend () -> T): State<Result<T>?> =
    produceState<Result<T>?>(null, key) { value = runCatching { block() } }

/** App mark: gradient tile with a soft glow in the accent colour. */
@Composable
fun BrandMark(modifier: Modifier = Modifier, size: Dp = 76.dp) {
    val c = Dh.c
    Box(
        modifier
            .size(size)
            .shadow(28.dp, Radius.lg, ambientColor = c.accent, spotColor = c.accent)
            .clip(Radius.lg)
            .background(Brush.linearGradient(listOf(c.accent, c.accent.copy(alpha = 0.72f), c.glowB.copy(alpha = 1f)))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.CloudQueue, null, Modifier.size(size * 0.5f), c.onAccent)
    }
}

/** Rounded tinted icon container (the "icon slot" used across cards, rows and sheets). */
@Composable
fun IconTile(icon: ImageVector, tint: Color, size: Dp = 44.dp, filled: Boolean = false, shape: Shape = Radius.md) {
    Box(
        Modifier.size(size).clip(shape).background(if (filled) tint else tint.copy(alpha = 0.15f)),
        Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(size * 0.5f), if (filled) Color.White else tint)
    }
}

fun iconFor(name: String): ImageVector = when (kindOf(name)) {
    "image" -> Icons.Default.Image
    "video" -> Icons.Default.Movie
    "audio" -> Icons.Default.MusicNote
    "pdf" -> Icons.Default.PictureAsPdf
    "text" -> Icons.AutoMirrored.Filled.Article
    else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

@Composable
fun FileGlyph(item: FsItem, size: Dp) {
    IconTile(if (item.isDir) Icons.Default.Folder else iconFor(item.name), Dh.c.kindTint(kindOf(item.name), item.isDir), size)
}

fun fileSubtitle(it: FsItem): String = buildString {
    if (it.isDir) append("文件夹") else append(fmtSize(it.size))
    it.modifiedUnix?.let { t ->
        if (isNotEmpty()) append("  ·  ")
        append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t * 1000)))
    }
}

/** Non-interactive status label: soft fill, coloured dot, no border. */
@Composable
fun StatusPill(text: String, color: Color, modifier: Modifier = Modifier, dot: Boolean = true) {
    Row(
        modifier.clip(Radius.pill).background(color.copy(alpha = 0.14f)).padding(horizontal = 9.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(5.dp))
        }
        Text(text, color = color, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

/** Card surface with a hairline border; clickable when [onClick] is set. */
@Composable
fun DhCard(
    modifier: Modifier = Modifier,
    shape: Shape = Radius.lg,
    color: Color = Dh.c.surface,
    border: Color = Dh.c.line,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val m = modifier.clip(shape).background(color).border(BorderStroke(1.dp, border), shape)
    Column(if (onClick != null) m.clickable(onClick = onClick) else m, content = content)
}

/** Small overline title above a group. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, color = Dh.c.fg3, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/**
 * Grouped card whose rows are separated by a left-indented hairline (folia `kit.css` `st-row::before`):
 * the divider starts after the icon slot so the group reads as one block.
 */
@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable GroupScope.() -> Unit) {
    DhCard(modifier.fillMaxWidth()) { GroupScope.content() }
}

/** Receiver marker so [GroupRow] is only used inside a [GroupCard]. */
object GroupScope

@Composable
fun GroupScope.GroupRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    tint: Color = Dh.c.fg,
    iconTint: Color = Dh.c.accent,
    trailing: @Composable (() -> Unit)? = { Icon(Icons.Default.ChevronRight, null, tint = Dh.c.fg3) },
    first: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val c = Dh.c
    val base = Modifier.fillMaxWidth()
    Row(
        (if (onClick != null) base.clickable(onClick = onClick) else base)
            .drawBehind {
                if (!first) drawLine(c.line, Offset(68.dp.toPx(), 0f), Offset(size.width, 0f), 1.dp.toPx())
            }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(icon, iconTint, 40.dp, shape = Radius.sm)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = tint, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        trailing?.invoke()
    }
}

/** Round translucent icon button for overlays (preview top bar, grid "more"). */
@Composable
fun GlassIconButton(icon: ImageVector, desc: String?, modifier: Modifier = Modifier, size: Dp = 40.dp, tint: Color = Dh.c.fg, onClick: () -> Unit) {
    val c = Dh.c
    Box(
        modifier.size(size).clip(CircleShape).background(c.dock).border(1.dp, c.dockHighlight, CircleShape).clickable(onClick = onClick),
        Alignment.Center,
    ) { Icon(icon, desc, Modifier.size(size * 0.5f), tint) }
}

/** Sunken input with focus ring; replaces stock OutlinedTextField on auth/pickup/dialog screens. */
@Composable
fun DhTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    leading: ImageVector? = null,
    placeholder: String? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val c = Dh.c
    val src = remember { MutableInteractionSource() }
    var focused by remember { mutableStateOf(false) }
    Column(modifier) {
        Text(label, color = c.fg2, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        BasicTextField(
            value, onValueChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.fg),
            cursorBrush = SolidColor(c.accent),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            interactionSource = src,
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            decorationBox = { inner ->
                Row(
                    Modifier.fillMaxWidth().height(54.dp).clip(Radius.md).background(c.surfaceSunken)
                        .border(if (focused) 1.5.dp else 1.dp, if (focused) c.accent.copy(alpha = 0.7f) else c.line, Radius.md)
                        .padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    leading?.let { Icon(it, null, Modifier.size(20.dp), if (focused) c.accent else c.fg3); Spacer(Modifier.width(10.dp)) }
                    Box(Modifier.weight(1f)) {
                        if (value.isEmpty() && placeholder != null) Text(placeholder, color = c.fg3, style = MaterialTheme.typography.bodyLarge)
                        inner()
                    }
                }
            },
        )
    }
}

/** Large screen title with optional subtitle and trailing actions; pads for the status bar. */
@Composable
fun ScreenHeader(title: String, subtitle: String? = null, modifier: Modifier = Modifier, actions: @Composable RowScope.() -> Unit = {}) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().statusBarsPadding().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        actions()
    }
}

/** Plain round icon button in the theme's secondary ink. */
@Composable
fun HeaderAction(icon: ImageVector, desc: String, tint: Color = Dh.c.fg2, onClick: () -> Unit) {
    IconButton(onClick) { Icon(icon, desc, tint = tint) }
}
