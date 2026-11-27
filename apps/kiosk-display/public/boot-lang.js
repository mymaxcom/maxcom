// The boot screen's language (index.html, before the program has loaded). The kiosk remembers the TV language it
// last showed ('mx-tv-lang'); when there is one, the boot screen shows its one loading line instead of all three.
// A plain script that runs at once (no module, no newer syntax: the oldest box WebView reads it), and never throws.
(function () {
  try {
    var lang = localStorage.getItem('mx-tv-lang');
    if (lang !== 'ms' && lang !== 'en' && lang !== 'ar') return;
    var boot = document.getElementById('boot');
    if (!boot) return;
    boot.setAttribute('data-lang', lang);
    document.documentElement.setAttribute('lang', lang);
  } catch (e) {
    // storage unavailable: the three lines stay
  }
})();
