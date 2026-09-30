//! Pure wisp.place logic, free of I/O so it can be tested exhaustively.
//! Network and filesystem effects live in `wispctl`; functions here take
//! data (or small fetch callbacks) and return data.

pub mod blob;
pub mod constants;
pub mod convert;
pub mod ignore;
pub mod pages;
pub mod path;
pub mod redirects;
pub mod scopes;
pub mod split;
pub mod subfs;
pub mod tree;
