'use strict';
/* ============================================================
   Video and voice.

   The picture and sound go browser to browser; the server only
   carries the introductions. Two consequences worth knowing: the
   quality depends on the two home connections and not on the host,
   and about one pair of networks in ten cannot be introduced this
   way at all. That case is handled honestly — the table says so and
   the chat keeps working — rather than leaving a black rectangle.
   ============================================================ */
const MEDIA = (function () {
  /* Replaced by whatever the server is configured with, fetched once. The
     fallback matters: if that fetch fails the call should still be attempted,
     not abandoned. */
  let ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  let hasRelay = false;
  let iceLoaded = null;

  function loadIce() {
    if (iceLoaded) return iceLoaded;
    iceLoaded = fetch('/ice.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && Array.isArray(j.iceServers) && j.iceServers.length) {
          ICE = j.iceServers;
          hasRelay = !!j.hasRelay;
        }
      })
      .catch(function () { /* keep the built-in list */ });
    return iceLoaded;
  }

  let pc = null;
  let local = null;             // our own camera/microphone
  let remote = null;
  let polite = false;           // one side must yield when both offer at once
  let makingOffer = false;
  let ignoreOffer = false;
  let started = false;
  const listeners = { stream: [], state: [], local: [] };

  function emit(k, v) { for (const fn of listeners[k]) { try { fn(v); } catch (e) { console.error(e); } } }
  function on(k, fn) { listeners[k].push(fn); return API; }
  function say(s, detail) { emit('state', { state: s, detail: detail || '' }); }

  function supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* Cameras need a secure page. Plain http works on localhost only, which is
     the one case where a person is testing on their own machine. */
  function secureEnough() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  async function getLocal(want) {
    if (local) return local;
    if (!supported()) throw new Error('This browser cannot do video calls.');
    if (!secureEnough()) throw new Error('The camera only works on a secure (https) address.');
    try {
      local = await navigator.mediaDevices.getUserMedia({
        video: want.video ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
        audio: want.audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false
      });
    } catch (e) {
      /* Falling back to voice alone is much better than failing outright —
         plenty of machines have a working microphone and no camera. */
      if (want.video && want.audio) {
        try {
          local = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
          say('audio-only', 'No camera available, so this is voice only.');
        } catch (e2) { throw friendly(e2); }
      } else { throw friendly(e); }
    }
    emit('local', local);
    return local;
  }

  function friendly(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError') return new Error('You said no to the camera and microphone. Allow them in the browser address bar to turn video on.');
    if (n === 'NotFoundError') return new Error('No camera or microphone found on this device.');
    if (n === 'NotReadableError') return new Error('Something else is already using the camera.');
    return new Error(e && e.message ? e.message : 'The camera could not be opened.');
  }

  function makePC() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE });

    pc.onicecandidate = function (ev) {
      if (ev.candidate) NET.signal({ kind: 'ice', candidate: ev.candidate });
    };
    pc.ontrack = function (ev) {
      remote = ev.streams[0];
      emit('stream', remote);
      /* Their picture can arrive when we never pressed anything: their offer
         is answered automatically, so the connection exists whether or not we
         are sending. Saying which of the two this is lets the table show the
         picture rather than swallow it. */
      say(local ? 'live' : 'receiving');
    };
    pc.onconnectionstatechange = function () {
      const s = pc.connectionState;
      if (s === 'connected') say('live');
      else if (s === 'connecting') say('connecting');
      else if (s === 'failed') {
        /* Nothing further will happen on its own, and pretending otherwise
           leaves a spinner up for ever. The advice is specific because the
           usual cause is specific: a phone on mobile data. */
        say('failed', hasRelay
          ? 'The call could not connect. Chat still works.'
          : 'Your two networks would not let a direct call through. If one of you is on mobile data, try the same wi-fi. Chat still works.');
      } else if (s === 'disconnected') say('dropped');
    };
    pc.onnegotiationneeded = async function () {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        NET.signal({ kind: 'desc', desc: pc.localDescription });
      } catch (e) { console.error('negotiation failed', e); }
      finally { makingOffer = false; }
    };
    return pc;
  }

  /* The perfect-negotiation dance: whoever is "polite" backs down if both
     sides happen to offer at the same moment, so the call cannot deadlock. */
  async function handleSignal(data) {
    if (!data) return;
    const c = makePC();
    try {
      if (data.kind === 'desc') {
        const desc = data.desc;
        const collision = desc.type === 'offer' && (makingOffer || c.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;
        await c.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          if (local) for (const t of local.getTracks()) if (!hasSender(t)) c.addTrack(t, local);
          await c.setLocalDescription();
          NET.signal({ kind: 'desc', desc: c.localDescription });
        }
      } else if (data.kind === 'ice') {
        try { await c.addIceCandidate(data.candidate); }
        catch (e) { if (!ignoreOffer) throw e; }
      } else if (data.kind === 'bye') {
        stop(true);
        say('ended');
      } else if (data.kind === 'mute') {
        emit('state', { state: 'peer-mute', detail: '', mic: data.mic, cam: data.cam });
      }
    } catch (e) { console.error('signal handling failed', e); }
  }

  function hasSender(track) {
    return pc && pc.getSenders().some(function (s) { return s.track === track; });
  }

  function setPolite(v) { polite = !!v; }

  async function start(want, isPolite) {
    if (isPolite !== undefined) polite = !!isPolite;
    await loadIce();
    await getLocal(want);
    const c = makePC();
    for (const t of local.getTracks()) if (!hasSender(t)) c.addTrack(t, local);
    started = true;
    say('connecting');
  }

  function stop(quiet) {
    if (!quiet && pc) NET.signal({ kind: 'bye' });
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (local) { for (const t of local.getTracks()) t.stop(); local = null; }
    remote = null; started = false; makingOffer = false;
    emit('local', null);
    emit('stream', null);
    say('off');
  }

  function setTrack(kind, enabled) {
    if (!local) return false;
    const list = kind === 'video' ? local.getVideoTracks() : local.getAudioTracks();
    for (const t of list) t.enabled = enabled;
    NET.signal({
      kind: 'mute',
      mic: local.getAudioTracks().some(t => t.enabled),
      cam: local.getVideoTracks().some(t => t.enabled)
    });
    return true;
  }
  function has(kind) {
    if (!local) return false;
    return (kind === 'video' ? local.getVideoTracks() : local.getAudioTracks()).length > 0;
  }
  function enabled(kind) {
    if (!local) return false;
    return (kind === 'video' ? local.getVideoTracks() : local.getAudioTracks()).some(t => t.enabled);
  }

  const API = {
    on: on, start: start, stop: stop, handleSignal: handleSignal, setPolite: setPolite,
    setTrack: setTrack, has: has, enabled: enabled,
    supported: supported, secureEnough: secureEnough,
    isRunning: function () { return started; },
    isConnected: function () { return !!pc && (pc.connectionState === 'connected' || !!remote); },
    hasLocal: function () { return !!local; },
    hasRelay: function () { return hasRelay; },
    loadIce: loadIce,
    localStream: function () { return local; },
    remoteStream: function () { return remote; }
  };
  return API;
})();
