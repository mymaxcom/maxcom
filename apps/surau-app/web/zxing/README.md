# Bundled QR reader (zxing-wasm)

Served from the box at `/app/zxing/` so QR scanning works offline and under the
`/app/` CSP (no CDN). mobile_scanner 7.5.0 expects this exact version.

- Package: zxing-wasm 3.1.6 (npm), tarball integrity
  `sha512-mU7UNuvl+hOT+nlSOQTMHZ2tM8lRMsbjDIp5IO/+HmBl/FOq77q0OSZPJ3cm42A9c1MKU6Uve67FiGdkhsrT9g==`
  (matches `npm view zxing-wasm@3.1.6 dist.integrity`)
- Licence: MIT (see `LICENSE`)
- `index.js` = `dist/iife/reader/index.js`, sha256 `ffd72d59d54082194f7c086b384dcd930bdeb0c5b39fbb13779694e69bb0d344`
- `zxing_reader.wasm` = `dist/reader/zxing_reader.wasm`, sha256 `5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e`
- `LICENSE`, sha256 `fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab`

`index.js` still contains the upstream CDN default for `locateFile`; it is
overridden at runtime by `lib/features/enrol/zxing_web_impl.dart`
(`ZXingWASM.setZXingModuleOverrides`), so the CDN is never contacted.
Files are unmodified upstream copies; to upgrade, bump together with mobile_scanner.
