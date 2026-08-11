/* ==========================================================================
   SHOW THE PASSWORD

   Captains are typing a generated password like Dink-Z5GJAJ off a piece of
   paper, on a phone, in a dark hall, once. Not being able to see what they
   typed is the difference between getting in and calling the organiser over.

   Every password field on the page gets a reveal button, so this keeps
   working if a field is ever added. Fields are wrapped rather than restyled,
   which leaves each app's own input styling untouched.
   ========================================================================== */
(function () {
  'use strict';

  var EYE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path class="pw-open" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>' +
    '<circle class="pw-open" cx="12" cy="12" r="3"/>' +
    '<path class="pw-shut" d="M3 3l18 18"/>' +
    '<path class="pw-shut" d="M10.6 5.2A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.1' +
    'M6.3 6.4A17.6 17.6 0 0 0 2 12s3.6 7 10 7a10.7 10.7 0 0 0 4-.75"/>' +
    '<path class="pw-shut" d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>' +
    '</svg>';

  function attach(input) {
    if (input.dataset.pwEye) return;
    input.dataset.pwEye = '1';

    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.tabIndex = 0;
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = EYE;

    btn.addEventListener('click', function () {
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      btn.classList.toggle('is-on', reveal);
      btn.setAttribute('aria-pressed', String(reveal));
      btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      /* keep the caret where they left it, or typing restarts from the front */
      var at = input.value.length;
      input.focus();
      try { input.setSelectionRange(at, at); } catch (e) {}
    });

    wrap.appendChild(btn);
  }

  function scan(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(attach);
  }

  function init() {
    scan();
    /* a password field can arrive with a dialog later on */
    if (window.MutationObserver) {
      new MutationObserver(function () { scan(); })
        .observe(document.body, { childList: true, subtree: true });
    }
  }

  window.MNPassword = { scan: scan };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
