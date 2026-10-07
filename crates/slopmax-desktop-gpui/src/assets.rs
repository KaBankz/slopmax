//! The icons the app draws: gpui-kit's own, which its components use, and
//! the Lucide icons slopmax's pages add, embedded alone rather than the
//! whole set. Lucide draws the same on every system.

use std::borrow::Cow;

use gpui_kit::assets::Assets;
use gpui_kit::{AssetSource, Result, SharedString};

gpui_kit::assets::icon_assets!(Extra, [ChartColumn, Users, Zap]);

/// gpui-kit's icons, then slopmax's.
pub(crate) struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match Extra.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = Assets.list(path)?;
        paths.extend(Extra.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
