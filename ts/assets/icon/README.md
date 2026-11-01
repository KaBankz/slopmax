# The slopmax icon

A glass Option key (⌥) on a cobalt tile. On a Mac keyboard ⌥ is the "alternate" key, and
the symbol itself is a railway switch: traffic either runs straight on or turns aside onto
another track. That is what slopmax does when an account reaches its limit. The diverted
path (top-left bar, diagonal, bottom-right bar) is lit; the straight-ahead bar (top right)
is unlit.

## Files

| File                                        | What it is                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `scene.py`                                  | The Blender scene: keycap geometry, glass, glyph, lights, camera. Its parameters are at the top.                |
| `base.py`                                   | Shared studio setup: Cycles on CPU, the curved backdrop, the world, the glass and emission helpers, `render()`. |
| `build.ts`                                  | `draft`, `render` and `derive` (below).                                                                         |
| `icon.png`                                  | The 1024 px master, cut to the squircle. Everything else derives from it.                                       |
| `mark.svg`                                  | The flat mark for small sizes (favicon, the UI's small logo, the tray): the same ⌥ on the same cobalt.          |
| `tray-template.svg`                         | The macOS menu bar glyph: black, alpha only, the unlit bar at 45%.                                              |
| `icon-macos.png`, `icon.icns`               | macOS: the tile on Apple's grid (824 of 1024) with its shadow.                                                  |
| `icon.ico`                                  | Windows: 16 to 256 px.                                                                                          |
| `trayTemplate*.png`, `tray*.png`            | The macOS menu bar template and the Windows and Linux tray, at 1x and 2x.                                       |
| `../../apps/ui/src/{logo.svg,icon-128.png}` | The UI's copies (favicon and small logo, large logo).                                                           |

## Colors

| Use                         | Value                                    |
| --------------------------- | ---------------------------------------- |
| Tile, top to bottom         | `#2470EE` → `#0C44B4`                    |
| Glass                       | `#A6D8FF`, IOR 1.5                       |
| Lit path                    | white emission, mint `#5CFFD2` underglow |
| Unlit bar (flat mark)       | `#9FC3FF` at 75%                         |
| UI accent (`--brand`) light | `#2470EE` (4.5:1 on white)               |
| UI accent (`--brand`) dark  | `#6AA0FF` (6.6:1 on `#1b1b1d`)           |

## Editing and rendering

You need Blender 5.2 (`BLENDER=/path/to/blender` if it is not on PATH) and ImageMagick 6 or 7
with librsvg (`MAGICK=magick` for 7). From `ts/`:

```sh
bun assets/icon/build.ts draft    # 512 px, 48 samples, about 30 s: look at it while you edit scene.py
bun assets/icon/build.ts render   # the 1024 px master, icon.png
bun assets/icon/build.ts derive   # every other file in the table above
```

`scene.py` ends with `s.cycles.time_limit = 1250`, so a final render stops after about 21
minutes even if it has not reached 256 samples. The denoiser hides the
difference, but on a busy machine the master can come out a little noisier.

Lessons from getting here, so an edit does not undo them:

- The glass must let shadow rays through (`base.glass` mixes in a transparent shader for
  them), or the floor under the key renders black: light through glass is a caustic, and
  plain path tracing barely finds it.
- The world has one bright overhead area and is dark elsewhere: glass needs something
  bright to reflect, and one light keeps the highlights honest.
- Khronos PBR Neutral, not AgX, keeps the cobalt cobalt; AgX drifts saturated blue
  toward violet.
- The dish rings are subdivided on the straight sides too, and the floor and dish are
  closed with n-gons, not triangle fans: fan poles showed as dark specks through the skirt.
