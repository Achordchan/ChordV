use std::{collections::HashMap, fs, path::Path};

#[derive(Default)]
pub(crate) struct GeositeRoutingMatch {
    pub(crate) cn: bool,
    pub(crate) ads: bool,
    pub(crate) geolocation_non_cn: bool,
}

pub(crate) fn query_geosite_routing(
    path: &Path,
    host: &str,
) -> Result<GeositeRoutingMatch, String> {
    let data = fs::read(path).map_err(|error| format!("读取 geosite.dat 失败：{error}"))?;
    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return Ok(GeositeRoutingMatch::default());
    }

    let mut wanted = HashMap::from([
        ("CN", false),
        ("CATEGORY-ADS-ALL", false),
        ("GEOLOCATION-!CN", false),
    ]);
    let mut index = 0usize;
    while index < data.len() {
        let Some(key) = read_varint(&data, &mut index) else {
            break;
        };
        let field_number = key >> 3;
        let wire_type = key & 0x07;
        if field_number == 1 && wire_type == 2 {
            let Some(length) =
                read_varint(&data, &mut index).and_then(|value| usize::try_from(value).ok())
            else {
                break;
            };
            let Some(end) = index.checked_add(length).filter(|end| *end <= data.len()) else {
                break;
            };
            mark_geosite_entry_matches(&data[index..end], &host, &mut wanted);
            index = end;
            if wanted.values().all(|matched| *matched) {
                break;
            }
        } else if !skip_protobuf_field(&data, wire_type, &mut index) {
            break;
        }
    }

    Ok(GeositeRoutingMatch {
        cn: wanted.get("CN").copied().unwrap_or(false),
        ads: wanted.get("CATEGORY-ADS-ALL").copied().unwrap_or(false),
        geolocation_non_cn: wanted.get("GEOLOCATION-!CN").copied().unwrap_or(false),
    })
}

fn mark_geosite_entry_matches(data: &[u8], host: &str, wanted: &mut HashMap<&'static str, bool>) {
    let mut index = 0usize;
    let mut country_code: Option<String> = None;
    let mut domain_entries: Vec<&[u8]> = Vec::new();

    while index < data.len() {
        let Some(key) = read_varint(data, &mut index) else {
            break;
        };
        let field_number = key >> 3;
        let wire_type = key & 0x07;
        if field_number == 1 && wire_type == 2 {
            if let Some(value) = read_length_delimited(data, &mut index) {
                country_code = Some(String::from_utf8_lossy(value).to_ascii_uppercase());
            } else {
                break;
            }
        } else if field_number == 2 && wire_type == 2 {
            if let Some(value) = read_length_delimited(data, &mut index) {
                domain_entries.push(value);
            } else {
                break;
            }
        } else if !skip_protobuf_field(data, wire_type, &mut index) {
            break;
        }
    }

    let Some(country_code) = country_code else {
        return;
    };
    let Some(current_match) = wanted.get_mut(country_code.as_str()) else {
        return;
    };
    if *current_match {
        return;
    }
    *current_match = domain_entries
        .into_iter()
        .any(|domain| geosite_domain_matches(domain, host));
}

fn geosite_domain_matches(data: &[u8], host: &str) -> bool {
    let mut index = 0usize;
    let mut domain_type = 0u64;
    let mut value: Option<String> = None;

    while index < data.len() {
        let Some(key) = read_varint(data, &mut index) else {
            break;
        };
        let field_number = key >> 3;
        let wire_type = key & 0x07;
        if field_number == 1 && wire_type == 0 {
            if let Some(next_type) = read_varint(data, &mut index) {
                domain_type = next_type;
            } else {
                break;
            }
        } else if field_number == 2 && wire_type == 2 {
            if let Some(raw_value) = read_length_delimited(data, &mut index) {
                value = Some(String::from_utf8_lossy(raw_value).trim().to_lowercase());
            } else {
                break;
            }
        } else if !skip_protobuf_field(data, wire_type, &mut index) {
            break;
        }
    }

    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return false;
    };
    match domain_type {
        0 => host.contains(&value),
        2 => host == value || host.ends_with(&format!(".{value}")),
        3 => host == value,
        _ => false,
    }
}

fn read_length_delimited<'a>(data: &'a [u8], index: &mut usize) -> Option<&'a [u8]> {
    let length = usize::try_from(read_varint(data, index)?).ok()?;
    let end = index.checked_add(length)?;
    if end > data.len() {
        return None;
    }
    let value = &data[*index..end];
    *index = end;
    Some(value)
}

fn read_varint(data: &[u8], index: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *data.get(*index)?;
        *index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn skip_protobuf_field(data: &[u8], wire_type: u64, index: &mut usize) -> bool {
    match wire_type {
        0 => read_varint(data, index).is_some(),
        1 => advance(index, data.len(), 8),
        2 => {
            let Some(length) =
                read_varint(data, index).and_then(|value| usize::try_from(value).ok())
            else {
                return false;
            };
            advance(index, data.len(), length)
        }
        5 => advance(index, data.len(), 4),
        _ => false,
    }
}

fn advance(index: &mut usize, total: usize, count: usize) -> bool {
    let Some(end) = index.checked_add(count).filter(|end| *end <= total) else {
        return false;
    };
    *index = end;
    true
}
