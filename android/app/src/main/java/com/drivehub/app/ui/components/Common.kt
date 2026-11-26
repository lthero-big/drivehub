package com.drivehub.app.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
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
import com.drivehub.app.ui.theme.DhColors
import com.drivehub.app.ui.theme.Hair
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

/** App mark: a flat brand-red tile with a white cloud — no gradient, no glow. */
@Composable
fun BrandMark(modifier: Modifier = Modifier, size: Dp = 64.dp) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.25f)).background(Dh.c.accent), Alignment.Center) {
        Icon(Icons.Default.CloudQueue, null, Modifier.size(size * 0.5f), Color.White)
    }
}

/** Small icon slot: a quiet wash with the glyph on top (file kinds, storage drivers, settings rows). */
@Composable
fun IconTile(icon: ImageVector, tint: Color, size: Dp = 30.dp, shape: Shape = Radius.sm, wash: Color = tint.copy(alpha = 0.13f)) {
    Box(Modifier.size(size).clip(shape).background(wash), Alignment.Center) {
        Icon(icon, null, Modifier.size(size * 0.56f), tint)
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

/** "大小 · 时间" (folders: "文件夹 · 时间"). */
fun fileSubtitle(it: FsItem): String = buildString {
    if (it.isDir) append("文件夹") else append(fmtSize(it.size))
    it.modifiedUnix?.let { t ->
        append(" · ")
        append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t * 1000)))
    }
}

/** Quiet inline note (offline banner, errors): tinted text on a faint wash, no dot, no border. */
@Composable
fun StatusPill(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text, color = color, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = modifier.clip(Radius.sm).background(color.copy(alpha = 0.08f)).padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

/** Card: 12 dp corners, flat surface, 0.5 dp hairline outline; clickable when [onClick] is set. */
@Composable
fun DhCard(
    modifier: Modifier = Modifier,
    shape: Shape = Radius.lg,
    color: Color = Dh.c.surface,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val m = modifier.clip(shape).background(color).border(Hair, Dh.c.line, shape)
    Column(if (onClick != null) m.clickable(onClick = onClick) else m, content = content)
}

/** Grouped-list section title (Apple "Grouped Inset" header). */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 20.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, color = Dh.c.fg2, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/**
 * One row of a grouped card inside a lazy list: rounded top on the [first] row, rounded bottom on
 * the [last], a 0.5 dp outline around the whole group and a left-indented hairline between rows.
 */
fun Modifier.groupItem(first: Boolean, last: Boolean, c: DhColors, dividerStart: Dp?): Modifier {
    val r = 12.dp
    val shape = RoundedCornerShape(
        topStart = if (first) r else 0.dp, topEnd = if (first) r else 0.dp,
        bottomStart = if (last) r else 0.dp, bottomEnd = if (last) r else 0.dp,
    )
    return clip(shape).background(c.surface).drawWithContent {
        drawContent()
        val sw = Hair.toPx(); val rp = r.toPx()
        val top = if (first) sw / 2 else -rp * 2
        val bottom = if (last) size.height - sw / 2 else size.height + rp * 2
        drawRoundRect(c.line, Offset(sw / 2, top), Size(size.width - sw, bottom - top), CornerRadius(rp), style = Stroke(sw))
        if (!first && dividerStart != null) drawLine(c.line, Offset(dividerStart.toPx(), sw / 2), Offset(size.width, sw / 2), sw)
    }
}

@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable GroupScope.() -> Unit) {
    DhCard(modifier.fillMaxWidth()) { GroupScope.content() }
}

/** Receiver marker so [GroupRow] is only used inside a [GroupCard]. */
object GroupScope

@Composable
fun Chevron() = Icon(Icons.Default.ChevronRight, null, Modifier.size(20.dp), Dh.c.fg3)

