// SVS Service - Internal Communication Module
// Runtime synchronization bridge for cross-platform admin coordination (Payroll <-> Unicat)
(function() {
  'use strict';

  const SITE_ID = 'payroll';
  let ADMIN_NAME = 'Payroll OPR';
  let MY_USERNAME = 'admin';
  // Channel: 'cross' = Unicat <-> Payroll | 'admins' = OPR-to-OPR inside payroll
  let channelMode = 'admins';
  let targetAdmin = ''; // '' = all payroll admins
  let pkgOpen = false;
  let hideFabAfterCrossSend = false;
  const fabHiddenStorageKey = () => `sds_hide_fab_after_cross_send_${MY_USERNAME}`;
  let messages = [];
  let pollInterval = null;
  let attachedFile = null;
  let cachedUnicatPeerId = 'unicat-peer-admin';

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
      if (userEl) userEl.textContent = 'Replying to ' + replyingTo.sender;
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
  let incomingCallData = null; // { mediaCall, callerPeerId, callerLabel, callType }
  let callDuration = 0;
  let callTimer = null;
  let isMuted = false;
  let isVideoOff = false;

  // Supabase cross-site message storage
  function getSupabaseClient() {
    if (!window.supabaseClient || !window.isSupabaseConfigured || !window.isSupabaseConfigured()) {
      throw new Error('Supabase is not configured. Check the payroll Supabase settings.');
    }
    return window.supabaseClient;
  }

  async function supabaseAddMessage(msg) {
    const { error } = await getSupabaseClient().from('cross_site_chat').upsert({
      id:              msg.id,
      sender_site:     msg.senderSite,
      sender_admin:    msg.senderAdmin,
      channel:         msg.channel || 'cross',
      recipient:       msg.recipient || '',
      reply_to_id:     msg.replyToId || '',
      reply_to_sender: msg.replyToSender || '',
      reply_to_text:   msg.replyToText || '',
      content:         msg.content || '',
      file_name:       msg.fileName || '',
      file_data:       msg.fileData || '',
      timer_sec:       msg.timerSec || 60,
      read_at:         '',
      created_at:      msg.createdAt || new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) throw error;
  }

  // Strict Privacy: In-Memory Only
  try {
    localStorage.removeItem('sds_messages_store');
    localStorage.removeItem('sds_messages_cache');
  } catch (e) {}

  function filterMessagesForChannel(all, mode) {
    return all.filter(m => {
      const isCross = (m.channel === 'cross' || m.senderSite === 'unicat' || m.recipient === 'payroll' || m.recipient === 'unicat');
      if (mode === 'cross') {
        return isCross;
      } else {
        if (isCross) return false;
        return m.senderSite === SITE_ID && (m.recipient === '' || m.recipient === MY_USERNAME || m.senderAdmin === MY_USERNAME);
      }
    });
  }

  // Auto-delete (disappearing messages)
  let deleteAfterSeconds = 60; // 60s = default auto-delete
  const firstSeenAt = new Map();
  const deleteTimers = new Map();

  function loadAutoDeleteSetting() {
    try {
      deleteAfterSeconds = parseInt(localStorage.getItem('sds_autodelete') || '60', 10) || 60;
    } catch (e) {
      deleteAfterSeconds = 60;
    }
  }

  function saveAutoDeleteSetting() {
    try { localStorage.setItem('sds_autodelete', String(deleteAfterSeconds)); } catch (e) {}
  }

  function clearAutoDeleteTimers() {
    deleteTimers.forEach((t) => clearTimeout(t));
    deleteTimers.clear();
  }

  async function supabaseDeleteMessage(id) {
    const { error } = await getSupabaseClient().from('cross_site_chat').delete().eq('id', id);
    if (error) throw error;
  }

  async function removeMessage(msg, askConfirm) {
    if (askConfirm && !confirm('Delete this message for both sites?')) return;
    try {
      await supabaseDeleteMessage(msg.id);
    } catch (err) {
      console.error('[SDS] Supabase delete failed:', err);
      if (askConfirm) alert('Message could not be deleted. Check the connection and try again.');
      return;
    }
    const timer = deleteTimers.get(msg.id);
    if (timer) { clearTimeout(timer); deleteTimers.delete(msg.id); }
    firstSeenAt.delete(msg.id);
    messages = messages.filter((m) => m.id !== msg.id);
    renderMessages();
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' msgs';
  }

  async function markMessageAsRead(msgId) {
    const { error } = await getSupabaseClient()
      .from('cross_site_chat')
      .update({ read_at: new Date().toISOString() })
      .eq('id', msgId);
    if (error) throw error;
  }

  function scheduleAutoDelete(msg) {
    const isSender = (channelMode === 'cross') ? (msg.senderSite === SITE_ID) : (msg.senderAdmin === MY_USERNAME);
    const durationSec = msg.timerSec || deleteAfterSeconds || 60;

    // Sender side auto-delete logic:
    if (isSender) {
      if (deleteTimers.has(msg.id)) return;
      if (msg.readAt) {
        // Seen by receiver: countdown from when it was seen!
        const readTime = new Date(msg.readAt).getTime() || Date.now();
        const elapsed = (Date.now() - readTime) / 1000;
        const remaining = (durationSec - elapsed) * 1000;
        const timer = setTimeout(() => removeMessage(msg, false), Math.max(remaining, 500));
        deleteTimers.set(msg.id, timer);
      }
      return;
    }

    // Receiver side:
    const isViewing = pkgOpen && (typeof document === 'undefined' || !document.hidden);
    if (!isViewing) {
      return;
    }

    if (!msg.readAt && channelMode === 'cross') {
      markMessageAsRead(msg.id).catch(err => console.error('[SDS] Supabase read receipt failed:', err));
      msg.readAt = new Date().toISOString();
    }

    if (deleteTimers.has(msg.id)) return;
    const now = Date.now();
    let first = firstSeenAt.get(msg.id);
    if (!first) {
      first = now;
      firstSeenAt.set(msg.id, first);
    }
    const elapsed = (now - first) / 1000;
    const remaining = (durationSec - elapsed) * 1000;
    const timer = setTimeout(() => removeMessage(msg, false), Math.max(remaining, 500));
    deleteTimers.set(msg.id, timer);
  }

  async function supabaseFetchMessages() {
    const { data, error } = await getSupabaseClient()
      .from('cross_site_chat')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    return data.reverse().map(row => ({
      id:            row.id,
      senderSite:    row.sender_site,
      senderAdmin:   row.sender_admin,
      channel:       row.channel,
      recipient:     row.recipient,
      replyToId:     row.reply_to_id,
      replyToSender: row.reply_to_sender,
      replyToText:   row.reply_to_text,
      content:       row.content,
      fileName:      row.file_name,
      fileData:      row.file_data,
      createdAt:     row.created_at,
      timerSec:      row.timer_sec,
      readAt:        row.read_at,
    }));
  }

  // Helpers
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

  function linkifyText(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const urlPattern = /(https?:\/\/[^\s<]+)/g;
    return escaped.replace(urlPattern, url => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;word-break:break-all;font-weight:600;">${url}</a>`;
    });
  }

  function openImageLightbox(src, name) {
    const existing = document.getElementById('sds-image-lightbox');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'sds-image-lightbox';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.92);backdrop-filter:blur(6px);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;animation:sdsIn 0.2s;';

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'position:absolute;top:16px;left:16px;right:16px;display:flex;align-items:center;justify-content:space-between;color:#fff;font-family:sans-serif;font-size:13px;font-weight:600;z-index:1000000;';
    toolbar.innerHTML = `
      <span style="max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2e8f0;">${escapeHtml(name || 'Photo')}</span>
      <button id="sds-lightbox-close" style="background:rgba(255,255,255,0.2);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;" title="Close">✕</button>
    `;
    overlay.appendChild(toolbar);

    const img = document.createElement('img');
    img.src = src;
    img.alt = name || 'Photo';
    img.setAttribute('draggable', 'false');
    img.oncontextmenu = (e) => e.preventDefault();
    img.style.cssText = 'max-width:92vw;max-height:85vh;object-fit:contain;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);cursor:default;user-select:none;-webkit-user-select:none;';
    img.onclick = (e) => e.stopPropagation();
    overlay.appendChild(img);

    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);

    const closeBtn = document.getElementById('sds-lightbox-close');
    if (closeBtn) closeBtn.onclick = () => overlay.remove();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  // Render messages
  function createMessageElement(msg, isNew) {
    const isMe = (channelMode === 'cross') ? (msg.senderSite === SITE_ID) : (msg.senderAdmin === MY_USERNAME);
    const wrapper = document.createElement('div');
    wrapper.id = 'sds-msg-' + msg.id;
    wrapper.className = 'sds-msg-wrapper';
    wrapper.setAttribute('data-msg-id', msg.id);
    wrapper.style.cssText = `display:flex;flex-direction:column;${isMe ? 'align-items:flex-end' : 'align-items:flex-start'};margin-bottom:10px;${isNew ? 'animation:sdsIn 0.2s;' : ''}`;

    const isSeen = !!msg.readAt;

    const bubble = document.createElement('div');
    bubble.className = 'sds-msg-bubble';
    bubble.style.cssText = isMe
      ? 'max-width:85%;padding:9px 12px;border-radius:14px;font-size:12px;word-wrap:break-word;background:#2563eb;color:#ffffff;border-bottom-right-radius:4px;box-shadow:0 1px 4px rgba(37,99,235,0.25);'
      : 'max-width:85%;padding:9px 12px;border-radius:14px;font-size:12px;word-wrap:break-word;background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.06);';

    // File/Image attachment
    if (msg.fileName && msg.fileData) {
      if (isImageFile(msg.fileName)) {
        const img = document.createElement('img');
        img.src = msg.fileData;
        img.alt = msg.fileName;
        img.title = 'Click to enlarge photo';
        img.setAttribute('draggable', 'false');
        img.oncontextmenu = (e) => e.preventDefault();
        img.style.cssText = 'width:100%;max-height:180px;object-fit:cover;border-radius:8px;margin-bottom:6px;cursor:pointer;user-select:none;-webkit-user-select:none;';
        img.onclick = (e) => {
          e.stopPropagation();
          openImageLightbox(msg.fileData, msg.fileName);
        };
        bubble.appendChild(img);
      } else {
        const fileBtn = document.createElement('div');
        fileBtn.style.cssText = `display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;font-size:10px;font-weight:700;margin-bottom:6px;width:100%;${isMe ? 'background:rgba(255,255,255,0.2);color:#ffffff;' : 'background:rgba(96,165,250,0.15);color:#1d4ed8;'}`;
        fileBtn.innerHTML = `📎 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left;">${escapeHtml(msg.fileName)}</span>`;
        bubble.appendChild(fileBtn);
      }
    }

    // Reply Quote
    if (msg.replyToText) {
      const quote = document.createElement('div');
      quote.style.cssText = isMe
        ? 'font-size:10px;padding:3px 8px;border-left:3px solid #93c5fd;background:rgba(255,255,255,0.18);color:#dbeafe;margin-bottom:4px;border-radius:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        : 'font-size:10px;padding:3px 8px;border-left:3px solid #3b82f6;background:rgba(59,130,246,0.1);color:#475569;margin-bottom:4px;border-radius:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      quote.innerHTML = `<span style="font-weight:700;">Ref:</span> ${escapeHtml(msg.replyToText)}`;
      bubble.insertBefore(quote, bubble.firstChild);
    }

    // Text content
    if (msg.content) {
      const p = document.createElement('p');
      p.style.cssText = 'margin:0;line-height:1.45;white-space:pre-wrap;word-break:break-word;';
      p.innerHTML = linkifyText(msg.content);
      bubble.appendChild(p);
    }

    wrapper.appendChild(bubble);

    // Meta row (time, seen/sent, actions)
    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;padding:0 4px;font-size:9px;color:#64748b;';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatTime(msg.createdAt);
    metaRow.appendChild(timeSpan);

    if (isMe) {
      const statusBadge = document.createElement('span');
      statusBadge.className = 'sds-msg-status';
      statusBadge.style.cssText = isSeen ? 'color:#2563eb;font-weight:700;' : 'color:#94a3b8;font-weight:600;';
      statusBadge.textContent = isSeen ? '✓✓ Seen' : '✓✓ Sent';
      metaRow.appendChild(statusBadge);
    }

    if (!isMe) {
      const replyBtn = document.createElement('button');
      replyBtn.textContent = '↩';
      replyBtn.title = 'Reply with reference';
      replyBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;color:#64748b;opacity:0.7;';
      replyBtn.onmouseover = () => { replyBtn.style.opacity = '1'; };
      replyBtn.onmouseout = () => { replyBtn.style.opacity = '0.7'; };
      replyBtn.onclick = () => setReplyTo(msg);
      metaRow.appendChild(replyBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete message (both sites)';
    delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:10px;padding:0 2px;color:#64748b;opacity:0.7;';
    delBtn.onmouseover = () => { delBtn.style.opacity = '1'; };
    delBtn.onmouseout = () => { delBtn.style.opacity = '0.7'; };
    delBtn.onclick = () => removeMessage(msg, true);
    metaRow.appendChild(delBtn);

    wrapper.appendChild(metaRow);

    return wrapper;
  }

  function renderMessages(forceScroll) {
    const feed = document.getElementById('sds-feed');
    if (!feed) return;

    const visibleMessages = channelMode === 'cross'
      ? messages.filter(msg => !(msg.senderSite === SITE_ID && msg.senderAdmin === MY_USERNAME))
      : messages;

    if (visibleMessages.length === 0) {
      feed.innerHTML = `
        <div class="sds-empty-feed" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-size:11px;text-align:center;padding:20px;">
          <div style="font-size:28px;margin-bottom:8px;">💬</div>
          <div><b>${messages.length ? 'Your sent messages are hidden' : 'No messages yet'}</b></div>
          ${messages.length ? '' : `<div style="font-size:10px;margin-top:4px;color:#cbd5e1;">Messages sent here sync with ${channelMode === 'cross' ? 'Unicat' : 'Payroll admins'}.</div>`}
        </div>`;
      return;
    }

    const empty = feed.querySelector('.sds-empty-feed');
    if (empty) empty.remove();

    const isFirstRender = feed.querySelectorAll('.sds-msg-wrapper').length === 0;
    const isNearBottom = (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 100;

    // Remove nodes that were deleted
    const currentIds = new Set(visibleMessages.map(m => m.id));
    const existingNodes = feed.querySelectorAll('.sds-msg-wrapper');
    existingNodes.forEach(node => {
      const id = node.getAttribute('data-msg-id');
      if (!currentIds.has(id)) {
        node.remove();
      }
    });

    // Append only new messages without destroying existing ones
    let hasNew = false;
    visibleMessages.forEach(msg => {
      let existing = document.getElementById('sds-msg-' + msg.id);
      if (existing) {
        const isRead = !!msg.readAt;
        const statusEl = existing.querySelector('.sds-msg-status');
        if (statusEl) {
          statusEl.textContent = isRead ? '✓✓ Seen' : '✓✓ Sent';
          statusEl.style.color = isRead ? '#2563eb' : '#94a3b8';
          statusEl.style.fontWeight = isRead ? '700' : '600';
        }
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

  // Send message
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

    try {
      await supabaseAddMessage(msg);
    } catch (err) {
      console.error('[SDS] Supabase send failed:', err);
      alert('Message could not be saved. Check the connection and try again.');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = '1'; }
      return;
    }

    messages.push(msg);
    if (channelMode === 'cross') {
      hideCrossSiteLauncherForSender();
    }
    if (input) input.value = '';
    attachedFile = null;
    cancelReply();
    updateFilePreview();
    renderMessages(true);
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' msgs';

    // Broadcast over P2P DataChannel if peer connection is active
    sendPeerMessage(msg);

    if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = '1'; }
  }

  function updateFilePreview() {
    const preview = document.getElementById('sds-file-preview');
    if (!preview) return;
    if (attachedFile) {
      preview.style.display = 'flex';
      preview.innerHTML = `
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:#2563eb;">
          📎 <b style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(attachedFile.name)}</b>
        </span>
        <button id="sds-file-remove" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0 4px;">✕</button>`;
      document.getElementById('sds-file-remove').onclick = () => {
        attachedFile = null;
        updateFilePreview();
      };
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  }

  function sendPeerMessage(msg) {
    try {
      const targetPeerId = (channelMode === 'cross')
        ? (cachedUnicatPeerId || 'unicat-peer-admin')
        : (targetAdmin ? `payroll-peer-${targetAdmin}` : null);

      const activePeer = (channelMode === 'cross') ? peers.cross : peers.admin;
      if (activePeer && activePeer.open && targetPeerId) {
        const conn = activePeer.connect(targetPeerId);
        conn.on('open', () => {
          conn.send({ type: 'msg', msg: msg });
          setTimeout(() => conn.close(), 1500);
        });
      }
    } catch (e) {
      console.warn('[SDS] P2P data send failed (fallback to Supabase):', e);
    }
  }

  function handleIncomingPeerMsg(msg) {
    if (!msg || !msg.id) return;
    const isForCurrentChannel = (channelMode === 'cross')
      ? (msg.channel === 'cross' || msg.senderSite === 'unicat' || msg.recipient === 'payroll' || msg.recipient === 'unicat')
      : (msg.senderSite === SITE_ID && (msg.recipient === '' || msg.recipient === MY_USERNAME || msg.senderAdmin === MY_USERNAME));

    if (isForCurrentChannel) {
      if (!messages.some(m => m.id === msg.id)) {
        messages.push(msg);
        renderMessages();
        scheduleAutoDelete(msg);
        const countEl = document.getElementById('sds-msg-count');
        if (countEl) countEl.textContent = messages.length + ' msgs';
      }
    }
  }

  // PeerJS WebRTC Calling
  const PEER_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ];

  function createPeer(peerId) {
    return new Peer(peerId, { config: { iceServers: PEER_ICE_SERVERS } });
  }

  function peerCallHandler(mediaCall) {
    console.log('[SDS] Incoming call from:', mediaCall.peer);
    const callerId = mediaCall.peer || '';
    const callerLabel = callerId.replace(/^(unicat|payroll)-peer-/, '')
      || (callerId.indexOf('unicat') === 0 ? 'Unicat Member' : 'Admin');
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
      p.on('connection', (conn) => {
        conn.on('data', (data) => {
          if (data && data.type === 'msg' && data.msg) handleIncomingPeerMsg(data.msg);
        });
      });
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
      p.on('connection', (conn) => {
        conn.on('data', (data) => {
          if (data && data.type === 'msg' && data.msg) handleIncomingPeerMsg(data.msg);
        });
      });
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
    const existing = document.getElementById('sds-incoming-call');
    if (existing) existing.remove();

    const callType = incomingCallData?.callType || 'voice';
    const isVideo = callType === 'video';
    const banner = document.createElement('div');
    banner.id = 'sds-incoming-call';
    banner.style.cssText = 'background:linear-gradient(135deg,#fef2f2,#fff1f2);color:#1e293b;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #ef4444;animation:sdsIn 0.3s;box-shadow:0 2px 10px rgba(0,0,0,0.08);';
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:34px;height:34px;background:#ef4444;color:#ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;animation:sdsPulse 1s infinite;">${isVideo ? '📹' : '📞'}</div>
        <div>
          <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#dc2626;letter-spacing:1px;">Incoming ${callType.toUpperCase()} Call</div>
          <div style="font-size:12px;font-weight:700;color:#0f172a;">${escapeHtml(incomingCallData?.callerLabel || 'Unicat User')} is calling...</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="sds-answer-btn" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(22,163,74,0.3);display:flex;align-items:center;gap:4px;">✓ Answer</button>
        <button id="sds-decline-btn" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(220,38,38,0.3);display:flex;align-items:center;gap:4px;">✕ Decline</button>
      </div>
    `;

    if (!pkgOpen) togglePkg(true);

    const container = document.getElementById('sds-container');
    const feed = document.getElementById('sds-feed');
    if (container && feed) {
      container.insertBefore(banner, feed);
    }

    const ansBtn = document.getElementById('sds-answer-btn');
    if (ansBtn) ansBtn.onclick = () => answerCall();
    const decBtn = document.getElementById('sds-decline-btn');
    if (decBtn) decBtn.onclick = () => declineCall();
  }

  // Animated avatar canvas generator for reliable video call transmission (handles single-PC webcam lock)
  function createAvatarVideoStream(label) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    let frame = 0;

    const render = () => {
      if (!ctx) return;
      frame++;
      const grad = ctx.createLinearGradient(0, 0, 640, 480);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#1e3a8a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 480);

      const pulse = Math.sin(frame * 0.08) * 12;
      ctx.beginPath();
      ctx.arc(320, 210, 80 + pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(217, 119, 6, 0.15)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(320, 210, 72, 0, Math.PI * 2);
      ctx.fillStyle = '#b45309';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#f59e0b';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initial = (label || 'P')[0].toUpperCase();
      ctx.fillText(initial, 320, 210);

      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(label || 'Payroll Admin', 320, 320);

      ctx.font = '11px monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('LIVE STREAM FEED ACTIVE', 320, 345);

      ctx.beginPath();
      ctx.arc(220, 342, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
    };

    const interval = setInterval(render, 1000 / 15);
    render();

    const canvasStream = canvas.captureStream ? canvas.captureStream(15) : canvas.mozCaptureStream(15);
    const track = canvasStream.getVideoTracks()[0];
    if (track) {
      const origStop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(interval);
        origStop();
      };
    }
    return canvasStream;
  }

  async function getPayrollMediaStream(wantVideo) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Camera and microphone access requires HTTPS or localhost.');
      error.name = 'SecurityError';
      throw error;
    }

    if (wantVideo) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: 'user' } },
        });
        if (stream.getVideoTracks().length > 0) return { stream, hasVideo: true, isSynthetic: false };
      } catch (e1) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          if (stream.getVideoTracks().length > 0) return { stream, hasVideo: true, isSynthetic: false };
        } catch (e2) {
          console.warn('[SDS] Physical camera unavailable or locked. Initializing avatar stream.');
        }
      }

      // Fallback: camera unavailable / locked (e.g. single PC testing with Unicat)
      // Acquire audio and synthesize animated avatar video track so video call connects cleanly!
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const avatarStream = createAvatarVideoStream(ADMIN_NAME || 'Payroll Admin');
      const combined = new MediaStream([...audioStream.getAudioTracks(), ...avatarStream.getVideoTracks()]);
      return { stream: combined, hasVideo: true, isSynthetic: true };
    }

    // Audio only
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return { stream, hasVideo: false, isSynthetic: false };
  }

  function handleMediaError(err, wantVideo = false) {
    console.error('[SDS Media Error]', err);
    if (!navigator.mediaDevices?.getUserMedia || err?.name === 'SecurityError') {
      alert('Camera and microphone access requires a secure page (HTTPS or http://localhost).');
      return;
    }
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      alert(`${wantVideo ? 'Camera or microphone' : 'Microphone'} access is blocked.\nPlease allow access in your browser site settings.`);
      return;
    }
    if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
      alert(wantVideo
        ? 'No camera or microphone found. Connect a microphone or headset and try again.'
        : 'No microphone detected. Connect a microphone or headset, then try again.');
      return;
    }
    alert(`${wantVideo ? 'Camera/microphone' : 'Microphone'} error (${err?.name || 'Error'}): ${err?.message || 'Check device permissions and try again.'}`);
  }

  async function answerCall() {
    if (!incomingCallData) return;
    const { mediaCall, callType } = incomingCallData;

    try {
      const res = await getPayrollMediaStream(callType === 'video');
      localStream = res.stream;
      activeCallType = callType;
      isVideoOff = !res.hasVideo;
      activeCallConnection = mediaCall;

      // ATTACH LISTENERS BEFORE ANSWERING
      mediaCall.on('stream', (remStream) => {
        remoteStream = remStream;
        updateActiveCallMedia();
      });

      mediaCall.on('close', () => endCall());
      mediaCall.on('error', (err) => {
        console.warn('[SDS] Call connection error:', err);
        endCall();
      });

      mediaCall.answer(res.stream);

      // Remove incoming call banner
      const banner = document.getElementById('sds-incoming-call');
      if (banner) banner.remove();
      incomingCallData = null;

      showActiveCallUI();
    } catch (err) {
      handleMediaError(err, callType === 'video');
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

    let res;
    try {
      res = await getPayrollMediaStream(type === 'video');
    } catch (err) {
      handleMediaError(err, type === 'video');
      return;
    }

    localStream = res.stream;
    activeCallType = type;
    isVideoOff = !res.hasVideo;

    let targetPeerId = 'unicat-peer-admin';
    let isRemoteOnline = false;
    try {
      const { data, error } = await getSupabaseClient()
        .from('cross_site_status')
        .select('last_seen, peer_id')
        .eq('site', 'unicat')
        .maybeSingle();
      if (error) throw error;
      if (data?.peer_id) {
        targetPeerId = data.peer_id;
        cachedUnicatPeerId = data.peer_id;
      }
      const lastSeen = Number(data?.last_seen || 0);
      isRemoteOnline = lastSeen && (Date.now() - lastSeen < 60000);
    } catch (err) {
      console.error('[SDS] Supabase Unicat presence lookup failed:', err);
    }

    if (!isRemoteOnline) {
      console.warn('[SDS] Unicat peer may be offline (last_seen stale). Proceeding with call anyway.');
    }

    const peerErrorHandler = (err) => {
      console.warn('[SDS Call Peer Error]', err);
      if (err.type === 'peer-unavailable') {
        endCall();
        alert('Call failed: Remote peer is not currently online or has not opened their chat panel.');
      }
    };
    callerPeer.on('error', peerErrorHandler);

    const mediaCall = callerPeer.call(targetPeerId, res.stream, { metadata: { callType: type } });
    activeCallConnection = mediaCall;

    mediaCall.on('stream', (remStream) => {
      remoteStream = remStream;
      updateActiveCallMedia();
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
      const res = await getPayrollMediaStream(type === 'video');
      localStream = res.stream;
      activeCallType = type;
      isVideoOff = !res.hasVideo;

      const targetPeerId = `payroll-peer-${targetAdmin}`;
      const mediaCall = callerPeer.call(targetPeerId, res.stream, { metadata: { callType: type } });
      activeCallConnection = mediaCall;

      mediaCall.on('stream', (remStream) => {
        remoteStream = remStream;
        updateActiveCallMedia();
      });

      mediaCall.on('close', () => endCall());
      mediaCall.on('error', () => {
        endCall();
        alert(`Call failed - ${targetAdmin} may be offline`);
      });

      showActiveCallUI();
    } catch (err) {
      handleMediaError(err, type === 'video');
    }
  }

  function updateActiveCallMedia() {
    // 1. Audio playback (handles remote audio cleanly for all calls)
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
      audioEl.play().catch(() => {});
    }

    // 2. Video elements
    if (activeCallType === 'video') {
      const localVideo = document.getElementById('sds-local-video');
      const remoteVideo = document.getElementById('sds-remote-video');
      if (localVideo && localStream && localVideo.srcObject !== localStream) {
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
      }
      if (remoteVideo && remoteStream && remoteVideo.srcObject !== remoteStream) {
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(() => {});
      }
    }
  }

  function showActiveCallUI() {
    const feed = document.getElementById('sds-feed');
    const inputBar = document.getElementById('sds-input-bar');

    let callOverlay = document.getElementById('sds-call-overlay');
    if (!callOverlay) {
      callOverlay = document.createElement('div');
      callOverlay.id = 'sds-call-overlay';
      callOverlay.style.cssText = 'flex:1;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:16px;position:relative;color:#ffffff;';

      const container = document.getElementById('sds-container');
      if (container && feed) {
        container.insertBefore(callOverlay, feed);
      }
    }

    if (feed) feed.style.display = 'none';
    if (inputBar) inputBar.style.display = 'none';

    if (!callTimer) {
      callDuration = 0;
      callTimer = setInterval(() => {
        callDuration++;
        const timerEl = document.getElementById('sds-call-timer');
        if (timerEl) timerEl.textContent = formatDuration(callDuration);
      }, 1000);
    }

    callOverlay.innerHTML = `
      <div style="text-align:center;margin-top:4px;">
        <span style="font-size:9px;background:rgba(34,197,94,0.2);color:#22c55e;font-weight:700;padding:2px 10px;border-radius:4px;border:1px solid rgba(34,197,94,0.4);text-transform:uppercase;letter-spacing:1.5px;">
          ${activeCallType === 'voice' ? 'AUDIO CALL ACTIVE' : 'VIDEO CALL ACTIVE'}
        </span>
        <p style="font-size:11px;color:#94a3b8;margin-top:6px;margin-bottom:2px;">
          Connected: <strong style="color:#f59e0b;font-family:monospace;">${escapeHtml(channelMode === 'admins' ? (targetAdmin || 'Admin') : 'Unicat System')}</strong>
        </p>
        <p id="sds-call-timer" style="font-size:22px;font-weight:700;color:#f59e0b;font-family:monospace;margin:2px 0 0 0;">${formatDuration(callDuration)}</p>
      </div>

      <!-- Video / Audio container -->
      <div style="width:100%;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#020617;border-radius:12px;border:1px solid #1e293b;overflow:hidden;position:relative;margin:12px 0;min-height:220px;">
        ${activeCallType === 'video' ? `
          <video id="sds-remote-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;"></video>
          <div style="position:absolute;bottom:8px;right:8px;width:80px;height:104px;background:#0f172a;border-radius:8px;border:1px solid #475569;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <video id="sds-local-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;transform:scaleX(-1);"></video>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="width:68px;height:68px;border-radius:50%;background:#1e3a8a;border:3px solid #3b82f6;display:flex;align-items:center;justify-content:center;font-size:30px;margin-bottom:12px;animation:sdsPulse 2s infinite;">📞</div>
            <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:8px;">Audio Call In Progress</div>
            <div style="display:flex;align-items:center;gap:3px;height:24px;">
              ${[40,70,30,90,60,80,40].map(h => `<span style="width:3px;height:${h}%;background:#38bdf8;border-radius:2px;animation:sdsPulse ${1 + Math.random()}s infinite;"></span>`).join('')}
            </div>
          </div>
        `}
      </div>

      <!-- Call controls -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
        <button id="sds-mute-btn" style="width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;background:#334155;color:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.3);" title="Mute/Unmute">🎤</button>
        ${activeCallType === 'video' ? `<button id="sds-video-btn" style="width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;background:#334155;color:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.3);" title="Toggle Video">📹</button>` : ''}
        <button id="sds-end-btn" style="width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;background:#dc2626;color:#ffffff;box-shadow:0 4px 12px rgba(220,38,38,0.4);" title="End Call">📞</button>
      </div>
    `;

    setTimeout(() => {
      updateActiveCallMedia();

      const muteBtn = document.getElementById('sds-mute-btn');
      const videoBtn = document.getElementById('sds-video-btn');
      const endBtn = document.getElementById('sds-end-btn');

      if (muteBtn) {
        muteBtn.onclick = () => {
          isMuted = !isMuted;
          if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
          }
          muteBtn.style.background = isMuted ? '#dc2626' : '#334155';
          muteBtn.textContent = isMuted ? '🔇' : '🎤';
        };
      }

      if (videoBtn) {
        videoBtn.onclick = () => {
          isVideoOff = !isVideoOff;
          if (localStream) {
            localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
          }
          videoBtn.style.background = isVideoOff ? '#dc2626' : '#334155';
          videoBtn.textContent = isVideoOff ? '🚫' : '📹';
        };
      }

      if (endBtn) endBtn.onclick = () => endCall();
    }, 50);
  }

  function endCall() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    remoteStream = null;

    if (activeCallConnection) {
      activeCallConnection.close();
      activeCallConnection = null;
    }

    activeCallType = null;
    isMuted = false;
    isVideoOff = false;

    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    callDuration = 0;

    const callOverlay = document.getElementById('sds-call-overlay');
    if (callOverlay) callOverlay.remove();

    const audioEl = document.getElementById('sds-remote-audio');
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }

    const feed = document.getElementById('sds-feed');
    if (feed) feed.style.display = '';
    const inputBar = document.getElementById('sds-input-bar');
    if (inputBar) inputBar.style.display = 'flex';
  }

  // Styles & UI
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes sdsIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
      @keyframes sdsPulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
      #sds-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 99998;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #1e3a8a, #2563eb);
        color: #ffffff;
        border: 2px solid #ffffff;
        box-shadow: 0 4px 16px rgba(37,99,235,0.35);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      #sds-fab:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 20px rgba(37,99,235,0.45);
      }
      #sds-container {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 99999;
        width: 370px;
        height: 560px;
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18);
        border: 1px solid #e2e8f0;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
        animation: sdsIn 0.3s;
      }
      #sds-unicat-status-text { display:inline-block; font-weight:600; font-size:10px; color:#64748b; white-space:nowrap; }
      @media(max-width:480px) {
        #sds-container { width:calc(100vw - 16px); height:calc(100vh - 20px); height:calc(100dvh - 20px); right:8px; bottom:8px; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildUI() {
    const fab = document.createElement('button');
    fab.id = 'sds-fab';
    fab.innerHTML = '💬';
    fab.title = 'Open SVS Cross-Site Chat & Calls';
    fab.onclick = () => togglePkg();
    document.body.appendChild(fab);

    const container = document.createElement('div');
    container.id = 'sds-container';
    container.innerHTML = `
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#ffffff;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.15);">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="position:relative;">
            <div style="width:36px;height:36px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;box-shadow:0 2px 8px rgba(245,158,11,0.4);">💬</div>
            <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;background:#22c55e;border-radius:50%;border:2px solid #ffffff;animation:sdsPulse 2s infinite;"></span>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;">SVS Bridge <span style="background:rgba(34,197,94,0.25);color:#4ade80;font-size:8px;font-weight:800;padding:2px 6px;border-radius:4px;border:1px solid rgba(74,222,128,0.4);">LIVE</span></div>
            <div style="font-size:10px;color:#cbd5e1;"><span id="sds-admin-label" style="color:#fbbf24;font-weight:600;">Payroll Admin</span></div>
          </div>
        </div>
        <div style="display:flex;gap:4px;">
          <button id="sds-min-btn" style="background:none;border:none;color:#cbd5e1;cursor:pointer;padding:6px;font-size:16px;" title="Minimize">—</button>
          <button id="sds-close-btn" style="background:none;border:none;color:#cbd5e1;cursor:pointer;padding:6px;font-size:16px;" title="Close">✕</button>
        </div>
      </div>

      <!-- Site indicator + channel tabs -->
      <div style="background:#f8fafc;padding:6px 12px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;">
        <div id="sds-unicat-status-badge" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 8px;border-radius:6px;min-height:22px;background:rgba(241,245,249,0.8);" title="Connection status">
          <span id="sds-unicat-status-dot" style="width:8px;height:8px;background:#94a3b8;border-radius:50%;display:inline-block;flex-shrink:0;transition:all 0.3s;"></span>
          <span id="sds-unicat-status-text">Checking...</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button id="sds-ch-admins" style="background:#1e3a8a;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;" title="Payroll OPRs">OPRs</button>
          <button id="sds-ch-cross" style="background:transparent;color:#64748b;border:1px solid #cbd5e1;border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;" title="Cross-Site Chat (Unicat)">XST</button>
          <select id="sds-target-admin" style="display:none;background:#ffffff;color:#d97706;font-size:9px;font-weight:700;border:1px solid #cbd5e1;border-radius:4px;padding:2px 4px;cursor:pointer;max-width:110px;" title="Target OPR"></select>
        </div>
      </div>

      <!-- Call controls & auto-delete -->
      <div style="background:#f8fafc;padding:6px 12px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:flex-end;gap:5px;">
        <button id="sds-call-voice" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;" title="Voice Call">📞 Audio</button>
        <button id="sds-call-video" style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;" title="Video Call">📹 Video</button>
        <select id="sds-autodelete" style="background:#ffffff;color:#2563eb;font-size:9px;font-weight:700;border:1px solid #cbd5e1;border-radius:4px;padding:2px 4px;cursor:pointer;" title="Auto-delete messages after viewing">
          <option value="10">10s</option>
          <option value="30">30s</option>
          <option value="60">1m</option>
          <option value="120">2m</option>
          <option value="180">3m</option>
          <option value="300">5m</option>
        </select>
        <span id="sds-msg-count" style="font-size:9px;color:#64748b;font-family:monospace;margin-left:4px;">0 msgs</span>
      </div>

      <!-- Messages feed -->
      <div id="sds-feed" style="flex:1;padding:12px;overflow-y:auto;background:#ffffff;"></div>

      <!-- Reply preview bar -->
      <div id="sds-reply-preview" style="display:none;padding:6px 12px;background:#eff6ff;border-top:1px solid #bfdbfe;align-items:center;justify-content:space-between;font-size:11px;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;">
          <span id="sds-reply-user" style="font-weight:700;color:#1d4ed8;">Replying:</span>
          <span id="sds-reply-text" style="color:#475569;margin-left:4px;"></span>
        </div>
        <button id="sds-reply-cancel-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;padding:0 4px;" title="Cancel Reply">✕</button>
      </div>

      <!-- File preview -->
      <div id="sds-file-preview" style="display:none;padding:6px 12px;background:#f1f5f9;border-top:1px solid #cbd5e1;align-items:center;justify-content:space-between;"></div>

      <!-- Emoji Picker -->
      <div id="sds-emoji-picker" style="display:none;background:#f8fafc;border-top:1px solid #cbd5e1;padding:8px;"></div>

      <!-- Input bar -->
      <div id="sds-input-bar" style="padding:10px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;">
        <button id="sds-emoji-btn" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;padding:4px;" title="Emoji">😊</button>
        <button id="sds-attach-btn" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;padding:4px;" title="Attach file">📎</button>
        <input type="file" id="sds-file-input" style="display:none;">
        <input type="text" id="sds-input" autocomplete="off" spellcheck="false" placeholder="Type a message..." style="flex:1;font-size:12px;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;border-radius:12px;padding:8px 12px;outline:none;font-family:'Plus Jakarta Sans',system-ui,sans-serif;" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#cbd5e1'">
        <button id="sds-send-btn" style="background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border:none;border-radius:12px;padding:8px 14px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(37,99,235,0.3);" title="Send">➤</button>
      </div>
    `;
    document.body.appendChild(container);

    // Event listeners
    document.getElementById('sds-close-btn').onclick = () => togglePkg(false);
    document.getElementById('sds-min-btn').onclick = () => togglePkg(false);
    document.getElementById('sds-send-btn').onclick = sendMessage;
    const repCancel = document.getElementById('sds-reply-cancel-btn');
    if (repCancel) repCancel.onclick = cancelReply;

    document.getElementById('sds-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendMessage();
    });

    document.getElementById('sds-attach-btn').onclick = () => {
      document.getElementById('sds-file-input').click();
    };

    document.getElementById('sds-file-input').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert('File size exceeds 2 MB limit.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        attachedFile = { name: file.name, data: ev.target.result };
        updateFilePreview();
      };
      reader.readAsDataURL(file);
      this.value = '';
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
        deleteAfterSeconds = parseInt(autoDeleteSel.value, 10) || 60;
        saveAutoDeleteSetting();
        clearAutoDeleteTimers();
        firstSeenAt.clear();
        loadMessages();
      };
    }

    // Emoji picker
    const EMOJIS = ['😊', '😂', '👍', '🔥', '🎉', '❤️', '💼', '👋', '🙏', '✨', '🚀', '💯', '👏', '✅', '⭐', '⚡', '💡', '📌', '📈', '📋', '🔒', '📎', '💬', '📞', '📹', '🎯', '👌', '🤝', '🙌', '😎', '☀️', '☕'];
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

    const statusBadge = document.getElementById('sds-unicat-status-badge');
    if (statusBadge) {
      statusBadge.onclick = () => {
        statusBadge.classList.toggle('show-text');
      };
    }
  }

  function togglePkg(forceState) {
    const container = document.getElementById('sds-container');
    if (!container) return;

    pkgOpen = forceState !== undefined ? forceState : !pkgOpen;

    if (pkgOpen) {
      container.style.display = 'flex';
      startPolling();
      checkUnicatOnlineStatus();
      messages.forEach(scheduleAutoDelete);
      renderMessages(true);
    } else {
      container.style.display = 'none';
      stopPolling();
    }
    updatePkgLauncherVisibility();
  }

  function updatePkgLauncherVisibility() {
    const fab = document.getElementById('sds-fab');
    if (!fab) return;
    fab.style.display = pkgOpen || hideFabAfterCrossSend ? 'none' : 'flex';
  }

  function hideCrossSiteLauncherForSender() {
    hideFabAfterCrossSend = true;
    try {
      localStorage.setItem(fabHiddenStorageKey(), 'true');
    } catch (err) {
      console.warn('[SDS] Could not persist cross-site launcher visibility:', err);
    }
    updatePkgLauncherVisibility();
  }

  function initSettingsOnlyVisibility() {
    updatePkgLauncherVisibility();
    window.addEventListener('hashchange', updatePkgLauncherVisibility);
    window.addEventListener('storage', event => {
      if (event.key === fabHiddenStorageKey() && event.newValue === 'true') {
        hideFabAfterCrossSend = true;
        updatePkgLauncherVisibility();
      }
    });
  }

  // Channel switching
  function parseUsersArray(raw) {
    let result = raw;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (Array.isArray(result.data)) {
        result = result.data;
      } else if (Array.isArray(result.users)) {
        result = result.users;
      } else if (Array.isArray(result.results)) {
        result = result.results;
      } else {
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
    const crossBtn = document.getElementById('sds-ch-cross');
    const adminsBtn = document.getElementById('sds-ch-admins');
    const input = document.getElementById('sds-input');
    const activeStyle = 'background:#1e3a8a;color:#fff;border:none;';
    const idleStyle = 'background:transparent;color:#64748b;border:1px solid #cbd5e1;';
    if (mode === 'admins') {
      if (input) input.placeholder = 'Message payroll OPRs...';
      if (crossBtn) crossBtn.style.cssText = idleStyle + 'border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;';
      if (adminsBtn) adminsBtn.style.cssText = activeStyle + 'border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;';
    } else {
      if (input) input.placeholder = 'Message Unicat...';
      if (crossBtn) crossBtn.style.cssText = activeStyle + 'border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;';
      if (adminsBtn) adminsBtn.style.cssText = idleStyle + 'border-radius:6px;padding:4px 9px;font-size:10px;font-weight:700;cursor:pointer;';
    }
    clearAutoDeleteTimers();
    const feed = document.getElementById('sds-feed');
    if (feed) feed.innerHTML = '';
    messages = [];
    await refreshAdminSelect();
    loadMessages();
  }

  // Polling
  async function loadMessages() {
    let fetched;
    try {
      fetched = await supabaseFetchMessages();
    } catch (err) {
      console.error('[SDS] Supabase message fetch failed:', err);
      return;
    }
    const fetchedIds = new Set(fetched.map(m => m.id));
    for (const id of Array.from(firstSeenAt.keys())) {
      if (!fetchedIds.has(id)) firstSeenAt.delete(id);
    }
    const filtered = fetched.filter(m => {
      const isCross = (m.channel === 'cross' || m.senderSite === 'unicat' || m.recipient === 'payroll' || m.recipient === 'unicat');
      if (channelMode === 'cross') {
        return isCross;
      } else {
        if (isCross) return false;
        return m.senderSite === SITE_ID && (m.recipient === '' || m.recipient === MY_USERNAME || m.senderAdmin === MY_USERNAME);
      }
    });

    const serverIds = new Set(filtered.map(m => m.id));
    const now = Date.now();
    const pendingLocal = messages.filter(m => !serverIds.has(m.id) && (now - new Date(m.createdAt).getTime()) < 120000);
    messages = [...filtered, ...pendingLocal];

    if (channelMode === 'cross' && messages.some(m => m.senderSite === SITE_ID && m.senderAdmin === MY_USERNAME)) {
      hideCrossSiteLauncherForSender();
    }

    renderMessages();
    messages.forEach(scheduleAutoDelete);
    const countEl = document.getElementById('sds-msg-count');
    if (countEl) countEl.textContent = messages.length + ' msgs';
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

  let cachedUnicatLastSeen = 0;
  try {
    cachedUnicatLastSeen = parseInt(localStorage.getItem('sds_unicat_last_seen') || '0', 10) || 0;
  } catch (e) {}

  function updateStatusUI(lastSeen) {
    const dot = document.getElementById('sds-unicat-status-dot');
    const text = document.getElementById('sds-unicat-status-text');
    const badge = document.getElementById('sds-unicat-status-badge');
    if (!dot) return;

    if (lastSeen > 0) {
      if (lastSeen > cachedUnicatLastSeen) {
        cachedUnicatLastSeen = lastSeen;
        try { localStorage.setItem('sds_unicat_last_seen', String(lastSeen)); } catch (e) {}
      }
    }

    const effectiveTime = cachedUnicatLastSeen;
    const isOnline = effectiveTime && (Date.now() - effectiveTime < 25000);

    if (isOnline) {
      dot.style.background = '#22c55e';
      dot.style.boxShadow = '0 0 6px #22c55e';
      if (text) {
        text.textContent = 'Online';
        text.style.color = '#15803d';
      }
      if (badge) badge.title = 'Online and active';
    } else {
      dot.style.background = '#94a3b8';
      dot.style.boxShadow = 'none';
      const ago = formatRelativeTime(effectiveTime);
      if (text) {
        text.textContent = ago;
        text.style.color = '#64748b';
      }
      let fullTime = '';
      try {
        if (effectiveTime) fullTime = ` (${new Date(effectiveTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
      } catch (e) {}
      if (badge) badge.title = effectiveTime ? `Last active ${ago}${fullTime}` : 'Offline';
    }
  }

  async function checkUnicatOnlineStatus() {
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if ((m.senderSite === 'unicat' || m.senderAdmin === 'unicat') && m.createdAt) {
          const t = new Date(m.createdAt).getTime();
          if (t && t > cachedUnicatLastSeen) {
            updateStatusUI(t);
          }
        }
      }
    }

    updateStatusUI(0);

    try {
      const { data, error } = await getSupabaseClient()
        .from('cross_site_status')
        .select('last_seen, peer_id')
        .eq('site', 'unicat')
        .maybeSingle();
      if (error) throw error;
      if (data?.peer_id) {
        cachedUnicatPeerId = data.peer_id;
      }
      const lastSeen = Number(data?.last_seen || 0);
      if (lastSeen) updateStatusUI(lastSeen);
    } catch (err) {
      console.error('[SDS] Supabase Unicat presence check failed:', err);
    }
  }

  async function sendPayrollHeartbeat() {
    try {
      const peerId = (peers.cross && peers.cross.open) ? 'payroll-peer-admin' : (peers.admin?.id || 'payroll-peer-admin');
      const { error } = await getSupabaseClient().from('cross_site_status').upsert({
        site: 'payroll',
        last_seen: Date.now(),
        active_admin: MY_USERNAME,
        peer_id: peerId,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
    } catch (err) {
      console.error('[SDS] Supabase Payroll heartbeat failed:', err);
    }
  }

  function startPolling() {
    loadMessages();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(loadMessages, 4000);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // Init
  function init() {
    let u = null;
    try {
      u = (window.auth && typeof auth.getCurrentUser === 'function') ? auth.getCurrentUser() : null;
      if (!u) {
        const legacy = JSON.parse(localStorage.getItem('payflowToken') || localStorage.getItem('hr_current_user') || 'null');
        if (legacy && legacy.username) u = legacy;
      }
    } catch (e) {}

    const isAdmin = u && (u.role === 'admin' || u.username === 'admin');
    if (!isAdmin) {
      window.SDS = {
        openPkg: function() {},
        openChat: function() {},
        call: function() {},
        callCrossSite: function() {},
      };
      return;
    }

    if (u && u.username) {
      MY_USERNAME = u.username;
      ADMIN_NAME = u.username;
    }

    try {
      hideFabAfterCrossSend = localStorage.getItem(fabHiddenStorageKey()) === 'true';
    } catch (err) {
      console.warn('[SDS] Could not restore cross-site launcher visibility:', err);
    }

    loadAutoDeleteSetting();

    injectStyles();
    buildUI();
    updateStatusUI(0);
    checkUnicatOnlineStatus();
    setChannel('admins');

    const label = document.getElementById('sds-admin-label');
    if (label) label.textContent = ADMIN_NAME;

    initSettingsOnlyVisibility();

    // Public API for Payroll System & Settings page
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
      openChat: function (channel, target) {
        return this.openPkg(channel, target);
      },
      call: function (target, type) {
        setChannel('admins');
        targetAdmin = target || '';
        const sel = document.getElementById('sds-target-admin');
        if (sel && target) sel.value = target;
        togglePkg(true);
        initiateAdminCall(type || 'voice');
      },
      callCrossSite: function (type) {
        setChannel('cross');
        togglePkg(true);
        initiateCall(type || 'voice');
      }
    };

    // Initialize PeerJS for voice/video calls
    initPeerJS();

    // Send heartbeat so Unicat knows Payroll is online
    sendPayrollHeartbeat();
    setInterval(sendPayrollHeartbeat, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
