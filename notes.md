### Added
- **macOS Solarium volume slider**: Added a top-right Liquid Glass volume pill on macOS UI styling with an AirPlay icon, divider, interactive Solarium slider, and speaker icon using the same Liquid Glass platter material as `MenuView`.
- **System volume control**: Wired the macOS, iOS, and iPadOS volume sliders to read and control system output volume in real time (macOS and Linux) and stay in sync with hardware volume changes.
- **Shuffle & Repeat buttons**: Added Shuffle and Repeat buttons flanking the playback controls on macOS and iPadOS UI styles.
- **iOS bottom action row & AirPlay customization**: Added the iOS bottom action row (lyrics toggle, playback destination icon, and queue icon) with idle auto-hide, selectable SF Symbol icons (`MacBook`, `AirPods`, `AirPlay`), and customizable bottom label modes (`Off`, `Bluetooth device`, `iPhone → device`, `Device name`, `Custom text`) in Settings.

### Changed
- **iPadOS layout**: Removed portrait mode on iPadOS so it always uses the two-column landscape layout at all window sizes.
- **Solarium lyrics toggle**: Matched the lyrics toggle button's Liquid Glass backdrop material and shadow to `MenuView` and the macOS volume slider pill.
- **iOS layout & controls**: Refined the iOS album layout, volume slider sizing and repeatable speaker bounce animation, and window corner radius.

### Fixed
- **iOS traffic light positioning**: Adjusted the custom window controls inset in iOS mode (`{ x: 30, y: 24 }`) so they clear the larger rounded window corner.
- **AirPods Pro icon rendering**: Rendered the AirPods Pro SF Symbol using its hierarchical mask layers so the stem, pod head, and ear-tip cutouts display cleanly.
