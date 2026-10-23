(function () {
  // Firebase Hosting serves /login via cleanUrls; a plain static server needs login.html.
  if (!/\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
    document.querySelectorAll('a[href^="/login"], a[href^="/app"]').forEach(function (a) {
      var h = a.getAttribute('href');
      a.setAttribute('href', h.replace(/^\/(login|app)/, '$1.html'));
    });
  }
  // Copy buttons for every code block
  document.querySelectorAll('pre.code').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.addEventListener('click', function () {
      var text = pre.querySelector('code').innerText;
      var done = function () {
        btn.textContent = 'Copied';
        btn.classList.add('ok');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Select & copy'; }
        document.body.removeChild(ta);
      }
    });
    var wrap = document.createElement('div');
    wrap.className = 'codewrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.appendChild(btn);
  });

  // Onboarding tabs (seller / buyer) — also honour #seller / #buyer hashes
  var tabs = document.querySelectorAll('[role="tab"]');
  function show(id, focus) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('aria-controls') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(t.getAttribute('aria-controls')); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        show(n.getAttribute('aria-controls'), true);
      }
    });
  });
  function fromHash() {
    var h = location.hash.replace('#', '');
    if (h === 'seller' || h === 'buyer') {
      show('panel-' + h);
      var el = document.getElementById('onboarding');
      if (el) el.scrollIntoView();
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
