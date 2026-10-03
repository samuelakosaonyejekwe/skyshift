// SkyShift backup host bootstrap.  The tiny page on GitHack (Cloudflare CDN)
// loads this script from jsDelivr, which then pulls the latest app from
// jsDelivr's copy of the repository, so the backup never goes stale and keeps
// working while GitHub Pages (or GitHub) is unavailable.
(function () {
  var CDN = 'https://cdn.jsdelivr.net/gh/samuelakosaonyejekwe/skyshift@main/site/';
  var MAIN = 'https://samuelakosaonyejekwe.github.io/skyshift/';
  fetch(CDN + 'index.html', { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }).then(function (html) {
    var jd = 'https://cdn.jsdelivr.net';
    html = html
      .replace('<head>', '<head><base href="' + CDN + '">')
      .replace("script-src 'self'", "script-src 'self' " + jd)
      .replace("style-src 'self'", "style-src 'self' " + jd)
      .replace("img-src 'self'", "img-src 'self' " + jd)
      .replace(/<link rel="manifest"[^>]*>/, '')
      .replace('<span id="buildInfo"></span>', '<span id="buildInfo"></span> · backup host');
    document.open();
    document.write(html);
    document.close();
  }).catch(function () {
    var b = document.getElementById('boot');
    if (b) b.innerHTML = '<p>The backup could not load right now.</p><p><a href="' + MAIN + '">Open the main site</a></p>';
  });
})();
