//! ACL engine (DEPTAI-472). Pure logic, no I/O: the API crate loads rules/gates from
//! SQLite and asks [`Acl::effective`] for every Web/API, WebDAV and search decision, so all
//! entry points share exactly one implementation.
//!
//! Model
//! - Paths are virtual, normalized, without leading slash: `""` = root, `"local/docs"`.
//! - **Rules** grant (`allow`) or revoke (`deny`) permission bits for a subject on a
//!   directory subtree. Evaluation walks root → target; at each level the matching rules
//!   are applied from least to most specific subject
//!   (anonymous < logged-in < group < user), `bits = (bits | allow) & !deny`.
//!   A deeper level therefore overrides its ancestors (inheritance + override).
//! - **Gates** are per-directory access modes (anonymous / logged-in / password,
//!   combinable bit flags). The nearest gate on the path decides whether the principal may
//!   enter the subtree at all; failing the gate yields no permissions.
//! - Admins bypass everything. Guests are capped at read+download.
//! - Per-user `root` (jail) and `visible_mounts` restrict reachable paths.
use serde::{Deserialize, Serialize};

pub const READ: u32 = 1; // list + preview + stat
pub const DOWNLOAD: u32 = 2;
pub const UPLOAD: u32 = 4;
pub const CREATE: u32 = 8; // mkdir
pub const EDIT: u32 = 16; // rename / move / overwrite
pub const DELETE: u32 = 32;
pub const SHARE: u32 = 64;
pub const ALL: u32 = 127;
pub const GUEST_MAX: u32 = READ | DOWNLOAD;

pub const PERM_NAMES: [(u32, &str); 7] = [
    (READ, "read"),
    (DOWNLOAD, "download"),
    (UPLOAD, "upload"),
    (CREATE, "create"),
    (EDIT, "edit"),
    (DELETE, "delete"),
    (SHARE, "share"),
];

pub fn bits_to_names(bits: u32) -> Vec<&'static str> {
    PERM_NAMES
        .iter()
        .filter(|(b, _)| bits & b != 0)
        .map(|(_, n)| *n)
        .collect()
}

pub fn names_to_bits(names: &[String]) -> Result<u32, String> {
    let mut b = 0;
    for n in names {
        b |= PERM_NAMES
            .iter()
            .find(|(_, x)| x == n)
            .map(|(b, _)| *b)
            .ok_or_else(|| format!("unknown permission '{n}'"))?;
    }
    Ok(b)
}

/// Gate (access-mode) flags.
pub const GATE_ANON: u32 = 1;
pub const GATE_LOGIN: u32 = 2;
pub const GATE_PASSWORD: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Admin,
    User,
    Guest,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Self::Admin),
            "user" => Some(Self::User),
            "guest" => Some(Self::Guest),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::User => "user",
            Self::Guest => "guest",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "id", rename_all = "snake_case")]
pub enum Subject {
    Anonymous,
    LoggedIn,
    Group(i64),
    User(i64),
}

