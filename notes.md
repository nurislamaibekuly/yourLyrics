### Added
- **Lyrics Pronunciation & Translation**: Added per-word romanization underneath word-timed lyrics (supporting mixed-script lines while skipping pure-English lines) with synchronized karaoke gradient fill, plus per-line English translations with smooth 700 ms slide, fade, and column-width transitions that preserve the active line's scroll anchor.
- **Local JS romanization**: Added offline pronunciation engines for Japanese (`kuroshiro` + `kuroshiro-analyzer-kuromoji`), Chinese (`pinyin-pro`), Korean (`hangul-romanization`), and Arabic (`ichkil` ONNX diacritization + diacritic-aware romanizer), keeping only Translation on the cloud API.
- **Translate & Pronunciation controls**: Added SF Symbols translate, pronunciation, and translation icons with a shared bottom-right Solarium Liquid Glass pill on macOS and iPadOS (disabled when lyrics contain no transliterable script) and a standalone borderless button above the progress bar on iOS portrait (hidden when lyrics contain no transliterable script).

### Changed
- **UI style switching**: Automatically disables active pronunciation and translation when switching UI styles.

### Fixed
- **Pronunciation column layout & wrapping**: Measured untransformed layout widths (`offsetWidth`), added vertical spacing for wrapped rows, and cleared fixed widths after expand animations so adjacent CJK and English words never collide.
- **Menu icon rendering under CSP**: Replaced inline SVG `style` attributes with `.menuview__icon svg.svg-filled` so filled SF Symbols render cleanly under `style-src 'self'`.
- **Translation batching & caching**: Switched cloud translation batches to newline-delimited chunks and stopped caching empty responses on transient network or rate-limit errors.