/** Grouped settings-style row: optional neutral icon slot, title, subtitle, trailing slot. */
@Composable
fun GroupScope.GroupRow(
    icon: ImageVector?,
    title: String,
    subtitle: String? = null,
    tint: Color = Dh.c.fg,
    iconTint: Color = Dh.c.fg2,
    trailing: @Composable (() -> Unit)? = { Chevron() },
    first: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val c = Dh.c
    val base = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    val divider = if (icon != null) 58.dp else 16.dp
    Row(
        (if (onClick != null) base.clickable(onClick = onClick) else base)
            .drawBehind { if (!first) drawLine(c.line, Offset(divider.toPx(), 0f), Offset(size.width, 0f), Hair.toPx()) }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            IconTile(icon, iconTint, 30.dp, wash = if (iconTint == c.fg2) c.surface2 else iconTint.copy(alpha = 0.10f))
            Spacer(Modifier.width(14.dp))
        } else Spacer(Modifier.width(2.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = tint, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        trailing?.invoke()
    }
}

/** Restrained round icon button (32–36 dp), e.g. the "+" entry in the top-right corner. */
@Composable
fun CircleIconButton(
    icon: ImageVector, desc: String?, modifier: Modifier = Modifier, size: Dp = 34.dp,
    bg: Color = Dh.c.surface2, tint: Color = Dh.c.fg, onClick: () -> Unit,
) {
    Box(modifier.size(size).clip(CircleShape).background(bg).clickable(onClick = onClick), Alignment.Center) {
        Icon(icon, desc, Modifier.size(size * 0.56f), tint)
    }
}

/** "‹ 浏览" style back link for the top navigation row. */
@Composable
fun BackLink(label: String, onClick: () -> Unit) {
    val c = Dh.c
    Row(
        Modifier.clip(Radius.md).clickable(onClick = onClick).padding(start = 2.dp, end = 10.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.ChevronLeft, null, Modifier.size(26.dp), c.fg)
        Text(label, color = c.fg, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
    }
}

/** Neutral initial avatar: surface2 disc, no gradient; a small brand dot marks an app update. */
@Composable
fun Avatar(initial: String, size: Dp, badge: Boolean, onClick: (() -> Unit)? = null) {
    val c = Dh.c
    Box(Modifier.size(size)) {
        Box(
            Modifier.fillMaxSize().clip(CircleShape).background(c.surface2)
                .let { if (onClick != null) it.clickable(onClick = onClick) else it },
            Alignment.Center,
        ) {
            Text(
                initial, color = c.fg2, fontWeight = FontWeight.SemiBold,
                style = if (size >= 44.dp) MaterialTheme.typography.titleLarge else MaterialTheme.typography.labelLarge,
            )
        }
        if (badge) Box(Modifier.align(Alignment.TopEnd).size(10.dp).clip(CircleShape).background(c.bg).padding(1.5.dp).clip(CircleShape).background(c.accent))
    }
}

@Composable
fun DhSwitch(checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Dh.c
    Switch(
        checked, onChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White, checkedTrackColor = c.accent, checkedBorderColor = Color.Transparent,
            uncheckedThumbColor = Color.White, uncheckedTrackColor = c.surface2, uncheckedBorderColor = Color.Transparent,
        ),
    )
}

/** Input on the secondary fill; the outline only appears (in brand red) while focused. */
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
    var focused by remember { mutableStateOf(false) }
    Column(modifier) {
        Text(label, color = c.fg2, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 2.dp, bottom = 6.dp))
        BasicTextField(
            value, onValueChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.fg),
            cursorBrush = SolidColor(c.accent),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            decorationBox = { inner ->
                Row(
                    Modifier.fillMaxWidth().height(48.dp).clip(Radius.md).background(c.surface2)
                        .border(1.dp, if (focused) c.accent.copy(alpha = 0.55f) else Color.Transparent, Radius.md)
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    leading?.let { Icon(it, null, Modifier.size(18.dp), c.fg3); Spacer(Modifier.width(10.dp)) }
                    Box(Modifier.weight(1f)) {
                        if (value.isEmpty() && placeholder != null) Text(placeholder, color = c.fg3, style = MaterialTheme.typography.bodyLarge)
                        inner()
                    }
                }
            },
        )
    }
}

/**
 * Apple-style header: a 44 dp navigation row (back link on the left, actions on the right) above a
 * Large Title. Pads for the status bar.
 */
@Composable
fun ScreenHeader(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    leading: @Composable (RowScope.() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = Dh.c
    Column(modifier.fillMaxWidth().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            leading?.invoke(this)
            Spacer(Modifier.weight(1f))
            actions()
        }
        Text(title, style = MaterialTheme.typography.displaySmall, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 20.dp))
        subtitle?.let { Text(it, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp)) }
        Spacer(Modifier.height(8.dp))
    }
}

/** Plain icon button in the theme's secondary ink. */
@Composable
fun HeaderAction(icon: ImageVector, desc: String, tint: Color = Dh.c.fg2, onClick: () -> Unit) {
    IconButton(onClick) { Icon(icon, desc, Modifier.size(22.dp), tint) }
}
