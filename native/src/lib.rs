#![deny(clippy::all)]

//! Shared core for the Ya CLI and desktop application.
//!
//! Modules are ported from TypeScript one at a time. Each ported module is
//! verified against the TypeScript implementation by `native/parity.js`.

mod compat;
mod config;
mod images;
mod keychain;
mod memory;
mod web;
