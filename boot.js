'use strict';
/* ============================================================
   Start-up. Everything else has already defined itself by the
   time this runs; this file only decides what happens first.
   ============================================================ */

/* The online lobby, the waiting room, the video window and the chat all
   attach here — after the table code, so they can call into it. */
initOnline();
paintLobby();

/* An installed app is expected to keep working when the network doesn't, so
   the shell is cached. There is nothing to cache for an actual game: those
   need the server by definition. */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {
      /* No service worker means no offline shell and no install prompt on
         some browsers. The game itself is unaffected, so this stays quiet. */
    });
  });
}

/* Windows and Android offer to install the app; Chrome hands us the prompt to
   fire ourselves. Rather than nag on arrival, the offer sits in the lobby
   footer until it is used or the app is installed. */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPrompt = e;
  const foot = document.querySelector('.lobby-foot');
  if (!foot || document.querySelector('#installBtn')) return;
  const b = document.createElement('button');
  b.className = 'linkbtn';
  b.id = 'installBtn';
  b.textContent = 'Install this as an app';
  b.onclick = async function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (err) {}
    installPrompt = null;
    b.remove();
  };
  foot.appendChild(b);
});
window.addEventListener('appinstalled', function () {
  installPrompt = null;
  const b = document.querySelector('#installBtn');
  if (b) b.remove();
});
