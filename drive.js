/**
 * VOOAR — drive.js
 * AssetDB  → IndexedDB para armazenar qualquer asset binário offline
 * MindDB   → alias compatível com versão anterior (store/getBlobUrl para .mind)
 * Drive    → comunicação com Google Apps Script
 */

// ── AssetDB — armazena qualquer asset binário no IndexedDB ───────────────────
const AssetDB = (() => {
  const DB_NAME    = 'vooar_assets_db';
  const STORE_NAME = 'assets';          // chave: "<tipo>_<projectId>"
  const DB_VERSION = 2;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        // migração: copia dados do store antigo se existir
        const old = 'mind_files';
        if (db.objectStoreNames.contains(old) && e.oldVersion < 2) {
          // vamos apenas manter o store antigo, dados serão re-lidos pela chave
        }
      };
      req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
      req.onerror    = e => reject(e.target.error);
    });
  }

  /** Chave composta: tipo + projectId */
  function key(type, id) { return `${type}_${id}`; }

  /**
   * Salva um ArrayBuffer.
   * @param {'mind'|'video'|'image'} type
   * @param {string|number} id  projectId
   * @param {ArrayBuffer}   buf
   */
  async function store(type, id, buf) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(buf, key(type, id));
      req.onsuccess = () => resolve(true);
      req.onerror   = e => reject(e.target.error);
    });
  }

  /**
   * Recupera e cria um Blob URL (same-origin — sem CORS).
   * @param {'mind'|'video'|'image'} type
   * @param {string|number}          id
   * @param {string}                 mimeType  ex: 'video/mp4', 'application/octet-stream'
   */
  async function getBlobUrl(type, id, mimeType = 'application/octet-stream') {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key(type, id));
      req.onsuccess = e => {
        const buf = e.target.result;
        if (!buf) return resolve(null);
        const blob = new Blob([buf], { type: mimeType });
        resolve(URL.createObjectURL(blob));
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  /** Verifica se há um asset salvo */
  async function has(type, id) {
    const db = await open();
    return new Promise(resolve => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count(key(type, id));
      req.onsuccess = e => resolve(e.target.result > 0);
      req.onerror   = () => resolve(false);
    });
  }

  /** Remove entrada */
  async function remove(type, id) {
    const db = await open();
    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key(type, id));
      tx.oncomplete = () => resolve(true);
    });
  }

  /** Baixa uma URL e armazena no IndexedDB. Retorna Blob URL. */
  async function fetchAndStore(type, id, url, mimeType) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      await store(type, id, buf);
      return getBlobUrl(type, id, mimeType);
    } catch(e) {
      console.warn(`[AssetDB] fetchAndStore ${type}/${id}:`, e);
      return null;
    }
  }

  /**
   * Salva um objeto JSON no IndexedDB (codificado como UTF-8 ArrayBuffer).
   * @param {string}        type  ex: 'project'
   * @param {string|number} id
   * @param {object}        obj
   */
  async function storeJSON(type, id, obj) {
    try {
      const buf = new TextEncoder().encode(JSON.stringify(obj)).buffer;
      await store(type, id, buf);
      return true;
    } catch(e) {
      console.warn(`[AssetDB] storeJSON ${type}/${id}:`, e);
      return false;
    }
  }

  /**
   * Recupera um objeto JSON armazenado por storeJSON.
   * Retorna null se não encontrado ou se JSON inválido.
   */
  async function getJSON(type, id) {
    const db = await open();
    return new Promise(resolve => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key(type, id));
      req.onsuccess = e => {
        const buf = e.target.result;
        if (!buf) return resolve(null);
        try { resolve(JSON.parse(new TextDecoder().decode(buf))); }
        catch  { resolve(null); }
      };
      req.onerror = () => resolve(null);
    });
  }

  return { store, getBlobUrl, has, remove, fetchAndStore, storeJSON, getJSON };
})();

// ── MindDB — alias para backwards-compat (.mind sempre usa tipo 'mind') ──────
const MindDB = {
  store:      (id, buf)    => AssetDB.store('mind', id, buf),
  getBlobUrl: (id)         => AssetDB.getBlobUrl('mind', id, 'application/octet-stream'),
  remove:     (id)         => AssetDB.remove('mind', id),
};

// ── Drive — comunicação com Google Apps Script ────────────────────────────────
const Drive = (() => {
  const CONFIG_KEY = 'vooar_drive_url';

  function getUrl()        { return localStorage.getItem(CONFIG_KEY) || ''; }
  function setUrl(url)     { localStorage.setItem(CONFIG_KEY, url.trim()); }
  function isConfigured()  { return !!getUrl(); }

  /** Converte File → base64 puro (sem prefixo data:…;base64,) */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function get(params) {
    const url = getUrl();
    if (!url) throw new Error('Drive não configurado');
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(`${url}?${qs}`);
    if (!res.ok) throw new Error('Drive GET falhou: ' + res.status);
    return res.json();
  }

  async function post(body) {
    const url = getUrl();
    if (!url) throw new Error('Drive não configurado');
    const res = await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Drive POST falhou: ' + res.status);
    return res.json();
  }

  async function ping() {
    try {
      const data = await get({ action: 'ping' });
      return !!data.ok;
    } catch { return false; }
  }

  /**
   * Upload de arquivo para o Drive (apenas imagens — vídeos são muito grandes para base64).
   * @param {File}     file
   * @param {string}   folder  'images'
   * @param {Function} onProgress cb(0-100)
   */
  async function uploadFile(file, folder, onProgress) {
    if (!isConfigured()) throw new Error('Drive não configurado');
    onProgress && onProgress(10);
    const b64 = await fileToBase64(file);
    onProgress && onProgress(50);
    const result = await post({
      action  : 'upload',
      data    : b64,
      mimeType: file.type,
      filename: file.name,
      folder
    });
    onProgress && onProgress(100);
    if (!result.ok) throw new Error(result.error || 'Erro no upload');
    return result;
  }

  async function listProjects(uid)          { return (await get({ action: 'list', uid })) || []; }
  async function saveProject(uid, project)  { return post({ action: 'saveProject', uid, project }); }
  async function deleteProject(uid, id)     { return get({ action: 'delete', uid, id: String(id) }); }
  async function incrementViews(uid, id)    { try { await post({ action: 'incrementViews', uid, id }); } catch {} }
  async function saveUser(user)             { return post({ action: 'saveUser', user }); }

  return {
    getUrl, setUrl, isConfigured,
    ping, uploadFile,
    listProjects, saveProject, deleteProject, incrementViews, saveUser
  };
})();

window.AssetDB = AssetDB;
window.MindDB  = MindDB;
window.Drive   = Drive;
