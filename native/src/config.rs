//! Port of `src/config.ts`: the model table, aliases, retired ids, and the
//! vision rules.

use napi_derive::napi;

/// The flash model: the default, and the one with native vision support.
/// The API accepts `deepseek-flash`, not the `deepseek-v4.1-flash` marketing name.
const FLASH: &str = "deepseek-flash";
/// The pro model is text-only.
const PRO: &str = "deepseek-v4-pro";

#[napi]
pub fn supported_models() -> Vec<String> {
    vec![FLASH.to_string(), PRO.to_string()]
}

#[napi]
pub fn default_model() -> String {
    FLASH.to_string()
}

/// Resolves an alias, a current model id, or one that is no longer served.
#[napi]
pub fn resolve_model(value: String) -> napi::Result<String> {
    match value.as_str() {
        "flash" => Ok(FLASH.to_string()),
        "pro" => Ok(PRO.to_string()),
        FLASH | PRO => Ok(value),
        // The retired vision model folded into flash, and the ids this project
        // briefly shipped before the API rejected them.
        "vision"
        | "deepseek-v4-flash"
        | "deepseek-v4-flash-vision-exp"
        | "deepseek-v4.1-flash" => Ok(FLASH.to_string()),
        "deepseek-v4-pro-0813" => Ok(PRO.to_string()),
        _ => Err(napi::Error::from_reason("model must be 'flash' or 'pro'.")),
    }
}

/// V4.1-Flash carries the vision support; the pro model is text-only.
pub(crate) fn vision_capable(model: &str) -> bool {
    model == FLASH
}

#[napi]
pub fn is_vision_model(model: String) -> bool {
    vision_capable(&model)
}
