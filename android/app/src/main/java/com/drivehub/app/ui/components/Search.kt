package com.drivehub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

/** Soft rounded search field on the secondary fill (Apple Files). */
@Composable
fun SearchField(
    query: String,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "搜索所有网盘",
) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().height(38.dp).clip(Radius.md).background(c.surface2).padding(start = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Search, null, Modifier.size(18.dp), c.fg3)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            if (query.isEmpty()) Text(placeholder, color = c.fg3, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            BasicTextField(
                query, onQuery,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.fg),
                cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSearch() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (query.isNotEmpty()) {
            Box(Modifier.size(30.dp).clip(CircleShape).clickable(onClick = onClear), Alignment.Center) {
                Icon(Icons.Default.Cancel, "清除", Modifier.size(17.dp), c.fg3)
            }
        }
    }
}

/** Compact kind filter capsules: 全部 / 视频 / 图片 / 文档. Selected = brand soft fill. */
@Composable
fun FilterChips(current: KindFilter, onPick: (KindFilter) -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KindFilter.chips.forEach { f ->
            val on = current == f
            Text(
                f.label, color = if (on) c.accent else c.fg2, style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.clip(Radius.pill).background(if (on) c.accentSoft else c.surface2)
                    .clickable { onPick(f) }.padding(horizontal = 14.dp, vertical = 6.dp),
            )
        }
    }
}
