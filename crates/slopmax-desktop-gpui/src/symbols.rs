//! SF Symbols, as the system draws them: each drawn once by AppKit in a
//! color, at twice its size for Retina screens, then kept for GPUI to show.
//! Elsewhere there are none, and a UI shows its words alone.

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::*;

/// The symbols drawn so far, by name, color, and size; `None` where the
/// system has no such symbol.
#[derive(Default)]
pub(crate) struct Symbols(HashMap<(&'static str, u32, u32), Option<Arc<RenderImage>>>);

impl Global for Symbols {}

/// The symbol `name`, `size` points tall, in `color`.
pub(crate) fn symbol(name: &'static str, color: Hsla, size: f32, cx: &mut App) -> Option<Img> {
    let rgba = Rgba::from(color);
    let byte = |channel: f32| (channel.clamp(0., 1.) * 255.).round() as u32;
    let packed = byte(rgba.r) << 24 | byte(rgba.g) << 16 | byte(rgba.b) << 8 | byte(rgba.a);
    let key = (name, packed, (size * 4.).round() as u32);
    let image = cx
        .default_global::<Symbols>()
        .0
        .entry(key)
        .or_insert_with(|| draw(name, rgba, size).map(Arc::new))
        .clone()?;
    Some(
        img(image)
            .flex_shrink_0()
            .size(px(size))
            .object_fit(ObjectFit::Contain),
    )
}

#[cfg(target_os = "macos")]
fn draw(name: &str, color: Rgba, size: f32) -> Option<RenderImage> {
    use objc2_app_kit::{NSColor, NSImage, NSImageSymbolConfiguration};
    use objc2_foundation::NSString;

    let symbol = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        None,
    )?;
    // Twice as large, so a Retina screen shows it sharp at `size`.
    let sized =
        NSImageSymbolConfiguration::configurationWithPointSize_weight(f64::from(size) * 2., 0.);
    let tint = NSColor::colorWithSRGBRed_green_blue_alpha(
        f64::from(color.r),
        f64::from(color.g),
        f64::from(color.b),
        f64::from(color.a),
    );
    let colored = NSImageSymbolConfiguration::configurationWithHierarchicalColor(&tint);
    let configured = symbol
        .imageWithSymbolConfiguration(&sized.configurationByApplyingConfiguration(&colored))?;
    let tiff = configured.TIFFRepresentation()?.to_vec();
    let mut pixels = image::load_from_memory_with_format(&tiff, image::ImageFormat::Tiff)
        .ok()?
        .into_rgba8();
    // AppKit writes its alpha premultiplied, which GPUI would read as
    // straight and so darken every edge; undone here, in GPUI's BGRA order.
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        if (1..255).contains(&alpha) {
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
        pixel.swap(0, 2);
    }
    Some(RenderImage::new(vec![image::Frame::new(pixels)]))
}

#[cfg(not(target_os = "macos"))]
fn draw(_: &str, _: Rgba, _: f32) -> Option<RenderImage> {
    None
}
