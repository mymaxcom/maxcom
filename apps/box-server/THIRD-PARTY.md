# Third-party components (box server)

| Component | Version | Licence | Used for |
|---|---|---|---|
| adhan (batoulapps/adhan-js) | 4.4.6 | MIT | Local prayer time calculation (`src/prayer/calc.ts`), box only, fully offline |
| css-tree (csstree/csstree) | 3.2.1 | MIT | Parsing uploaded theme files (`src/themes/cssCheck.ts`), box only; its dependencies mdn-data 2.27.1 (CC0-1.0) and source-map-js 1.2.2 (BSD-3-Clause) |
| jpeg-js (jpeg-js/jpeg-js) | 0.4.4 | BSD-3-Clause | Decoding and drawing again every uploaded JPEG (pictures, and the pictures inside a theme file: `src/imageResize.ts`, `src/themes/validate.ts`), box only |
| pngjs (pngjs/pngjs) | 7.0.0 | MIT | Decoding and drawing again every uploaded PNG (pictures, and the pictures inside a theme file: `src/imageResize.ts`, `src/themes/validate.ts`), box only |
