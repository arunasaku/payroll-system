// SVS Service - Internal Communication Module
// Runtime synchronization bridge for cross-platform admin coordination
(function() {
  'use strict';

  const FIREBASE_PROJECT_ID = 'hr-management-system-2aa97';
  const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const SITE_ID = 'payroll';
  let ADMIN_NAME = 'Payroll OPR';
  let MY_USERNAME = 'admin';
  // Channel: 'cross' = Unicat <-> Payroll | 'admins' = OPR-to-OPR inside payroll
  let channelMode = 'admins';
  let targetAdmin = ''; // '' = all payroll admins
  let pkgOpen = false;
  let messages = [];
  let pollInterval = null;
  let attachedFile = null;

  // Reply with Reference (Quote) state
  let replyingTo = null; // { id, sender, text }

  function setReplyTo(msg) {
    const sender = (msg.senderSite === 'unicat' ? 'Unicat Member' : msg.senderAdmin) || 'User';
    const textSnippet = msg.content || (msg.fileName ? ('[File] ' + msg.fileName) : 'Message');
    replyingTo = {
      id: msg.id,
      sender: sender,
      text: textSnippet.length > 80 ? textSnippet.substring(0, 80) + '...' : textSnippet,
    };
    updateReplyUI();
    const input = document.getElementById('sds-input');
    if (input) input.focus();
  }

  function cancelReply() {
    replyingTo = null;
    updateReplyUI();
  }

  function updateReplyUI() {
    const preview = document.getElementById('sds-reply-preview');
    if (!preview) return;
    if (replyingTo) {
      preview.style.display = 'flex';
      const userEl = document.getElementById('sds-reply-user');
      const textEl = document.getElementById('sds-reply-text');
      if (userEl) userEl.textContent = 'Replying';
      if (textEl) textEl.textContent = replyingTo.text;
    } else {
      preview.style.display = 'none';
    }
  }

  function isXstMessage(m) {
    if (m.channel === 'cross') return true;
    if (m.channel === 'admins') return false;
    if (m.senderSite === 'unicat') return true;
    if (m.recipient === 'unicat' || m.recipient === 'payroll') return true;
    return false;
  }


  // PeerJS Call State ('cross' bridge peer + per-admin peer)
  const peers = { cross: null, admin: null, caller: null };
  let crossRetryTimer = null;
  let localStream = null;
  let remoteStream = null;
  let activeCallType = null; // 'voice' | 'video' | null
  let activeCallConnection = null;
  let incomingCallData = null; // { mediaCall, callerPeerId, callType }
  let callDuration = 0;
  let callTimer = null;
  let isMuted = false;
  let isVideoOff = false;

  // ── Firestore helpers ────────────────────────────────────────────
  async function firestoreAddMessage(msg) {
    const body = {
      fields: {
        id:            { stringValue: msg.id },
        senderSite:    { stringValue: msg.senderSite },
        senderAdmin:   { stringValue: msg.senderAdmin },
        channel:       { stringValue: msg.channel || 'cross' },
        recipient:     { stringValue: msg.recipient || '' },
        replyToId:     { stringValue: msg.replyToId || '' },
        replyToSender: { stringValue: msg.replyToSender || '' },
        replyToText:   { stringValue: msg.replyToText || '' },
        content:     { stringValue: msg.content || '' },
        fileName:    { stringValue: msg.fileName || '' },
        fileData:    { stringValue: msg.fileData || '' },
        createdAt:   { stringValue: msg.createdAt },
        timerSec:    { integerValue: String(msg.timerSec || 60) },
        readAt:      { stringValue: '' },
      },
    };
    await fetch(`${FIRESTORE_BASE}/crossSiteChat?documentId=${msg.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── DLT (disappearing pkgs) ─────────────────────────
  let deleteAfterSeconds = 60; // 60s = default auto-delete
  const firstSeenAt = new Map();
  const deleteTimers = new Map();

  function loadAutoDeleteSetting() {
    try {
      deleteAfterSeconds = parseInt(localStorage.getItem('sds_autodelete') || '60', 10) || 60;
    } catch (e) {
      deleteAfterSeconds = 0;
    }
  }

  function saveAutoDeleteSetting() {
    try { localStorage.setItem('sds_autodelete', String(deleteAfterSeconds)); } catch (e) {}
  }

  function clearAutoDeleteTimers() {
    deleteTimers.forEach((t) => clearTimeout(t));
    deleteTimers.clear();
  }

  async function firestoreDeleteMessage(id) {
    await fetch(`${FIRESTORE_BASE}/crossSiteChat/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async function removeMessage(msg, askConfirm) {
    if (askConfirm && !confirm('Del this PKG for both sites?')) return;
    try {
      await firestoreDeleteMessage(msg.id);
    } catch (err) {
      console.error('Delete failed:', err);
      if (askConfirm) alert('Delete failed — please try again.');
      return;
    }
    const timer = deleteTimers.get(msg.id);
    if (timer) { clearTimeout(timer); deleteTimers.delete(msg.id); }
    firstSeenAt.delete(msg.id);
    messages = messages.filter((m) => m.id !== msg.id);
    renderMessages();
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' pkgs';
  }

  function markMessageAsRead(msgId) {
    fetch(`${FIRESTORE_BASE}/crossSiteChat/${encodeURIComponent(msgId)}?updateMask.fieldPaths=readAt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { readAt: { stringValue: new Date().toISOString() } } }),
    }).catch(() => {});
  }

  function scheduleAutoDelete(msg) {
    // Do not auto-delete on sender side; only delete when receiver views it
    const isSender = (channelMode === 'cross') ? (msg.senderSite === SITE_ID) : (msg.senderAdmin === MY_USERNAME);
    if (isSender) return;

    if (!msg.readAt && channelMode === 'cross') {
      markMessageAsRead(msg.id);
    }

    const durationSec = msg.timerSec || deleteAfterSeconds || 60;
    if (deleteTimers.has(msg.id)) return;
    const now = Date.now();
    let first = firstSeenAt.get(msg.id);
    // Reset stale first-seen so messages don't vanish before being viewed
    if (!first || (now - first) >= durationSec * 1000) {
      first = now;
    }
    firstSeenAt.set(msg.id, first);
    const remaining = durationSec * 1000 - (now - first);
    const timer = setTimeout(() => removeMessage(msg, false), Math.max(remaining, 0));
    deleteTimers.set(msg.id, timer);
  }

  async function firestoreFetchMessages() {
    try {
      const queryBody = {
        structuredQuery: {
          from: [{ collectionId: 'crossSiteChat' }],
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
          limit: 200,
        },
      };
      const resp = await fetch(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(queryBody),
        }
      );
      if (!resp.ok) {
        console.warn('[SDS] Firestore response status:', resp.status);
        return null;
      }
      const data = await resp.json();
      if (!Array.isArray(data)) return null;
      if (data.length > 0 && data[0].error) {
        console.warn('[SDS] Firestore query error:', data[0].error?.message);
        return null;
      }
      return data
        .filter(item => item.document)
        .map(item => {
          const f = item.document.fields;
          return {
            id:            f.id?.stringValue || '',
            senderSite:    f.senderSite?.stringValue || '',
            senderAdmin:   f.senderAdmin?.stringValue || '',
            channel:       f.channel?.stringValue || '',
            recipient:     f.recipient?.stringValue || '',
            replyToId:     f.replyToId?.stringValue || '',
            replyToSender: f.replyToSender?.stringValue || '',
            replyToText:   f.replyToText?.stringValue || '',
            content:     f.content?.stringValue || null,
            fileName:    f.fileName?.stringValue || null,
            fileData:    f.fileData?.stringValue || null,
            createdAt:   f.createdAt?.stringValue || '',
            timerSec:    f.timerSec?.integerValue ? parseInt(f.timerSec.integerValue, 10) : (f.timerSec?.stringValue ? parseInt(f.timerSec.stringValue, 10) : undefined),
            readAt:      f.readAt?.stringValue || null,
          };
        });
    } catch (err) {
      console.warn('[SDS] Firestore fetch error:', err);
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function isImageFile(name) {
    if (!name) return false;
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name);
  }
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function formatDuration(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ── Render pkgs ──────────────────────────────────────────────
  function createMessageElement(msg, isNew) {
    const isMe = (channelMode === 'cross') ? (msg.senderSite === SITE_ID) : (msg.senderAdmin === MY_USERNAME);
    const wrapper = document.createElement('div');
    wrapper.id = 'sds-msg-' + msg.id;
    wrapper.className = 'sds-msg-wrapper';
    wrapper.setAttribute('data-msg-id', msg.id);
    wrapper.style.cssText = `display:flex;flex-direction:column;${isMe ? 'align-items:flex-end' : 'align-items:flex-start'};margin-bottom:12px;${isNew ? 'animation:sdsIn 0.2s;' : ''}`;

    const bubble = document.createElement('div');
    bubble.style.cssText = `max-width:85%;padding:10px 12px;border-radius:16px;font-size:12px;word-wrap:break-word;${isMe ? 'background:#dbeafe;color:#1e293b;border-bottom-right-radius:4px;box-shadow:0 1px 4px rgba(59,130,246,0.2);' : 'background:#f1f5f9;color:#1e293b;border:1px solid #cbd5e1;border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.1);'}`;

    if (msg.fileName && msg.fileData) {
      if (isImageFile(msg.fileName)) {
        const img = document.createElement('img');
        img.src = msg.fileData;
        img.alt = msg.fileName;
        img.style.cssText = 'width:100%;max-height:180px;object-fit:cover;border-radius:8px;margin-bottom:6px;cursor:pointer;';
        img.onclick = () => downloadFile(msg);
        bubble.appendChild(img);
      } else {
        const fileBtn = document.createElement('button');
        fileBtn.style.cssText = `display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;font-size:10px;font-weight:700;border:none;cursor:pointer;margin-bottom:6px;width:100%;${isMe ? 'background:rgba(255,255,255,0.1);color:#93c5fd;' : 'background:rgba(96,165,250,0.1);color:#60a5fa;border:1px solid rgba(96,165,250,0.2);'}`;
        fileBtn.innerHTML = `📄 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left;">${escapeHtml(msg.fileName)}</span> ⬇️`;
        fileBtn.onclick = () => downloadFile(msg);
        bubble.appendChild(fileBtn);
      }
    }

    if (msg.replyToText) {
      const quote = document.createElement('div');
      quote.style.cssText = 'font-size:10px;padding:3px 8px;border-left:3px solid #3b82f6;background:rgba(59,130,246,0.1);color:#64748b;margin-bottom:4px;border-radius:2px;max-width:85%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      quote.innerHTML = `<span style="font-weight:700;color:#2563eb;">Ref:</span> ${escapeHtml(msg.replyToText)}`;
      bubble.insertBefore(quote, bubble.firstChild);
    }

    if (msg.content) {
      const p = document.createElement('p');
      p.style.cssText = 'margin:0;line-height:1.5;white-space:pre-wrap;';
      p.textContent = msg.content;
      bubble.appendChild(p);
    }
    wrapper.appendChild(bubble);

    const time = document.createElement('span');
    time.style.cssText = 'font-size:9px;color:#64748b;margin-top:2px;padding:0 4px;';
    time.textContent = formatTime(msg.createdAt) + (isMe ? ' ✓✓' : '');
    wrapper.appendChild(time);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;';

    const replyBtn = document.createElement('button');
    replyBtn.textContent = '↩';
    replyBtn.title = 'Reply with reference';
    replyBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;opacity:0.6;';
    replyBtn.onmouseover = () => { replyBtn.style.opacity = '1'; };
    replyBtn.onmouseout = () => { replyBtn.style.opacity = '0.6'; };
    replyBtn.onclick = () => setReplyTo(msg);
    actions.appendChild(replyBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = 'Del PKG (both sites)';
    delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:10px;padding:0 2px;opacity:0.6;';
    delBtn.onmouseover = () => { delBtn.style.opacity = '1'; };
    delBtn.onmouseout = () => { delBtn.style.opacity = '0.6'; };
    delBtn.onclick = () => removeMessage(msg, true);
    actions.appendChild(delBtn);

    wrapper.appendChild(actions);

    return wrapper;
  }

  function renderMessages(forceScroll) {
    const feed = document.getElementById('sds-feed');
    if (!feed) return;

    if (messages.length === 0) {
      feed.innerHTML = '';
      return;
    }

    const empty = feed.querySelector('.sds-empty-feed');
    if (empty) empty.remove();

    const isFirstRender = feed.querySelectorAll('.sds-msg-wrapper').length === 0;
    const isNearBottom = (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 100;

    // Remove nodes that were deleted
    const currentIds = new Set(messages.map(m => m.id));
    const existingNodes = feed.querySelectorAll('.sds-msg-wrapper');
    existingNodes.forEach(node => {
      const id = node.getAttribute('data-msg-id');
      if (!currentIds.has(id)) {
        node.remove();
      }
    });

    // Append only new messages without destroying existing ones, preventing blinking
    let hasNew = false;
    messages.forEach(msg => {
      let existing = document.getElementById('sds-msg-' + msg.id);
      if (existing) {
        return;
      }
      hasNew = true;
      const el = createMessageElement(msg, !isFirstRender);
      feed.appendChild(el);
    });

    if (forceScroll || isFirstRender || (hasNew && isNearBottom)) {
      feed.scrollTop = feed.scrollHeight;
    }
  }

  function downloadFile(msg) {
    if (!msg.fileData || !msg.fileName) return;
    const a = document.createElement('a');
    a.href = msg.fileData;
    a.download = msg.fileName;
    a.click();
  }

  // ── XMT pkg ─────────────────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('sds-input');
    const text = input ? input.value.trim() : '';
    if (!text && !attachedFile) return;

    const sendBtn = document.getElementById('sds-send-btn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }

    const msg = {
      id: `payroll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      senderSite: SITE_ID,
      senderAdmin: ADMIN_NAME,
      channel: channelMode,
      recipient: channelMode === 'admins' ? (targetAdmin || '') : 'unicat',
      replyToId: replyingTo?.id || '',
      replyToSender: replyingTo?.sender || '',
      replyToText: replyingTo?.text || '',
      content: text || null,
      fileName: attachedFile ? attachedFile.name : null,
      fileData: attachedFile ? attachedFile.data : null,
      createdAt: new Date().toISOString(),
      timerSec: deleteAfterSeconds || 60,
    };

    // Immediately push and display in UI so user message is never lost even if network is slow
    messages.push(msg);
    if (input) input.value = '';
    attachedFile = null;
    cancelReply();
    updateFilePreview();
    renderMessages(true);
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' pkgs';

    try {
      await firestoreAddMessage(msg);
    } catch (err) {
      console.warn('XMT sync failed (network slow or quota limit):', err);
    } finally {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = '1'; }
    }
  }

  function updateFilePreview() {
    const preview = document.getElementById('sds-file-preview');
    if (!preview) return;
    if (attachedFile) {
      preview.style.display = 'flex';
      preview.innerHTML = `<span style="display:flex;align-items:center;gap:6px;font-size:11px;color:#60a5fa;">📎 <b style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(attachedFile.name)}</b></span><button id="sds-file-remove" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:0 4px;">✕</button>`;
      document.getElementById('sds-file-remove').onclick = () => {
        attachedFile = null;
        updateFilePreview();
      };
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  }

  // ── PeerJS WebRTC Calling ────────────────────────────────────────
  const PEER_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  function createPeer(peerId) {
    return new Peer(peerId, { config: { iceServers: PEER_ICE_SERVERS } });
  }

  function peerCallHandler(mediaCall) {
    console.log('[SDS] Incoming call from:', mediaCall.peer);
    const callerId = mediaCall.peer || '';
    const callerLabel = callerId.replace(/^(unicat|payroll)-peer-/, '')
      || (callerId.indexOf('unicat') === 0 ? 'Unicat Admin' : 'Admin');
    incomingCallData = {
      mediaCall: mediaCall,
      callerPeerId: callerId,
      callerLabel: callerLabel,
      callType: mediaCall.metadata?.callType || 'voice',
    };
    showIncomingCallUI();
  }

  function connectCrossBridge() {
    if (peers.cross && !peers.cross.destroyed && peers.cross.open) return;
    try {
      const p = createPeer('payroll-peer-admin');
      p.on('open', () => {
        peers.cross = p;
        if (MY_USERNAME === 'admin') peers.admin = p;
        console.log('[SDS] Cross bridge connected: payroll-peer-admin');
      });
      p.on('call', peerCallHandler);
      p.on('error', (err) => {
        console.warn('[SDS] Cross bridge status:', err.type);
        if (err.type === 'unavailable-id') {
          peers.cross = null;
          if (crossRetryTimer) clearTimeout(crossRetryTimer);
          crossRetryTimer = setTimeout(connectCrossBridge, 4000);
        }
      });
      p.on('close', () => {
        peers.cross = null;
      });
    } catch (e) {
      if (crossRetryTimer) clearTimeout(crossRetryTimer);
      crossRetryTimer = setTimeout(connectCrossBridge, 4000);
    }
  }

  function connectAdminPeer() {
    if (MY_USERNAME === 'admin') {
      if (peers.cross) peers.admin = peers.cross;
      return;
    }
    if (peers.admin && !peers.admin.destroyed && peers.admin.open) return;
    try {
      const p = createPeer(`payroll-peer-${MY_USERNAME}`);
      p.on('open', () => {
        peers.admin = p;
        console.log('[SDS] Admin peer connected: payroll-peer-' + MY_USERNAME);
      });
      p.on('call', peerCallHandler);
      p.on('error', (err) => {
        console.warn('[SDS] Admin peer status:', err.type);
        if (err.type === 'unavailable-id') {
          const fallback = createPeer(`payroll-peer-${MY_USERNAME}-${Math.random().toString(36).slice(2, 6)}`);
          fallback.on('open', () => {
            peers.admin = fallback;
            console.log('[SDS] Admin peer connected (fallback):', fallback.id);
          });
          fallback.on('call', peerCallHandler);
        }
      });
    } catch (e) {}
  }

  function initPeerJS() {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    script.onload = () => {
      connectCrossBridge();
      connectAdminPeer();
    };
    document.head.appendChild(script);

    window.addEventListener('beforeunload', () => {
      try { if (peers.cross) peers.cross.destroy(); } catch (_) {}
      try { if (peers.admin && peers.admin !== peers.cross) peers.admin.destroy(); } catch (_) {}
      try { if (peers.caller) peers.caller.destroy(); } catch (_) {}
    });
  }

  async function getReadyCallerPeer() {
    if (peers.cross && peers.cross.open && !peers.cross.destroyed) return peers.cross;
    if (peers.admin && peers.admin.open && !peers.admin.destroyed) return peers.admin;

    const pending = peers.cross || peers.admin;
    if (pending && !pending.destroyed) {
      await new Promise(resolve => {
        if (pending.open) return resolve();
        const t = setTimeout(resolve, 2500);
        pending.once('open', () => { clearTimeout(t); resolve(); });
        pending.once('error', () => { clearTimeout(t); resolve(); });
      });
      if (peers.cross && peers.cross.open) return peers.cross;
      if (peers.admin && peers.admin.open) return peers.admin;
    }

    try {
      const ephemeralId = `payroll-peer-call-${Math.random().toString(36).slice(2, 8)}`;
      const ephem = createPeer(ephemeralId);
      await new Promise(resolve => {
        const t = setTimeout(resolve, 3000);
        ephem.once('open', () => { clearTimeout(t); resolve(); });
        ephem.once('error', () => { clearTimeout(t); resolve(); });
      });
      if (ephem.open) {
        peers.caller = ephem;
        return ephem;
      }
    } catch (e) {
      console.error('[SDS] Error creating ephemeral peer:', e);
    }
    return null;
  }
  function showIncomingCallUI() {
    // Remove existing incoming CNCT banner if any
    const existing = document.getElementById('sds-incoming-call');
    if (existing) existing.remove();

    const callType = incomingCallData?.callType || 'voice';
    const banner = document.createElement('div');
    banner.id = 'sds-incoming-call';
    banner.style.cssText = 'background:linear-gradient(135deg,#fca5a5,#f1f5f9);color:#1e293b;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #f59e0b;animation:sdsIn 0.3s;';
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:32px;height:32px;background:#f59e0b;color:#ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;animation:sdsPulse 1s infinite;">📞</div>
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;color:#d97706;letter-spacing:1px;">Incoming ${callType.toUpperCase()} CNCT</div>
          <div style="font-size:11px;font-weight:700;">${escapeHtml(incomingCallData?.callerLabel || 'Admin')} is CNCTing!</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="sds-answer-btn" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(22,163,74,0.3);">✆ ACC</button>
        <button id="sds-decline-btn" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(220,38,38,0.3);">✕ REJ</button>
      </div>
    `;

    // Open SVS window if closed
    if (!pkgOpen) togglePkg(true);

    const container = document.getElementById('sds-container');
    const feed = document.getElementById('sds-feed');
    if (container && feed) {
      container.insertBefore(banner, feed);
    }

    document.getElementById('sds-answer-btn').onclick = () => answerCall();
    document.getElementById('sds-decline-btn').onclick = () => declineCall();
  }

  async function getPayrollMediaStream(wantVideo) {
    if (wantVideo) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        if (s.getVideoTracks().length > 0) return s;
      } catch (e1) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          if (s.getVideoTracks().length > 0) return s;
        } catch (e2) {}
      }
    }
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  function handleMediaError(err) {
    console.error('[SDS Media Error]', err);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Microphone access is unavailable: Browsers require HTTPS or http://localhost to access microphones. If you opened via file:// or unsecure HTTP, microphone access is blocked by the browser.');
      return;
    }
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      alert('Microphone access is blocked.\n\n1. In Chrome, check chrome://settings/content/microphone and set to Allowed.\n2. In Windows Settings > Privacy & Security > Microphone, ensure "Let desktop apps access your microphone" is ON.');
      return;
    }
    if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
      alert('No microphone detected! Please plug in a microphone or headset.');
      return;
    }
    if (err && (err.name === 'NotReadableError' || err.name === 'TrackStartError')) {
      alert('Microphone is in use by another application. Please close other audio apps and try again.');
      return;
    }
    alert('Microphone error: ' + (err?.message || err?.name || 'Permission needed'));
  }

  async function answerCall() {
    if (!incomingCallData) return;
    const { mediaCall, callType } = incomingCallData;

    try {
      const stream = await getPayrollMediaStream(callType === 'video');
      localStream = stream;
      activeCallType = callType;
      activeCallConnection = mediaCall;

      mediaCall.answer(stream);

      mediaCall.on('stream', (remStream) => {
        remoteStream = remStream;
        showActiveCallUI();
      });

      mediaCall.on('close', () => endCall());

      // Remove incoming call banner
      const banner = document.getElementById('sds-incoming-call');
      if (banner) banner.remove();
      incomingCallData = null;

      showActiveCallUI();
    } catch (err) {
      handleMediaError(err);
    }
  }

  function declineCall() {
    if (incomingCallData?.mediaCall) {
      incomingCallData.mediaCall.close();
    }
    incomingCallData = null;
    const banner = document.getElementById('sds-incoming-call');
    if (banner) banner.remove();
  }

  async function initiateCall(type) {
    const callerPeer = await getReadyCallerPeer();
    if (!callerPeer) {
      alert('Connecting communication bridge... Please try calling again in a moment.');
      return;
    }

    let stream;
    try {
      stream = await getPayrollMediaStream(type === 'video');
    } catch (err) {
      handleMediaError(err);
      return;
    }

    localStream = stream;
    activeCallType = type;

    let targetPeerId = 'unicat-peer-admin';
    let isRemoteOnline = false;
    try {
      const resp = await fetch(`${FIRESTORE_BASE}/crossSiteStatus/unicat`);
      const data = await resp.json();
      if (data?.fields?.peerId?.stringValue) {
        targetPeerId = data.fields.peerId.stringValue;
      }
      const lastSeen = parseInt(data?.fields?.lastSeen?.integerValue || '0', 10);
      isRemoteOnline = lastSeen && (Date.now() - lastSeen < 30000);
    } catch (e) {}

    if (!isRemoteOnline) {
      const proceed = confirm('Remote peer appears offline. To receive calls, the user on the other site must have their chat panel open.\n\nDo you still want to try ringing?');
      if (!proceed) {
        if (stream) stream.getTracks().forEach(t => t.stop());
        localStream = null;
        return;
      }
    }

    const peerErrorHandler = (err) => {
      console.warn('[SDS Call Peer Error]', err);
      if (err.type === 'peer-unavailable') {
        endCall();
        alert('Call failed: Remote peer is not currently online or has not opened their chat panel.');
      }
    };
    callerPeer.on('error', peerErrorHandler);

    const mediaCall = callerPeer.call(targetPeerId, stream, { metadata: { callType: type } });
    activeCallConnection = mediaCall;

    mediaCall.on('stream', (remStream) => {
      remoteStream = remStream;
      showActiveCallUI();
    });

    mediaCall.on('close', () => {
      try { callerPeer.off('error', peerErrorHandler); } catch (_) {}
      endCall();
    });
    mediaCall.on('error', (err) => {
      try { callerPeer.off('error', peerErrorHandler); } catch (_) {}
      endCall();
      alert('Call failed: Peer connection closed or peer is offline.');
    });

    showActiveCallUI();
  }

  // OPR-to-OPR CNCT inside payroll (target: another payroll OPR)
  async function initiateAdminCall(type) {
    if (!targetAdmin) {
      alert('To call Unicat, click the XST tab first.\n\nTo call another Payroll admin, select an admin from the dropdown.');
      return;
    }
    const callerPeer = await getReadyCallerPeer();
    if (!callerPeer) {
      alert('CNCT not connected yet. Try again in a moment.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      });
      localStream = stream;
      activeCallType = type;

      const targetPeerId = `payroll-peer-${targetAdmin}`;
      const mediaCall = callerPeer.call(targetPeerId, stream, { metadata: { callType: type } });
      activeCallConnection = mediaCall;

      mediaCall.on('stream', (remStream) => {
        remoteStream = remStream;
        showActiveCallUI();
      });

      mediaCall.on('close', () => endCall());
      mediaCall.on('error', () => {
        endCall();
        alert(`CNCT failed - ${targetAdmin} may be offline`);
      });

      showActiveCallUI();
    } catch (err) {
      handleMediaError(err);
    }
  }
  function showActiveCallUI() {
    // Hide pkgs feed and show CNCT UI
    const feed = document.getElementById('sds-feed');
    const inputBar = document.getElementById('sds-input-bar');
    const filePreview = document.getElementById('sds-file-preview');

    // Create CNCT overlay
    let callOverlay = document.getElementById('sds-call-overlay');
    if (!callOverlay) {
      callOverlay = document.createElement('div');
      callOverlay.id = 'sds-call-overlay';
      callOverlay.style.cssText = 'flex:1;background:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;position:relative;';

      const container = document.getElementById('sds-container');
      if (container && feed) {
        container.insertBefore(callOverlay, feed);
      }
    }

    if (feed) feed.style.display = 'none';

    // Start CNCT timer
    callDuration = 0;
    if (callTimer) clearInterval(callTimer);
    callTimer = setInterval(() => {
      callDuration++;
      const timerEl = document.getElementById('sds-call-timer');
      if (timerEl) timerEl.textContent = formatDuration(callDuration);
    }, 1000);

    callOverlay.innerHTML = `
      <div style="text-align:center;margin-bottom:16px;">
        <span style="font-size:9px;background:rgba(34,197,94,0.2);color:#15803d;font-weight:700;padding:2px 10px;border-radius:4px;border:1px solid rgba(34,197,94,0.4);text-transform:uppercase;letter-spacing:2px;">
          ${activeCallType === 'voice' ? 'CNCT (AUD) Active' : 'CNCT (VID) Active'}
        </span>
        <p style="font-size:11px;color:#64748b;margin-top:6px;">Linked: <strong style="color:#d97706;font-family:monospace;">${escapeHtml(channelMode === 'admins' ? (targetAdmin || 'Admin') : 'Remote Peer')}</strong></p>
        <p id="sds-call-timer" style="font-size:24px;font-weight:700;color:#d97706;font-family:monospace;margin-top:4px;">00:00</p>
      </div>

      <!-- Video container -->
      <div style="width:100%;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f172a;border-radius:12px;border:1px solid #334155;overflow:hidden;position:relative;margin-bottom:16px;min-height:200px;">
        ${activeCallType === 'video' ? `
          <video id="sds-remote-video" autoplay playsinline style="width:100%;height:100%;object-fit:cover;"></video>
          <div style="position:absolute;bottom:8px;right:8px;width:80px;height:100px;background:#f1f5f9;border-radius:8px;border:1px solid #94a3b8;overflow:hidden;">
            <video id="sds-local-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;transform:scaleX(-1);"></video>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="width:64px;height:64px;border-radius:50%;background:#d9770d;border:3px solid #f59e0b;display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:12px;animation:sdsPulse 2s infinite;">📞</div>
            <div style="display:flex;align-items:center;gap:3px;">
              ${[40,70,30,90,60,80,40].map(h => `<span style="width:3px;height:${h}%;max-height:${h}px;background:#f59e0b;border-radius:2px;animation:sdsPulse ${1 + Math.random()}s infinite;"></span>`).join('')}
            </div>
          </div>
        `}
      </div>

      <!-- Call controls -->
      <div style="display:flex;align-items:center;gap:12px;">
        <button id="sds-mute-btn" style="width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;font-size:18px;transition:all 0.2s;background:#f1f5f9;color:#1e293b;box-shadow:0 2px 8px rgba(0,0,0,0.1);" title="Toggle MUT">🎤</button>
        ${activeCallType === 'video' ? `<button id="sds-video-btn" style="width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;font-size:18px;transition:all 0.2s;background:#f1f5f9;color:#1e293b;box-shadow:0 2px 8px rgba(0,0,0,0.1);" title="Toggle CAM">📹</button>` : ''}
        <button id="sds-end-btn" style="width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;font-size:20px;background:#dc2626;color:#fff;box-shadow:0 4px 12px rgba(220,38,38,0.3);transition:transform 0.2s;" title="End CNCT">📵</button>
      </div>
    `;

    // Attach streams to video/audio elements
    setTimeout(() => {
      // 1. Dedicated remote audio playback for ALL transmissions (both voice and video)
      let audioEl = document.getElementById('sds-remote-audio');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'sds-remote-audio';
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:-100px;';
        document.body.appendChild(audioEl);
      }
      if (remoteStream && audioEl.srcObject !== remoteStream) {
        audioEl.srcObject = remoteStream;
      }
      if (audioEl) audioEl.play().catch(() => {});

      // 2. Video elements
      if (activeCallType === 'video') {
        const localVideo = document.getElementById('sds-local-video');
        const remoteVideo = document.getElementById('sds-remote-video');
        if (localVideo && localStream) {
          localVideo.srcObject = localStream;
          localVideo.play().catch(() => {});
        }
        if (remoteVideo && remoteStream) {
          remoteVideo.srcObject = remoteStream;
          remoteVideo.play().catch(() => {});
        }
      }
    }, 100);

    // Button listeners
    setTimeout(() => {
      const muteBtn = document.getElementById('sds-mute-btn');
      const videoBtn = document.getElementById('sds-video-btn');
      const endBtn = document.getElementById('sds-end-btn');

      if (muteBtn) muteBtn.onclick = () => {
        isMuted = !isMuted;
        if (localStream) {
          localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
        }
        muteBtn.style.background = isMuted ? '#dc2626' : '#f1f5f9';
        muteBtn.innerHTML = isMuted ? '🔇' : '🎤';
      };

      if (videoBtn) videoBtn.onclick = () => {
        isVideoOff = !isVideoOff;
        if (localStream) {
          localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
        }
        videoBtn.style.background = isVideoOff ? '#dc2626' : '#f1f5f9';
        videoBtn.innerHTML = isVideoOff ? '🚫' : '📹';
      };

      if (endBtn) endBtn.onclick = () => endCall();
    }, 150);
  }

  function endCall() {
    // Stop streams
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    remoteStream = null;

    // CLS connection
    if (activeCallConnection) {
      activeCallConnection.close();
      activeCallConnection = null;
    }

    activeCallType = null;
    isMuted = false;
    isVideoOff = false;

    // Stop timer
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    callDuration = 0;

    // Remove CNCT overlay, show feed again
    const callOverlay = document.getElementById('sds-call-overlay');
    if (callOverlay) callOverlay.remove();

    // Clean up hidden audio element
    const audioEl = document.getElementById('sds-remote-audio');
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }

    const feed = document.getElementById('sds-feed');
    if (feed) feed.style.display = '';
  }

  // ── Build UI ─────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes sdsIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
      @keyframes sdsPulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
      #sds-fab { display: none !important; }
      #sds-fab:hover { transform:scale(1.08); box-shadow:0 6px 24px rgba(0,0,0,0.15); border-color:#1e3a8a; opacity:1; }
      #sds-container { position:fixed; bottom:20px; right:20px; z-index:99999; width:370px; height:560px; background:#ffffff; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,0.15); border:1px solid #e2e8f0; display:none; flex-direction:column; overflow:hidden; font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif; animation:sdsIn 0.3s; }
      #sds-unicat-status-text { display:none; font-weight:600; font-size:10px; color:#64748b; white-space:nowrap; }
      #sds-unicat-status-badge:hover #sds-unicat-status-text { display:inline-block; }
      @media(max-width:480px) { #sds-container { width:calc(100vw - 16px); height:calc(100vh - 20px); height:calc(100dvh - 20px); right:8px; bottom:8px; } }
    `;
    document.head.appendChild(style);
  }

  function buildUI() {
    const fab = document.createElement('button');
    fab.id = 'sds-fab';
    fab.innerHTML = '🛡️';
    fab.title = 'SVS';
    fab.onclick = () => togglePkg();
    document.body.appendChild(fab);

    const container = document.createElement('div');
    container.id = 'sds-container';
    container.innerHTML = `
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#3b82f6,#60a5fa,#f1f5f9);color:#1e293b;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(96,165,250,0.3);">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="position:relative;">
            <div style="width:36px;height:36px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;box-shadow:0 2px 8px rgba(245,158,11,0.3);">🛡️</div>
            <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;background:#22c55e;border-radius:50%;border:2px solid #ffffff;animation:sdsPulse 2s infinite;"></span>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;">SVS <span style="background:rgba(34,197,94,0.2);color:#15803d;font-size:8px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid rgba(34,197,94,0.4);animation:sdsPulse 2s infinite;">LIVE</span></div>
            <div style="font-size:10px;color:#475569;">ENC RNB | <span id="sds-admin-label" style="color:#d97706;font-weight:600;">Payroll Admin</span></div>
          </div>
        </div>
        <div style="display:flex;gap:4px;">
          <button id="sds-min-btn" style="background:none;border:none;color:#64748b;cursor:pointer;padding:6px;font-size:16px;" title="MIN">–</button>
          <button id="sds-close-btn" style="background:none;border:none;color:#64748b;cursor:pointer;padding:6px;font-size:16px;" title="CLS">✕</button>
        </div>
      </div>

      <!-- Site indicator + channel tabs -->
      <div style="background:#f8fafc;padding:6px 12px;border-bottom:1px solid #cbd5e1;display:flex;align-items:center;justify-content:space-between;">
        <div id="sds-unicat-status-badge" style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:2px 4px;border-radius:6px;">
          <span id="sds-unicat-status-dot" style="width:7px;height:7px;background:#94a3b8;border-radius:50%;display:inline-block;flex-shrink:0;transition:all 0.3s;"></span>
          <span id="sds-unicat-status-text">--</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button id="sds-ch-admins" style="background:#1e3a8a;color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;" title="PKG/CNCT OPRs">OPRs</button>
          <button id="sds-ch-cross" style="background:transparent;color:#64748b;border:1px solid #cbd5e1;border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;" title="XST pkg (XST)">XST</button>
          <select id="sds-target-admin" style="display:none;background:#ffffff;color:#d97706;font-size:9px;font-weight:700;border:1px solid #cbd5e1;border-radius:4px;padding:2px 4px;cursor:pointer;max-width:110px;" title="Target OPR"></select>
        </div>
      </div>

      <!-- Call controls -->
      <div style="background:#f8fafc;padding:6px 12px;border-bottom:1px solid #cbd5e1;display:flex;align-items:center;justify-content:flex-end;gap:4px;">
        <button id="sds-call-voice" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;transition:background 0.2s;" title="CNCT (AUD)">📞 CNCT (AUD)</button>
        <button id="sds-call-video" style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;transition:background 0.2s;" title="CNCT (VID)">📹 CNCT (VID)</button>
        <select id="sds-autodelete" style="background:#ffffff;color:#2563eb;font-size:9px;font-weight:700;border:1px solid #cbd5e1;border-radius:4px;padding:2px 4px;cursor:pointer;" title="DLT pkgs after read">
          <option value="10">10 sec</option>
          <option value="30">30 sec</option>
          <option value="60">1 min</option>
          <option value="120">2 min</option>
          <option value="180">3 min</option>
          <option value="300">5 min</option>
        </select>
        <span id="sds-msg-count" style="font-size:9px;color:#64748b;font-family:monospace;margin-left:4px;">0 pkgs</span>
      </div>

      <!-- pkgs feed -->
      <div id="sds-feed" style="flex:1;padding:12px;overflow-y:auto;background:#ffffff;"></div>

      <!-- File preview -->
      <div id="sds-file-preview" style="display:none;padding:6px 12px;background:#f1f5f9;border-top:1px solid #cbd5e1;align-items:center;justify-content:space-between;"></div>

      <!-- Emoji Picker -->
      <div id="sds-emoji-picker" style="display:none;background:#f1f5f9;border-top:1px solid #cbd5e1;padding:8px;"></div>

      <!-- Input bar -->
      <div id="sds-input-bar" style="padding:10px;background:#f1f5f9;border-top:1px solid #cbd5e1;display:flex;align-items:center;gap:8px;">
        <button id="sds-emoji-btn" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;padding:4px;" title="Emoji">😊</button>
        <button id="sds-attach-btn" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;padding:4px;" title="Attach file">📎</button>
        <input type="file" id="sds-file-input" style="display:none;">
        <input type="text" id="sds-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="ENC pkg..." style="flex:1;font-size:12px;background:#ffffff;color:#1e293b;border:1px solid #cbd5e1;border-radius:12px;padding:8px 12px;outline:none;font-family:'Plus Jakarta Sans',system-ui,sans-serif;" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#cbd5e1'">
        <button id="sds-send-btn" style="background:linear-gradient(135deg,#3b82f6,#60a5fa);color:#fff;border:none;border-radius:12px;padding:8px 12px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(59,130,246,0.3);" title="XMT">➤</button>
      </div>
    `;
    document.body.appendChild(container);

    // Event listeners
    document.getElementById('sds-close-btn').onclick = () => togglePkg(false);
    document.getElementById('sds-min-btn').onclick = () => togglePkg(false);
    document.getElementById('sds-send-btn').onclick = sendMessage;
    const repCancel = document.getElementById('sds-reply-cancel-btn'); if (repCancel) repCancel.onclick = cancelReply;
    document.getElementById('sds-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('sds-attach-btn').onclick = () => {
      document.getElementById('sds-file-input').click();
    };
    document.getElementById('sds-file-input').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { alert('File must be under 5 MB'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        attachedFile = { name: file.name, data: ev.target.result };
        updateFilePreview();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    // Call buttons (route by channel)
    document.getElementById('sds-call-voice').onclick = () =>
      channelMode === 'admins' ? initiateAdminCall('voice') : initiateCall('voice');
    document.getElementById('sds-call-video').onclick = () =>
      channelMode === 'admins' ? initiateAdminCall('video') : initiateCall('video');

    // Channel tabs
    document.getElementById('sds-ch-cross').onclick = () => setChannel('cross');
    document.getElementById('sds-ch-admins').onclick = () => setChannel('admins');

    // Target OPR selector
    document.getElementById('sds-target-admin').onchange = function() {
      targetAdmin = this.value;
    };

    // Auto-delete selector
    const autoDeleteSel = document.getElementById('sds-autodelete');
    if (autoDeleteSel) {
      autoDeleteSel.value = String(deleteAfterSeconds);
      autoDeleteSel.onchange = () => {
        deleteAfterSeconds = parseInt(autoDeleteSel.value, 10) || 0;
        saveAutoDeleteSetting();
        clearAutoDeleteTimers();
        firstSeenAt.clear();
        loadMessages();
      };
    }

    // Emoji picker
    const EMOJIS = ['😊','😂','🇱🇰','📚','❤️','👍','🔥','🎉','💡','🚀','🙏','😍','😎','✨','👏','⭐','😢','😤','🤔','💪','🤝','📎','✅','❌','⚡','🎯','💬','🔒','🛡️','👋','😁','🥳'];
    let emojiPickerOpen = false;
    const emojiPicker = document.getElementById('sds-emoji-picker');
    const emojiGrid = document.createElement('div');
    emojiGrid.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:2px;';
    EMOJIS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.style.cssText = 'background:none;border:none;font-size:20px;cursor:pointer;padding:4px;border-radius:6px;transition:background 0.15s;';
      btn.onmouseover = () => { btn.style.background = 'rgba(96,165,250,0.2)'; };
      btn.onmouseout = () => { btn.style.background = 'none'; };
      btn.onclick = () => {
        const input = document.getElementById('sds-input');
        if (input) input.value += emoji;
        input.focus();
      };
      emojiGrid.appendChild(btn);
    });
    if (emojiPicker) emojiPicker.appendChild(emojiGrid);

    document.getElementById('sds-emoji-btn').onclick = () => {
      emojiPickerOpen = !emojiPickerOpen;
      if (emojiPicker) emojiPicker.style.display = emojiPickerOpen ? 'block' : 'none';
    };
  }

  function togglePkg(forceState) {
    const container = document.getElementById('sds-container');
    const fab = document.getElementById('sds-fab');
    if (!container || !fab) return;

    pkgOpen = forceState !== undefined ? forceState : !pkgOpen;

    if (pkgOpen) {
      container.style.display = 'flex';
      fab.style.display = 'none';
      startPolling();
      checkUnicatOnlineStatus();
    } else {
      container.style.display = 'none';
      fab.style.display = 'flex';
      stopPolling();
    }
  }

  // ── Settings-page-only launcher visibility ──────────────────────
  function isSettingsViewActive() {
    const el = document.getElementById('view-settings');
    return !!(el && el.classList.contains('active-view'));
  }

  function updatePkgLauncherVisibility() {
    const fab = document.getElementById('sds-fab');
    if (fab) fab.style.display = 'none';
  }

  function initSettingsOnlyVisibility() {
    updatePkgLauncherVisibility();
    window.addEventListener('hashchange', updatePkgLauncherVisibility);
    // Fallback: catch direct class swaps that don't touch the hash
    const views = document.querySelectorAll('.app-view');
    if (views.length && 'MutationObserver' in window) {
      const observer = new MutationObserver(updatePkgLauncherVisibility);
      views.forEach(v => observer.observe(v, { attributes: true, attributeFilter: ['class'] }));
    }
  }

  // ── Channel switching ───────────────────────────────────────────
  function parseUsersArray(raw) {
    let result = raw;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (result.error) {
        console.error('[cross-site-pkg] Database/API error when loading users:', result.error);
      }
      if (Array.isArray(result.data)) {
        result = result.data;
      } else if (Array.isArray(result.users)) {
        result = result.users;
      } else if (Array.isArray(result.results)) {
        result = result.results;
      } else {
        console.warn('[cross-site-pkg] Unexpected users data structure, expected Array:', result);
        result = [];
      }
    }
    return Array.isArray(result) ? result : [];
  }

  function applyAdminsToSelect(rawUsers) {
    const sel = document.getElementById('sds-target-admin');
    if (!sel) return;
    const users = parseUsersArray(rawUsers);
    const admins = users.filter(u => u && u.role === 'admin' && u.username !== MY_USERNAME);
    const current = sel.value;
    sel.innerHTML = '<option value="">All OPRs</option>' + admins.map(u =>
      `<option value="${escapeHtml(u.username)}">${escapeHtml(u.username)}</option>`
    ).join('');
    if (admins.some(u => u.username === current)) sel.value = current;
    sel.style.display = (channelMode === 'admins' && admins.length > 0) ? 'inline-block' : 'none';
  }

  async function refreshAdminSelect() {
    const sel = document.getElementById('sds-target-admin');
    if (!sel) return;

    const authObj = window.auth || (typeof auth !== 'undefined' ? auth : null);

    // Fast-path: immediately populate from synchronous cache / localStorage to prevent flicker
    try {
      if (authObj && typeof authObj.getCachedUsers === 'function') {
        applyAdminsToSelect(authObj.getCachedUsers());
      } else {
        const local = JSON.parse(localStorage.getItem('payflowUsers') || '[]');
        if (Array.isArray(local) && local.length > 0) {
          applyAdminsToSelect(local);
        }
      }
    } catch (_) {}

    // Async-path: await auth.getUsers() to get live data from Firestore / database
    try {
      if (authObj && typeof authObj.getUsers === 'function') {
        const res = authObj.getUsers();
        const users = (res && typeof res.then === 'function') ? await res : res;
        applyAdminsToSelect(users);
      }
    } catch (e) {
      console.error('[cross-site-pkg] Failed to refresh admin select from auth.getUsers():', e);
    }
  }

  async function setChannel(mode) {
    channelMode = mode;
    targetAdmin = '';
    const sel = document.getElementById('sds-target-admin');
    if (sel) sel.value = '';
    const left = document.getElementById('sds-peer-left');
    const right = document.getElementById('sds-peer-right');
    const crossBtn = document.getElementById('sds-ch-cross');
    const adminsBtn = document.getElementById('sds-ch-admins');
    const input = document.getElementById('sds-input');
    const activeStyle = 'background:#1e3a8a;color:#fff;border:none;';
    const idleStyle = 'background:transparent;color:#94a3b8;border:1px solid #334155;';
    if (mode === 'admins') {
      if (left) left.textContent = 'OPRS';
      if (right) right.textContent = MY_USERNAME.toUpperCase();
      if (input) input.placeholder = 'PKG payroll OPRs...';
      if (crossBtn) crossBtn.style.cssText = idleStyle + 'border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;';
      if (adminsBtn) adminsBtn.style.cssText = activeStyle + 'border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;';
    } else {
      if (left) left.textContent = 'PAYROLL';
      if (right) right.textContent = 'XST';
      if (input) input.placeholder = 'Message...';
      if (crossBtn) crossBtn.style.cssText = activeStyle + 'border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;';
      if (adminsBtn) adminsBtn.style.cssText = idleStyle + 'border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;';
    }
    clearAutoDeleteTimers();
    const feed = document.getElementById('sds-feed');
    if (feed) feed.innerHTML = '';
    messages = [];
    await refreshAdminSelect();
    loadMessages();
  }

  // ── Polling ──────────────────────────────────────────────────────
  async function loadMessages() {
    const fetched = await firestoreFetchMessages();
    if (fetched === null) {
      // Do not wipe or reset messages if fetch failed due to network or quota limit
      return;
    }
    const fetchedIds = new Set(fetched.map(m => m.id));
    for (const id of Array.from(firstSeenAt.keys())) {
      if (!fetchedIds.has(id)) firstSeenAt.delete(id);
    }
    const fetchedFiltered = fetched.filter(m => {
      const isCross = (m.channel === 'cross' || m.senderSite === 'unicat' || m.recipient === 'payroll' || m.recipient === 'unicat');
      if (channelMode === 'cross') {
        return isCross;
      } else {
        if (isCross) return false;
        return m.senderSite === SITE_ID && (m.recipient === '' || m.recipient === MY_USERNAME || m.senderAdmin === MY_USERNAME);
      }
    });

    // Retain locally sent messages created within the last 2 minutes that haven't arrived from server yet
    const serverIds = new Set(fetchedFiltered.map(m => m.id));
    const now = Date.now();
    const pendingLocal = messages.filter(m => !serverIds.has(m.id) && (now - new Date(m.createdAt).getTime()) < 120000);
    messages = [...fetchedFiltered, ...pendingLocal];

    renderMessages();
    messages.forEach(scheduleAutoDelete);
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' pkgs';
    if (channelMode === 'admins') await refreshAdminSelect();
    checkUnicatOnlineStatus();
  }

  function formatRelativeTime(ms) {
    if (!ms || isNaN(ms) || ms <= 0) return 'Offline';
    const diff = Date.now() - ms;
    if (diff < 0) return 'Just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 20) return 'Just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function checkUnicatOnlineStatus() {
    try {
      const resp = await fetch(`${FIRESTORE_BASE}/crossSiteStatus/unicat`);
      const data = await resp.json();
      const dot = document.getElementById('sds-unicat-status-dot');
      const text = document.getElementById('sds-unicat-status-text');
      const badge = document.getElementById('sds-unicat-status-badge');
      if (!dot) return;

      const lastSeen = parseInt(data?.fields?.lastSeen?.integerValue || '0', 10);
      const isOnline = lastSeen && (Date.now() - lastSeen < 20000);

      if (isOnline) {
        dot.style.background = '#22c55e';
        dot.style.boxShadow = '0 0 6px #22c55e';
        if (text) {
          text.textContent = 'Active';
          text.style.color = '#15803d';
        }
        if (badge) badge.title = 'Active now';
      } else {
        dot.style.background = '#94a3b8';
        dot.style.boxShadow = 'none';
        const ago = formatRelativeTime(lastSeen);
        if (text) {
          text.textContent = ago;
          text.style.color = '#64748b';
        }
        let fullTime = '';
        try {
          if (lastSeen) fullTime = ` (${new Date(lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
        } catch (e) {}
        if (badge) badge.title = lastSeen ? `Last active ${ago}${fullTime}` : 'Offline';
      }
    } catch (e) {}
  }

  function sendPayrollHeartbeat() {
    fetch(`${FIRESTORE_BASE}/crossSiteStatus/payroll?updateMask.fieldPaths=lastSeen&updateMask.fieldPaths=activeAdmin&updateMask.fieldPaths=peerId`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          lastSeen: { integerValue: String(Date.now()) },
          activeAdmin: { stringValue: MY_USERNAME },
          peerId: { stringValue: (peers.cross && peers.cross.open) ? 'payroll-peer-admin' : (peers.admin?.id || 'payroll-peer-admin') },
        },
      }),
    }).catch(() => {});
  }

  function startPolling() {
    loadMessages();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(loadMessages, 5000);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    let u = null;
    try {
      u = (window.auth && typeof auth.getCurrentUser === 'function') ? auth.getCurrentUser() : null;
      if (!u) {
        const legacy = JSON.parse(localStorage.getItem('payflowToken') || localStorage.getItem('hr_current_user') || 'null');
        if (legacy && legacy.username) u = legacy;
      }
    } catch (e) {}

    // Strict Admin Guard: Only users with role === 'admin' or username === 'admin' have SVS enabled
    const isAdmin = u && (u.role === 'admin' || u.username === 'admin');
    if (!isAdmin) {
      window.SDS = {
        openPkg: function() {},
        call: function() {},
      };
      return;
    }

    if (u && u.username) {
      MY_USERNAME = u.username;
      ADMIN_NAME = u.username;
    }

    loadAutoDeleteSetting();

    injectStyles();
    buildUI();
    setChannel('admins');

    const label = document.getElementById('sds-admin-label');
    if (label) label.textContent = ADMIN_NAME;

    // Launcher (🛡️) only shows on the Settings page
    initSettingsOnlyVisibility();

    // Public API for the Settings page (OPR-to-OPR PKG/CNCT)
    window.SDS = {
      openPkg: function (channel, target) {
        setChannel(channel === 'cross' ? 'cross' : 'admins');
        if (target) {
          targetAdmin = target;
          const sel = document.getElementById('sds-target-admin');
          if (sel) sel.value = target;
        }
        togglePkg(true);
      },
      call: function (target, type) {
        setChannel('admins');
        targetAdmin = target || '';
        const sel = document.getElementById('sds-target-admin');
        if (sel && target) sel.value = target;
        togglePkg(true);
        initiateAdminCall(type || 'voice');
      },
    };

    // Initialize PeerJS for voice/video calls
    initPeerJS();

    // Send heartbeat so Unicat knows Payroll is online
    sendPayrollHeartbeat();
    setInterval(sendPayrollHeartbeat, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
