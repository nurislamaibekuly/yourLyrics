### Improved
- Significantly smoother playback and higher frame rates on Apple Silicon Macs by eliminating per-frame lyric layout reads, capping the ambient backdrop mesh at 30 fps, and throttling Liquid Glass backdrop captures.
- Refined desktop lyric sizing, Bold weight defaults, and karaoke gradient feathering for cleaner word sweeps, along with tighter iOS portrait layout spacing.
- The Old Apple Music backdrop option now renders with richer, less dimmed colors and Display P3 wide-gamut output where supported.

### Fixed
- Japanese and Korean sustained words now properly trigger emphasis scale, lift, and glow, and Korean syllables group into whole words for emphasis.
- Resizing to a wide, short window no longer causes the karaoke fill gradient to stutter or pause mid-word.
