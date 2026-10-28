use crate::process::{Failure, Result};

/// Dollar input is converted to micro-USD without floating point arithmetic.
pub fn amount_microusd(input: &str) -> Result<Option<u64>> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let invalid = || {
        Failure::new(
            "invalid_payout_amount",
            "Enter a positive dollar amount with at most two decimal places, or leave it empty for everything available.",
        )
    };
    let (whole, fraction) = input.split_once('.').unwrap_or((input, ""));
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || input.ends_with('.')
    {
        return Err(invalid());
    }
    let dollars = whole.parse::<u64>().map_err(|_| invalid())?;
    let cents = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<u64>().map_err(|_| invalid())? * 10,
        _ => fraction.parse::<u64>().map_err(|_| invalid())?,
    };
    let amount = dollars
        .checked_mul(1_000_000)
        .and_then(|n| n.checked_add(cents * 10_000))
        .filter(|n| *n > 0 && *n <= i64::MAX as u64)
        .ok_or_else(invalid)?;
    Ok(Some(amount))
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

pub fn dollars(amount: u64) -> String {
    let fraction = format!("{:06}", amount % 1_000_000);
    let fraction = fraction.trim_end_matches('0');
    format!("${}.{:0<2}", amount / 1_000_000, fraction)
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
            let range = error.message.split("payout must be between ").nth(1).map(|s| s.split_whitespace().collect::<Vec<_>>());
            match range.and_then(|v| Some((v.first()?.parse::<u64>().ok()?, v.get(2)?.parse::<u64>().ok()?))) {
                Some((min, max)) => format!("Request a payout between {} and {}.", dollars(min), dollars(max)),
                None => "The request was refused. Refresh your earnings and review the amount or payout address again.".into(),
            }
        }
        _ if error.rejected => "The request was refused. Refresh your account and earnings before trying again.".into(),
        _ => "The response did not arrive. This request may have succeeded. Use its saved review to check and retry the same request.".into(),
    };
    Failure::new(&error.code, message)
}
