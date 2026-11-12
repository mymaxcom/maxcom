// Where the bundled zxing-wasm reader lives, relative to the app's base
// href (`/app/` when the box serves it). No network: the CSP allows only
// the box's own origin, and the iPad may be offline at the surau.

const String zxingScriptPath = 'zxing/index.js';
const String zxingWasmPath = 'zxing/zxing_reader.wasm';

/// Resolves a bundled path against [base] (the page's base URI).
String zxingUrl(Uri base, String path) => base.resolve(path).toString();
