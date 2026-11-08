use crate::process::{Failure, Result};

/// MMX input is converted to atomic units (six decimals) without floating
/// point arithmetic. Empty means everything available.
pub fn amount_mmx_atomic(input: &str) -> Result<Option<u64>> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let invalid = || {
        Failure::new(
            "invalid_payout_amount",
            "Enter a positive MMX amount with at most six decimal places, or leave it empty for everything available.",
        )
    };
    let (whole, fraction) = input.split_once('.').unwrap_or((input, ""));
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 6
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || input.ends_with('.')
    {
        return Err(invalid());
    }
    let whole = whole.parse::<u64>().map_err(|_| invalid())?;
    let atoms = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<6}")
            .parse::<u64>()
            .map_err(|_| invalid())?
    };
    let amount = whole
        .checked_mul(1_000_000)
        .and_then(|n| n.checked_add(atoms))
        .filter(|n| *n > 0 && *n <= i64::MAX as u64)
        .ok_or_else(invalid)?;
    Ok(Some(amount))
}

/// Atomic MMX as exact decimal text, trailing zeros trimmed, no unit.
pub fn mmx(atomic: u64) -> String {
    let fraction = format!("{:06}", atomic % 1_000_000);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        (atomic / 1_000_000).to_string()
    } else {
        format!("{}.{fraction}", atomic / 1_000_000)
    }
}

/// Both MMX checksum spellings accepted by the backend, including zero padding.
pub fn valid_address(address: &str) -> bool {
    let Some(data) = address.strip_prefix("mmx1").filter(|v| v.len() == 58) else {
        return false;
    };
    let charset = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let Some(values) = data
        .bytes()
        .map(|c| charset.iter().position(|v| *v == c).map(|v| v as u8))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let mut residue = 1u32;
    for value in b"mmx"
        .iter()
        .map(|v| v >> 5)
        .chain([0])
        .chain(b"mmx".iter().map(|v| v & 31))
        .chain(values.iter().copied())
    {
        let top = residue >> 25;
        residue = ((residue & 0x1ffffff) << 5) ^ u32::from(value);
        for (bit, generator) in [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
            .iter()
            .enumerate()
        {
            if top & (1 << bit) != 0 {
                residue ^= generator;
            }
        }
    }
    values[51] & 15 == 0 && matches!(residue, 1 | 0x2bc830a3)
}

pub fn request_error(error: Failure, uncertain: bool) -> Failure {
    if uncertain {
        return Failure::new(
            &error.code,
            "The request could not be confirmed. It may already have succeeded. Use its saved review to check and retry the same request.",
        );
    }
    let message = match error.code.as_str() {
        "payout_address_required" => "Set your payout address before requesting a payout.".into(),
        "payment_required" | "insufficient_balance" => "The amount is no longer available. Refresh your earnings and review a new payout.".into(),
        "limit_reached" => "The payout request limit has been reached. Wait before requesting another payout.".into(),
        "invalid_request" => {
            let range = error
                .message
                .split("payout must be between ")
                .nth(1)
                .map(|s| s.split_whitespace().collect::<Vec<_>>());
            match range.and_then(|v| {
                let decimal = |t: &str| {
                    (!t.is_empty() && t.bytes().all(|c| c.is_ascii_digit() || c == b'.')).then(|| t.to_owned())
                };
                (v.get(1) == Some(&"and") && v.get(3) == Some(&"MMX"))
                    .then(|| Some((decimal(v.first()?)?, decimal(v.get(2)?)?)))
                    .flatten()
            }) {
                Some((min, max)) => format!("Request a payout between {min} MMX and {max} MMX."),
                None => "The request was refused. Refresh your earnings and review the amount or payout address again.".into(),
            }
        }
        _ if error.rejected => "The request was refused. Refresh your account and earnings before trying again.".into(),
        _ => "The response did not arrive. This request may have succeeded. Use its saved review to check and retry the same request.".into(),
    };
    Failure::new(&error.code, message)
}
