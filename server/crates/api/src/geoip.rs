//! Offline IP → region lookup for access statistics (DEPTAI-485 r6 #4).
//!
//! * Private / loopback / link-local / CGNAT / ULA addresses are classified locally as
//!   「局域网」/「本机」— no database needed.
//! * Public IPv4 addresses are looked up in an ip2region **xdb** file (Apache-2.0, free, offline;
//!   `scripts/fetch-geoip.sh` downloads it) at `$DRIVEHUB_GEOIP_DB` or `<data_dir>/geoip/ip2region_v4.xdb`.
//!   Without the file, public IPs are reported as 「公网」 with no region. Never calls a remote API.
//!
//! xdb layout: 256-byte header, a 256×256 vector index of (start_ptr u32, end_ptr u32) for the first
//! two octets, then 14-byte segments (start_ip u32, end_ip u32, data_len u16, data_ptr u32), all LE.
//! Region strings are `country|province|city|isp|iso` ("0" = unknown).
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

const HEADER: usize = 256;
const VINDEX: usize = 256 * 256 * 8;
const SEG: usize = 14;

pub struct GeoDb {
    buf: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Geo {
    /// lan | loopback | public | unknown
    pub kind: &'static str,
    /// ISO-3166 alpha-2 ("CN", "US"…), "LAN" for private addresses, "" when unknown
    pub code: String,
    pub country: String,
    pub region: String,
    pub city: String,
    pub isp: String,
    /// Short human label, e.g. "中国 · 广东省 · 深圳市" / "局域网"
    pub label: String,
}

impl GeoDb {
    pub fn from_bytes(buf: Vec<u8>) -> anyhow::Result<GeoDb> {
        anyhow::ensure!(buf.len() > HEADER + VINDEX, "xdb too small");
        Ok(GeoDb { buf })
    }

    pub fn open(p: &Path) -> anyhow::Result<GeoDb> {
        GeoDb::from_bytes(std::fs::read(p)?)
    }

    fn u32_at(&self, o: usize) -> u32 {
        u32::from_le_bytes(self.buf[o..o + 4].try_into().unwrap())
    }

    /// Raw region string for an IPv4 address.
    pub fn lookup_v4(&self, ip: Ipv4Addr) -> Option<&str> {
        let v = u32::from(ip);
        let o = ip.octets();
        let vi = HEADER + (o[0] as usize * 256 + o[1] as usize) * 8;
        let (sp, ep) = (self.u32_at(vi) as usize, self.u32_at(vi + 4) as usize);
        if sp == 0 || ep < sp || ep + SEG > self.buf.len() {
            return None;
        }
        let (mut lo, mut hi) = (0i64, ((ep - sp) / SEG) as i64);
        while lo <= hi {
            let m = (lo + hi) / 2;
            let p = sp + m as usize * SEG;
            let (s, e) = (self.u32_at(p), self.u32_at(p + 4));
            if v < s {
                hi = m - 1;
            } else if v > e {
                lo = m + 1;
            } else {
                let len = u16::from_le_bytes([self.buf[p + 8], self.buf[p + 9]]) as usize;
                let dp = self.u32_at(p + 10) as usize;
                return self
                    .buf
                    .get(dp..dp + len)
                    .and_then(|b| std::str::from_utf8(b).ok());
            }
        }
        None
    }
}

/// Builds a minimal xdb from `(start, end, region)` segments (sorted, non-overlapping, each within
/// one /16 vector cell or spanning several). Used by tests and handy for custom intranet maps.
pub fn build_xdb(segs: &[(Ipv4Addr, Ipv4Addr, &str)]) -> Vec<u8> {
    // split segments on /16 boundaries so every vector cell points at its own run
    let mut parts: Vec<(u32, u32, usize)> = vec![];
    for (i, (s, e, _)) in segs.iter().enumerate() {
        let (mut a, e) = (u32::from(*s), u32::from(*e));
        while a <= e {
            let cell_end = a | 0xffff;
            let b = cell_end.min(e);
            parts.push((a, b, i));
            if b == u32::MAX {
                break;
            }
            a = b + 1;
        }
    }
    let mut buf = vec![0u8; HEADER + VINDEX];
    buf[0..2].copy_from_slice(&3u16.to_le_bytes());
    let mut data_ptr = vec![0u32; segs.len()];
    for (i, (_, _, r)) in segs.iter().enumerate() {
        data_ptr[i] = buf.len() as u32;
        buf.extend_from_slice(r.as_bytes());
    }
    let seg_start = buf.len();
    for (a, b, i) in &parts {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
        buf.extend_from_slice(&(segs[*i].2.len() as u16).to_le_bytes());
        buf.extend_from_slice(&data_ptr[*i].to_le_bytes());
    }
    for cell in 0..65536usize {
        let idx: Vec<usize> = parts
            .iter()
            .enumerate()
            .filter(|(_, p)| (p.0 >> 16) as usize == cell)
            .map(|(k, _)| k)
            .collect();
        if let (Some(f), Some(l)) = (idx.first(), idx.last()) {
            let o = HEADER + cell * 8;
            buf[o..o + 4].copy_from_slice(&((seg_start + f * SEG) as u32).to_le_bytes());
            buf[o + 4..o + 8].copy_from_slice(&((seg_start + l * SEG) as u32).to_le_bytes());
        }
    }
    buf
}

static DB: OnceLock<RwLock<Option<Arc<GeoDb>>>> = OnceLock::new();

fn slot() -> &'static RwLock<Option<Arc<GeoDb>>> {
    DB.get_or_init(|| RwLock::new(None))
}

