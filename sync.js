/**
 * VOOAR — sync.js
 * ────────────────────────────────────────────────────────────────────────────
 * SyncManager: sistema central de conectividade online/offline.
 *
 * Responsabilidades:
 *  • Detectar online/offline (eventos do navegador + ping periódico ao servidor)
 *  • Manter fila de projetos pendentes quando offline
 *  • Auto-reenviar fila quando a conexão é restaurada
 *  • Atualizar automaticamente badges/pills de status em toda a UI
 *  • Expor API simples para editor, dashboard e viewer
 *
 * Uso:
 *   SyncManager.syncProject(uid, project)   → salva no servidor ou enfileira
 *   SyncManager.on('status', cb)            → callback ao mudar status
 *   SyncManager.bindPill(element)           → atualiza pill automaticamente
 *   SyncManager.status                      → 'online'|'drive'|'offline'|'no_server'
 * ────────────────────────────────────────────────────────────────────────────
 */
const SyncManager = (() => {

  // ── Estado ──────────────────────────────────────────────────────────────────
  let _online    = navigator.onLine;
  let _serverOk  = false;
  let _driveOk   = false;
  let _queue     = [];
  let _listeners = {};
  let _boundPills = [];       // elementos DOM cujo conteúdo é atualizado auto
  let _checkTimer = null;
  let _flushing   = false;

  const QUEUE_KEY   = 'vooar_sync_queue_v2';
  const CHECK_INTERVAL = 30_000;  // 30 s

  // ── Fila persistente ────────────────────────────────────────────────────────
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
  }
  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(_queue)); }
    catch {}
  }

  // ── Eventos ─────────────────────────────────────────────────────────────────
  function on(event, cb)  {
    (_listeners[event] = _listeners[event] || []).push(cb);
  }
  function off(event, cb) {
    if (_listeners[event]) _listeners[event] = _listeners[event].filter(l => l !== cb);
  }
  function emit(event, data) {
    (_listeners[event] || []).forEach(cb => { try { cb(data); } catch(e) { console.warn('[Sync]', e); } });
    (_listeners['*']   || []).forEach(cb => { try { cb(event, data); } catch(e) {} });
    // Atualiza todos os pills vinculados
    if (event === 'status' || event === 'queue') _boundPills.forEach(el => _renderPill(el));
  }

  // ── Status ───────────────────────────────────────────────────────────────────
  function getStatus() {
    if (!_online)   return 'offline';
    if (_driveOk)   return 'drive';
    if (_serverOk)  return 'online';
    return 'no_server';
  }

  // ── Verifica servidor ────────────────────────────────────────────────────────
  async function checkServer(silent = false) {
    if (!navigator.onLine) {
      const changed = _serverOk || _driveOk;
      _serverOk = _driveOk = false;
      _online = false;
      if (changed && !silent) emit('status', getStatus());
      return getStatus();
    }
    _online = true;
    const prevStatus = getStatus();

    // Ping servidor
    const wasServer = _serverOk;
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(3500), cache: 'no-cache' });
      _serverOk = r.ok;
    } catch { _serverOk = false; }

    // Se servidor voltou: flush da fila
    if (!wasServer && _serverOk) {
      setTimeout(flushQueue, 600);
    }

    // Ping Drive
    if (window.Drive && Drive.isConfigured()) {
      _driveOk = await Drive.ping().catch(() => false);
    } else {
      _driveOk = false;
    }

    const newStatus = getStatus();
    if (!silent || newStatus !== prevStatus) emit('status', newStatus);
    return newStatus;
  }

  // ── Retirar base64 locais antes de enviar ───────────────────────────────────
  function stripLocals(p) {
    if (!p) return p;
    return {
      ...p,
      triggerImageLocal: undefined,
      targets: (p.targets || []).map(t => ({ ...t, triggerImageLocal: undefined })),
    };
  }

  // ── Sync de projeto (online → imediato | offline → fila) ───────────────────
  async function syncProject(uid, project) {
    const clean = stripLocals(project);
    const key   = String(project.id);

    // Remove entrada anterior do mesmo projeto na fila
    _queue = _queue.filter(q => String(q.projectId) !== key);

    // Se online mas _serverOk ainda não foi confirmado (race condition do init),
    // força uma verificação antes de decidir se enfileira ou envia direto.
    if (navigator.onLine && !_serverOk && !_driveOk) {
      await checkServer(true);
    }

    if (_serverOk || _driveOk) {
      let ok = false;

      if (_serverOk) {
        try {
          const r = await fetch(`/api/projects/${uid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clean),
            signal: AbortSignal.timeout(12000),
          });
          ok = r.ok;
        } catch { _serverOk = false; }
      }

      if (!ok && _driveOk && window.Drive) {
        try { await Drive.saveProject(uid, clean); ok = true; }
        catch { _driveOk = false; }
      }

      if (ok) {
        saveQueue();
        emit('synced', { projectId: key });
        emit('queue',  { count: _queue.length });
        return true;
      }
    }

    // Falhou ou offline → enfileira
    _queue.push({
      type: 'project', uid, projectId: key,
      data: clean, timestamp: Date.now(),
    });
    saveQueue();
    emit('queue', { count: _queue.length });
    return false;
  }

  // ── Flush da fila ────────────────────────────────────────────────────────────
  async function flushQueue() {
    if (_flushing || !_queue.length) return;
    if (!_serverOk && !_driveOk) return;
    _flushing = true;
    emit('flushing', { count: _queue.length });

    const failed = [];
    for (const item of [..._queue]) {
      let ok = false;
      try {
        if (_serverOk) {
          const r = await fetch(`/api/projects/${item.uid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.data),
            signal: AbortSignal.timeout(12000),
          });
          ok = r.ok;
        }
        if (!ok && _driveOk && window.Drive) {
          await Drive.saveProject(item.uid, item.data);
          ok = true;
        }
      } catch {}
      if (!ok) failed.push(item);
    }

    _queue = failed;
    saveQueue();
    _flushing = false;
    const sent = _queue.length === 0;
    emit('flushed', { sent, pending: _queue.length });
    emit('queue',   { count: _queue.length });
    if (sent) emit('status', getStatus()); // atualiza UI
  }

  // ── Handlers online/offline do navegador ────────────────────────────────────
  function handleOnline()  { _online = true;  checkServer(); }
  function handleOffline() {
    _online = _serverOk = _driveOk = false;
    emit('status', 'offline');
    _boundPills.forEach(el => _renderPill(el));
  }

  // ── Pill / badge de status ──────────────────────────────────────────────────
  const PILL_CFG = {
    online:    { cls: 'online',  icon: '🟢', label: 'online' },
    drive:     { cls: 'drive',   icon: '☁️',  label: 'Drive' },
    offline:   { cls: 'offline', icon: '🔴', label: 'offline' },
    no_server: { cls: 'offline', icon: '🟡', label: 'sem servidor' },
  };

  function _renderPill(el) {
    if (!el) return;
    const status  = getStatus();
    const cfg     = PILL_CFG[status] || PILL_CFG.offline;
    const pending = _queue.length;

    // Compatível com class "server-status" do editor e dashboard
    el.className = `server-status ${cfg.cls}`;

    const pendingBadge = pending > 0
      ? ` <span style="background:rgba(255,200,60,.18);border-radius:8px;padding:1px 6px;font-size:9px;color:rgba(255,200,60,.95)">${pending}⏳</span>`
      : '';

    el.innerHTML = `<span class="status-dot"></span><span id="${el.id}-label">${cfg.label}${pending > 0 ? '' : ''}</span>${pendingBadge}`;
  }

  /** Vincula um elemento pill ao SyncManager — atualizado automaticamente */
  function bindPill(el) {
    if (!el || _boundPills.includes(el)) return;
    _boundPills.push(el);
    _renderPill(el);
    // Click para redirecionar para config drive (mantém comportamento atual)
  }

  /** Desvincula */
  function unbindPill(el) {
    _boundPills = _boundPills.filter(p => p !== el);
  }

  // ── Inicialização ────────────────────────────────────────────────────────────
  function init() {
    _queue = loadQueue();
    _online = navigator.onLine;
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    // Verificação inicial (não bloqueia)
    checkServer(true);
    // Verificação periódica
    _checkTimer = setInterval(() => checkServer(true), CHECK_INTERVAL);
  }

  init();

  // ── API pública ──────────────────────────────────────────────────────────────
  return {
    on, off,
    checkServer,
    syncProject,
    flushQueue,
    bindPill,
    unbindPill,
    stripLocals,
    get status()     { return getStatus(); },
    get isOnline()   { return _online; },
    get serverOk()   { return _serverOk; },
    get driveOk()    { return _driveOk; },
    get queueCount() { return _queue.length; },
    get queue()      { return [..._queue]; },
  };
})();

window.SyncManager = SyncManager;
