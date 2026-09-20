//! Port of `src/config.ts`: the model table, aliases, retired ids, and the
//! vision rules.

use napi_derive::napi;

/// V4.1-Flash is the default and carries native vision support.
const FLASH: &str = "deepseek-v4.1-flash";
/// The pro model is text-only.
const PRO: &str = "deepseek-v4-pro-0813";

#[napi]
pub fn supported_models() -> Vec<String> {
    vec![FLASH.to_string(), PRO.to_string()]
}

#[napi]
pub fn default_model() -> String {
    FLASH.to_string()
}

/// Resolves an alias, a current model id, or one retired by the V4.1 line-up.
#[napi]
pub fn resolve_model(value: String) -> napi::Result<String> {
    match value.as_str() {
        "flash" => Ok(FLASH.to_string()),
        "pro" => Ok(PRO.to_string()),
        FLASH | PRO => Ok(value),
        // The retired vision model folded into flash.
        "vision" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp" => Ok(FLASH.to_string()),
        "deepseek-v4-pro" => Ok(PRO.to_string()),
        _ => Err(napi::Error::from_reason("model must be 'flash' or 'pro'.")),
    }
}

#[napi]
pub fn is_vision_model(model: String) -> bool {
    model == FLASH
}
