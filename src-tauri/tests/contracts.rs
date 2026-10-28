use gigahost_desktop::controller::{
    approval_id, claim_link, github_link_args, github_signup_args, github_status_args,
    github_unlink_args, restore_charge, validate_url,
};
use gigahost_desktop::payouts::{amount_microusd, valid_address};
#[test]
fn payout_amounts_are_exact_and_dollar_input_is_strict() {
    assert_eq!(amount_microusd("").unwrap(), None);
    assert_eq!(amount_microusd(" 40.01 ").unwrap(), Some(40_010_000));
    assert_eq!(
        amount_microusd("9007199254.75").unwrap(),
        Some(9_007_199_254_750_000)
    );
    for invalid in [
        "0",
        "0.00",
        "-1",
        "+1",
        "1e6",
        "1,000",
        "1.001",
        ".5",
        "1.",
        "18446744073709551616",
        "9223372036854.78",
    ] {
        assert!(amount_microusd(invalid).is_err(), "{invalid}");
    }
}
#[test]
fn payout_addresses_require_the_mmx_checksum() {
    let valid = "mmx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdgytev";
    assert!(valid_address(valid));
    assert!(!valid_address(&valid.replace("dgytev", "dgyteq")));
    assert!(!valid_address(&valid.to_uppercase()));
    assert!(!valid_address("mmx1address"));
}
#[test]
fn restore_quote_uses_backend_mebibyte_billing_units() {
    assert_eq!(restore_charge(1, 1_000_000).as_deref(), Some("977"));
    assert_eq!(
        restore_charge((1 << 20) + 1, 1_000_000).as_deref(),
        Some("1954")
    );
    assert_eq!(
        restore_charge(1 << 30, 1_000_000).as_deref(),
        Some("1000000")
    );
    assert!(restore_charge(0, 100).is_none());
    assert!(restore_charge(100, 0).is_none());
    assert!(restore_charge(u64::MAX, u64::MAX).is_none());
}
#[test]
fn links_cannot_change_backend_or_authorize_commands() {
    let id = "d991d038-bbfc-4a9b-82dd-0d1cf33281b7";
    assert_eq!(
        approval_id(
            &format!("gigahost://approve?intent={id}"),
            "https://gigahost.cloud"
        )
        .unwrap(),
        id
    );
    assert_eq!(
        approval_id(
            &format!("https://gigahost.cloud/approvals/{id}"),
            "https://gigahost.cloud"
        )
        .unwrap(),
        id
    );
    for link in [
        format!("gigahost://approve?intent={id}&api=https://evil.example"),
        format!("https://evil.example/approvals/{id}"),
        format!("gigahost://approve/path?intent={id}"),
        format!("gigahost://approve?intent={id}&yes=true"),
    ] {
        assert!(
            approval_id(&link, "https://gigahost.cloud").is_err(),
            "{link}"
        );
    }
}
#[test]
fn remote_connections_require_https_without_embedded_credentials() {
    for good in [
        "https://api.gigahost.cloud",
        "https://rpc.mmx.network",
        "http://127.0.0.1:18080",
    ] {
        assert!(validate_url(good).is_ok());
    }
    for bad in [
        "http://remote.example",
        "file:///tmp/secret",
        "https://user:secret@api.gigahost.cloud",
        "https://api.gigahost.cloud?override=yes",
    ] {
        assert!(validate_url(bad).is_err());
    }
}
#[test]
fn github_commands_are_built_by_the_app_alone() {
    assert_eq!(
        github_signup_args(),
        ["account", "signup", "--github", "--no-wait"]
    );
    assert_eq!(github_link_args(), ["account", "link-github", "--no-wait"]);
    assert_eq!(github_unlink_args(), ["account", "unlink-github", "--yes"]);
    // A claim name beginning with a hyphen is never read as an option.
    assert_eq!(
        github_status_args("-abc_123").unwrap(),
        ["account", "github-status", "--", "-abc_123"]
    );
    // Even an option's spelling stays a name, after the separator.
    assert_eq!(github_status_args("--compact").unwrap()[2], "--");
    for invalid in ["", "a b", "a/b", "a;b", &"a".repeat(65)] {
        assert!(github_status_args(invalid).is_err(), "{invalid}");
    }
}
#[test]
fn a_github_link_must_be_on_the_configured_website() {
    let website = "https://gigahost.cloud";
    assert!(claim_link("https://gigahost.cloud/trial/start?claim=abc", website).is_ok());
    for link in [
        "https://evil.example/trial/start?claim=abc",
        "http://gigahost.cloud/trial/start?claim=abc",
        "https://user:pass@gigahost.cloud/trial/start",
        "not a url",
    ] {
        assert!(claim_link(link, website).is_err(), "{link}");
    }
}