/// Loads the xdb (env `DRIVEHUB_GEOIP_DB`, else `<data_dir>/geoip/ip2region_v4.xdb`) if present.
pub fn init(data_dir: Option<&Path>) {
    let p = std::env::var("DRIVEHUB_GEOIP_DB")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| data_dir.map(|d| d.join("geoip").join("ip2region_v4.xdb")));
    if let Some(p) = p.filter(|p| p.exists()) {
        match GeoDb::open(&p) {
            Ok(db) => {
                tracing::info!(path = %p.display(), "geoip database loaded");
                set(Some(db));
            }
            Err(e) => tracing::warn!(path = %p.display(), "geoip database not loaded: {e}"),
        }
    }
}

/// Installs (or clears) the process-wide database.
pub fn set(db: Option<GeoDb>) {
    *slot().write().unwrap() = db.map(Arc::new);
}

pub fn loaded() -> bool {
    slot().read().unwrap().is_some()
}

fn lan(label: &str) -> Geo {
    Geo {
        kind: "lan",
        code: "LAN".into(),
        country: "局域网".into(),
        label: label.into(),
        ..Default::default()
    }
}

/// Resolves an address string (as stored in audit_log.ip).
pub fn lookup(ip: &str) -> Geo {
    let ip = ip.trim();
    let Ok(addr) = ip.parse::<IpAddr>() else {
        return Geo {
            kind: "unknown",
            label: "未知".into(),
            ..Default::default()
        };
    };
    let v4 = match addr {
        IpAddr::V4(a) => a,
        IpAddr::V6(a) => {
            if let Some(m) = a.to_ipv4_mapped() {
                m
            } else {
                let s = a.segments();
                if a.is_loopback() {
                    return Geo {
                        kind: "loopback",
                        code: "LAN".into(),
                        country: "局域网".into(),
                        label: "本机".into(),
                        ..Default::default()
                    };
                }
                if (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 {
                    return lan("局域网 (IPv6)");
                }
                return Geo {
                    kind: "public",
                    label: "公网 IPv6".into(),
                    ..Default::default()
                };
            }
        }
    };
    let o = v4.octets();
    if v4.is_loopback() {
        return Geo {
            kind: "loopback",
            code: "LAN".into(),
            country: "局域网".into(),
            label: "本机".into(),
            ..Default::default()
        };
    }
    if v4.is_private() || v4.is_link_local() {
        return lan("局域网");
    }
    if o[0] == 100 && (o[1] & 0xc0) == 64 {
        return lan("运营商内网 (CGNAT)");
    }
    if v4.is_unspecified() || v4.is_broadcast() || o[0] == 0 {
        return Geo {
            kind: "unknown",
            label: "未知".into(),
            ..Default::default()
        };
    }
    let db = slot().read().unwrap().clone();
    let Some(db) = db else {
        return Geo {
            kind: "public",
            label: "公网".into(),
            ..Default::default()
        };
    };
    let Some(raw) = db.lookup_v4(v4) else {
        return Geo {
            kind: "public",
            label: "公网".into(),
            ..Default::default()
        };
    };
    parse_region(raw)
}

fn parse_region(raw: &str) -> Geo {
    let f: Vec<&str> = raw
        .split('|')
        .map(|x| if x == "0" { "" } else { x.trim() })
        .collect();
    let get = |i: usize| f.get(i).copied().unwrap_or("").to_string();
    if get(0) == "Reserved" {
        // private ranges never reach here (classified above); this is e.g. TEST-NET / benchmark space
        return Geo {
            kind: "reserved",
            label: "保留地址".into(),
            ..Default::default()
        };
    }
    // current format: country|province|city|isp|iso ; legacy: country|area|province|city|isp
    let (country, region, city, isp, mut code) =
        if f.len() >= 5 && f[4].len() == 2 && f[4].chars().all(|c| c.is_ascii_uppercase()) {
            (get(0), get(1), get(2), get(3), get(4))
        } else {
            (get(0), get(2), get(3), get(4), String::new())
        };
    if code.is_empty() && country == "中国" {
        code = "CN".into();
    }
    // Hong Kong / Macao / Taiwan are reported as provinces of 中国 by some data sets
    let mut parts: Vec<&str> = vec![];
    for p in [&country, &region, &city] {
        if !p.is_empty() && !parts.contains(&p.as_str()) {
            parts.push(p);
        }
    }
    let label = if parts.is_empty() {
        "公网".to_string()
    } else {
        parts.join(" · ")
    };
    Geo {
        kind: "public",
        code,
        country,
        region,
        city,
        isp,
        label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify_and_lookup() {
        assert_eq!(lookup("192.168.1.61").kind, "lan");
        assert_eq!(lookup("10.0.0.1").label, "局域网");
        assert_eq!(lookup("127.0.0.1").kind, "loopback");
        assert_eq!(lookup("::1").kind, "loopback");
        assert_eq!(lookup("fd00::1").kind, "lan");
        assert_eq!(lookup("100.70.1.1").label, "运营商内网 (CGNAT)");
        assert_eq!(lookup("nonsense").kind, "unknown");
        let db = GeoDb::from_bytes(build_xdb(&[
            (
                "1.0.1.0".parse().unwrap(),
                "1.0.3.255".parse().unwrap(),
                "中国|福建省|福州市|中国电信|CN",
            ),
            (
                "8.8.8.0".parse().unwrap(),
                "8.8.8.255".parse().unwrap(),
                "United States|California|0|Google LLC|US",
            ),
            (
                "1.2.0.0".parse().unwrap(),
                "1.5.255.255".parse().unwrap(),
                "Japan|Tokyo|Tokyo|0|JP",
            ),
        ]))
        .unwrap();
        assert_eq!(
            db.lookup_v4("1.0.2.9".parse().unwrap()),
            Some("中国|福建省|福州市|中国电信|CN")
        );
        assert_eq!(
            db.lookup_v4("1.4.200.1".parse().unwrap()),
            Some("Japan|Tokyo|Tokyo|0|JP")
        );
        assert_eq!(db.lookup_v4("9.9.9.9".parse().unwrap()), None);
        let g = parse_region("中国|福建省|福州市|中国电信|CN");
        assert_eq!(
            (g.code.as_str(), g.region.as_str(), g.label.as_str()),
            ("CN", "福建省", "中国 · 福建省 · 福州市")
        );
        let g = parse_region("United States|California|0|Google LLC|US");
        assert_eq!(
            (g.code.as_str(), g.city.as_str(), g.isp.as_str()),
            ("US", "", "Google LLC")
        );
    }
}
