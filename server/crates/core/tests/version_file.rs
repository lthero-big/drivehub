//! DEPTAI-478: /VERSION is the single release-version source; the crate version
//! (and therefore SERVER_VERSION reported by GET /api/version) must equal it.

#[test]
fn version_file_matches_crate_version() {
    let file = include_str!("../../../../VERSION").trim();
    assert_eq!(
        file,
        drivehub_core::version::SERVER_VERSION,
        "run scripts/bump-version.sh to resync"
    );
    assert!(
        semver::Version::parse(file).is_ok(),
        "VERSION must be semver"
    );
}