impl Subject {
    fn rank(&self) -> u8 {
        match self {
            Subject::Anonymous => 0,
            Subject::LoggedIn => 1,
            Subject::Group(_) => 2,
            Subject::User(_) => 3,
        }
    }
    pub fn parse(kind: &str, id: Option<i64>) -> Option<Self> {
        match (kind, id) {
            ("anonymous", _) => Some(Self::Anonymous),
            ("logged_in", _) => Some(Self::LoggedIn),
            ("group", Some(i)) => Some(Self::Group(i)),
            ("user", Some(i)) => Some(Self::User(i)),
            _ => None,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Anonymous => "anonymous",
            Self::LoggedIn => "logged_in",
            Self::Group(_) => "group",
            Self::User(_) => "user",
        }
    }
    pub fn id(&self) -> Option<i64> {
        match self {
            Self::Group(i) | Self::User(i) => Some(*i),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub id: i64,
    /// Normalized virtual directory ("" = root).
    pub path: String,
    pub subject: Subject,
    pub allow: u32,
    pub deny: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gate {
    pub path: String,
    pub modes: u32,
    /// Opaque password verifier; checked by the caller-supplied closure.
    pub password_hash: Option<String>,
}

/// Who is asking. `user_id = None` → anonymous.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Identity {
    pub user_id: Option<i64>,
    pub role: Option<Role>,
    pub groups: Vec<i64>,
    /// Jail root (normalized, "" = whole tree).
    pub root: String,
    /// `None` = all mounts.
    pub visible_mounts: Option<Vec<String>>,
    /// Bypass (admin, or system not initialized yet).
    pub superuser: bool,
}

impl Identity {
    pub fn anonymous() -> Self {
        Self::default()
    }
    fn matches(&self, s: &Subject) -> bool {
        match s {
            Subject::Anonymous => true,
            Subject::LoggedIn => self.user_id.is_some(),
            Subject::Group(g) => self.groups.contains(g),
            Subject::User(u) => self.user_id == Some(*u),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceStep {
    pub path: String,
    pub subject: Subject,
    pub allow: u32,
    pub deny: u32,
    pub bits_after: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GateResult {
    pub path: String,
    pub modes: u32,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Effective {
    pub bits: u32,
    pub reason: String,
    pub gate: Option<GateResult>,
    pub trace: Vec<TraceStep>,
}

impl Effective {
    pub fn has(&self, need: u32) -> bool {
        self.bits & need == need
    }
}

pub fn is_under(path: &str, root: &str) -> bool {
    root.is_empty() || path == root || path.starts_with(&format!("{root}/"))
}

/// Ancestors of `path` including itself, root first: "a/b" → ["", "a", "a/b"].
pub fn ancestors(path: &str) -> Vec<String> {
    let mut v = vec![String::new()];
    let mut cur = String::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if !cur.is_empty() {
            cur.push('/');
        }
        cur.push_str(seg);
        v.push(cur.clone());
    }
    v
}

#[derive(Debug, Clone, Default)]
pub struct Acl {
    pub rules: Vec<Rule>,
    pub gates: Vec<Gate>,
}

impl Acl {
    pub fn new(rules: Vec<Rule>, gates: Vec<Gate>) -> Self {
        Self { rules, gates }
    }

    /// Effective permissions of `who` on normalized `path`.
    /// `password_ok(gate)` tells whether the principal supplied the correct gate password.
    pub fn effective(
        &self,
        who: &Identity,
        path: &str,
        password_ok: &dyn Fn(&Gate) -> bool,
    ) -> Effective {
        let deny = |reason: &str| Effective {
            bits: 0,
            reason: reason.into(),
            gate: None,
            trace: vec![],
        };
        if who.superuser {
            return Effective {
                bits: ALL,
                reason: "superuser".into(),
                gate: None,
                trace: vec![],
            };
        }
        if !is_under(path, &who.root) {
            return deny("outside user root");
        }
        if let Some(vis) = &who.visible_mounts {
            let mount = path.split('/').next().unwrap_or("");
            if !mount.is_empty() && !vis.iter().any(|m| m == mount) {
                return deny("mount not visible to user");
            }
        }
        let levels = ancestors(path);
        // Nearest gate decides entry.
        let gate = levels
            .iter()
            .rev()
            .find_map(|l| self.gates.iter().find(|g| &g.path == l));
        let mut gate_res = None;
        if let Some(g) = gate {
            let passed = g.modes & GATE_ANON != 0
                || (g.modes & GATE_LOGIN != 0 && who.user_id.is_some())
                || (g.modes & GATE_PASSWORD != 0 && g.password_hash.is_some() && password_ok(g));
            gate_res = Some(GateResult {
                path: g.path.clone(),
                modes: g.modes,
                passed,
            });
            if !passed {
                return Effective {
                    bits: 0,
                    reason: "access gate not satisfied".into(),
                    gate: gate_res,
                    trace: vec![],
                };
            }
        }
        let mut bits = 0u32;
        let mut trace = vec![];
        for l in &levels {
            let mut here: Vec<&Rule> = self
                .rules
                .iter()
                .filter(|r| &r.path == l && who.matches(&r.subject))
                .collect();
            here.sort_by_key(|r| (r.subject.rank(), r.id));
            for r in here {
                bits = (bits | r.allow) & !r.deny;
                trace.push(TraceStep {
                    path: r.path.clone(),
                    subject: r.subject.clone(),
                    allow: r.allow,
                    deny: r.deny,
                    bits_after: bits,
                });
            }
        }
        if who.role == Some(Role::Guest) {
            bits &= GUEST_MAX;
        }
        Effective {
            bits,
            reason: if trace.is_empty() {
                "no matching rule".into()
            } else {
                "rules".into()
            },
            gate: gate_res,
            trace,
        }
    }

    /// True when the principal can reach something inside `mount` (used to decide whether
    /// a mount shows up in the virtual root listing).
    pub fn can_see_mount(&self, who: &Identity, mount: &str, pw: &dyn Fn(&Gate) -> bool) -> bool {
        if self.effective(who, mount, pw).has(READ) {
            return true;
        }
        self.rules.iter().any(|r| {
            is_under(&r.path, mount)
                && r.path != mount
                && r.allow & READ != 0
                && self.effective(who, &r.path, pw).has(READ)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: i64, path: &str, subject: Subject, allow: u32, deny: u32) -> Rule {
        Rule {
            id,
            path: path.into(),
            subject,
            allow,
            deny,
        }
    }
    fn user(id: i64, groups: &[i64]) -> Identity {
        Identity {
            user_id: Some(id),
            role: Some(Role::User),
            groups: groups.to_vec(),
            ..Default::default()
        }
    }
    const NOPW: &dyn Fn(&Gate) -> bool = &|_| false;

    fn acl() -> Acl {
        Acl::new(
            vec![
                rule(1, "", Subject::LoggedIn, READ | DOWNLOAD, 0),
                rule(2, "pub", Subject::Anonymous, READ | DOWNLOAD, 0),
                rule(3, "team", Subject::Group(10), UPLOAD | CREATE | EDIT, 0),
                rule(4, "team", Subject::User(2), 0, EDIT),
                rule(
                    5,
                    "team/archive",
                    Subject::Group(10),
                    0,
                    UPLOAD | CREATE | EDIT | DELETE,
                ),
                rule(6, "team/archive", Subject::User(3), ALL, 0),
                rule(7, "home/u1", Subject::User(1), ALL, 0),
                rule(8, "secret", Subject::LoggedIn, 0, ALL),
                rule(9, "secret", Subject::User(1), READ, 0),
            ],
            vec![
                Gate {
                    path: "vault".into(),
                    modes: GATE_PASSWORD,
                    password_hash: Some("pw".into()),
                },
                Gate {
                    path: "vault/open".into(),
                    modes: GATE_ANON,
                    password_hash: None,
                },
                Gate {
                    path: "members".into(),
                    modes: GATE_LOGIN | GATE_PASSWORD,
                    password_hash: Some("m".into()),
                },
            ],
        )
    }

    /// Permission matrix: (identity, path, expected bits).
    #[test]
    fn permission_matrix() {
        let a = acl();
        let anon = Identity::anonymous();
        let u1 = user(1, &[10]);
        let u2 = user(2, &[10]);
        let u3 = user(3, &[]);
        let u4 = user(4, &[]);
        let guest = Identity {
            role: Some(Role::Guest),
            ..user(5, &[10])
        };
        let admin = Identity {
            superuser: true,
            ..user(9, &[])
        };
        let cases: Vec<(&Identity, &str, u32)> = vec![
            (&anon, "", 0),
            (&anon, "pub", READ | DOWNLOAD),
            (&anon, "pub/a/b.txt", READ | DOWNLOAD),
            (&anon, "team", 0),
            (&u4, "", READ | DOWNLOAD),
            (&u4, "pub", READ | DOWNLOAD),
            (&u4, "team", READ | DOWNLOAD),
            (&u1, "team/x", READ | DOWNLOAD | UPLOAD | CREATE | EDIT),
            // user-specific deny beats group allow at the same level
            (&u2, "team/x", READ | DOWNLOAD | UPLOAD | CREATE),
            // deeper level overrides inherited group grants
            (&u1, "team/archive/f", READ | DOWNLOAD),
            (&u3, "team/archive/f", ALL),
            (&u1, "home/u1/doc", ALL),
            (&u4, "home/u1/doc", READ | DOWNLOAD),
            (&u4, "secret/x", 0),
            (&u1, "secret/x", READ),
            (&guest, "team/x", READ | DOWNLOAD),
            (&admin, "secret", ALL),
            // password gate without password → nothing, even for logged-in users
            (&u4, "vault/x", 0),
            // nearer ANON gate overrides parent password gate
            (&u4, "vault/open/x", READ | DOWNLOAD),
            (&anon, "vault/open/x", 0), // gate passed but no rule grants anonymous
            (&u4, "members/x", READ | DOWNLOAD), // login mode satisfied
            (&anon, "members/x", 0),
        ];
        for (who, path, want) in cases {
            let got = a.effective(who, path, NOPW).bits;
            assert_eq!(
                got,
                want,
                "{:?} on '{path}': got {:?} want {:?}",
                who.user_id,
                bits_to_names(got),
                bits_to_names(want)
            );
        }
    }

    #[test]
    fn password_gate_with_password() {
        let a = acl();
        let u4 = user(4, &[]);
        let ok = |g: &Gate| g.password_hash.as_deref() == Some("pw");
        assert_eq!(a.effective(&u4, "vault/x", &ok).bits, READ | DOWNLOAD);
        // anonymous passing password gate still needs a rule
        let mut a2 = acl();
        a2.rules
            .push(rule(20, "vault", Subject::Anonymous, READ, 0));
        assert_eq!(
            a2.effective(&Identity::anonymous(), "vault/x", &ok).bits,
            READ
        );
        assert_eq!(
            a2.effective(&Identity::anonymous(), "vault/x", NOPW).bits,
            0
        );
    }

    #[test]
    fn jail_and_visible_mounts() {
        let a = acl();
        let mut u = user(1, &[10]);
        u.root = "home/u1".into();
        assert_eq!(a.effective(&u, "home/u1/doc", NOPW).bits, ALL);
        assert_eq!(a.effective(&u, "pub", NOPW).bits, 0);
        let mut v = user(4, &[]);
        v.visible_mounts = Some(vec!["pub".into()]);
        assert_eq!(a.effective(&v, "pub/x", NOPW).bits, READ | DOWNLOAD);
        assert_eq!(a.effective(&v, "team/x", NOPW).bits, 0);
    }

    #[test]
    fn mount_visibility_via_nested_grant() {
        let a = Acl::new(
            vec![rule(1, "m/deep/dir", Subject::User(1), READ, 0)],
            vec![],
        );
        assert!(a.can_see_mount(&user(1, &[]), "m", NOPW));
        assert!(!a.can_see_mount(&user(2, &[]), "m", NOPW));
    }

    #[test]
    fn names_roundtrip() {
        let b = names_to_bits(&["read".into(), "delete".into()]).unwrap();
        assert_eq!(b, READ | DELETE);
        assert_eq!(bits_to_names(b), vec!["read", "delete"]);
        assert!(names_to_bits(&["nope".into()]).is_err());
    }
}
