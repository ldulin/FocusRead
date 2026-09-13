/* Minimal globals so browser-targeted modules can be LOADED under
   JavaScriptCore for testing. Nothing here is used by the extension. */
if (typeof chrome === 'undefined') {
  this.chrome = { runtime: { getURL: function (p) { return p; } } };
}
if (typeof document === 'undefined') { this.document = null; }
