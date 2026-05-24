/**
 * VOOAR — Google Apps Script Backend
 * Pasta raiz no Drive: 1wuXGqtKxCcz56euNLlLBKsidwbNSaC8E
 *
 * Como publicar:
 *   1. Acesse https://script.google.com/
 *   2. Crie um novo projeto → cole este código
 *   3. Implantar → Nova implantação → Tipo: Aplicativo da Web
 *      - Executar como: Eu (seu e-mail)
 *      - Quem tem acesso: Qualquer pessoa
 *   4. Copie a URL gerada e cole no editor VOOAR em "URL do Apps Script"
 */

// ── Configuração ──────────────────────────────────────────────────────────────
const ROOT_FOLDER_ID = '1wuXGqtKxCcz56euNLlLBKsidwbNSaC8E';
const SUBFOLDER_NAMES = { images: 'images', videos: 'videos', data: 'data' };

// ── Utilitários ───────────────────────────────────────────────────────────────
function getRootFolder() {
  return DriveApp.getFolderById(ROOT_FOLDER_ID);
}

function getOrCreateSubfolder(name) {
  const root = getRootFolder();
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function makePublic(file) {
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file;
}

function driveUrl(fileId) {
  // URL de download direto — funciona sem autenticação
  return 'https://drive.google.com/uc?id=' + fileId + '&export=download';
}

function jsonResponse(obj, status) {
  const payload = JSON.stringify(obj);
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function addCORS(output) {
  // Apps Script não suporta cabeçalhos CORS personalizados em doGet/doPost,
  // mas como retornamos JSON via ContentService a maioria dos browsers aceita.
  // Para contornar completamente use o padrão JSONP ou um proxy.
  return output;
}

// ── doGet — leitura de projetos ───────────────────────────────────────────────
function doGet(e) {
  try {
    const action = (e.parameter && e.parameter.action) || '';
    const uid    = (e.parameter && e.parameter.uid)    || '';
    const id     = (e.parameter && e.parameter.id)     || '';

    // Verificação de saúde
    if (action === 'ping') {
      return jsonResponse({ ok: true, version: '1.0.0', ts: Date.now() });
    }

    // Listar projetos do usuário
    if (action === 'list' && uid) {
      const projects = loadProjects(uid);
      return jsonResponse(projects);
    }

    // Projeto específico
    if (action === 'get' && uid && id) {
      const projects = loadProjects(uid);
      const p = projects.find(x => String(x.id) === String(id));
      if (!p) return jsonResponse({ error: 'Projeto não encontrado' });
      return jsonResponse(p);
    }

    // Deletar projeto
    if (action === 'delete' && uid && id) {
      let projects = loadProjects(uid);
      projects = projects.filter(x => String(x.id) !== String(id));
      saveProjects(uid, projects);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Ação inválida' });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ── doPost — upload de arquivo + salvar projeto ───────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action || '';

    // ── Upload de arquivo ──────────────────────────────────────────────────────
    if (action === 'upload') {
      const base64   = payload.data;       // string base64 pura (sem prefixo)
      const mimeType = payload.mimeType;   // ex: "image/jpeg"
      const filename = payload.filename;   // nome original
      const folder   = payload.folder;     // "images" | "videos"

      if (!base64 || !mimeType || !filename || !folder) {
        return jsonResponse({ error: 'Parâmetros ausentes: data, mimeType, filename, folder' });
      }

      const bytes    = Utilities.base64Decode(base64);
      const blob     = Utilities.newBlob(bytes, mimeType, filename);
      const subdir   = getOrCreateSubfolder(SUBFOLDER_NAMES[folder] || folder);
      const file     = makePublic(subdir.createFile(blob));
      const fileId   = file.getId();
      const url      = driveUrl(fileId);
      const sizeKB   = Math.round(file.getSize() / 1024);

      Logger.log('[upload] ' + filename + ' → ' + fileId + ' (' + sizeKB + ' KB)');
      return jsonResponse({ ok: true, url, fileId, sizeKB, type: folder });
    }

    // ── Salvar / atualizar projeto ─────────────────────────────────────────────
    if (action === 'saveProject') {
      const uid     = payload.uid;
      const project = payload.project;
      if (!uid || !project) return jsonResponse({ error: 'uid e project são obrigatórios' });

      let projects = loadProjects(uid);
      const idx    = projects.findIndex(x => x.id === project.id);
      if (idx >= 0) projects[idx] = project; else projects.unshift(project);
      saveProjects(uid, projects);
      return jsonResponse({ ok: true });
    }

    // ── Salvar usuário ─────────────────────────────────────────────────────────
    if (action === 'saveUser') {
      const user = payload.user;
      if (!user || !user.id) return jsonResponse({ error: 'user.id obrigatório' });

      let users   = loadUsers();
      const idx   = users.findIndex(u => u.id === user.id);
      if (idx >= 0) users[idx] = user; else users.push(user);
      saveUsers(users);
      return jsonResponse({ ok: true });
    }

    // ── Incrementar views ──────────────────────────────────────────────────────
    if (action === 'incrementViews') {
      const uid = payload.uid;
      const id  = String(payload.id);
      if (!uid || !id) return jsonResponse({ error: 'uid e id obrigatórios' });

      let projects = loadProjects(uid);
      const p = projects.find(x => String(x.id) === id);
      if (p) { p.views = (p.views || 0) + 1; saveProjects(uid, projects); }
      return jsonResponse({ ok: true, views: p ? p.views : 0 });
    }

    return jsonResponse({ error: 'Ação inválida: ' + action });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ── Persistência de projetos no Drive ─────────────────────────────────────────
function projectsFilename(uid) { return 'projects_' + uid + '.json'; }

function loadProjects(uid) {
  return readJSONFile(projectsFilename(uid), []);
}

function saveProjects(uid, projects) {
  writeJSONFile(projectsFilename(uid), projects);
}

// ── Persistência de usuários no Drive ─────────────────────────────────────────
function loadUsers() { return readJSONFile('users.json', []); }
function saveUsers(users) { writeJSONFile('users.json', users); }

// ── JSON helpers (arquivos na pasta "data") ────────────────────────────────────
function readJSONFile(filename, fallback) {
  try {
    const dataFolder = getOrCreateSubfolder(SUBFOLDER_NAMES.data);
    const it = dataFolder.getFilesByName(filename);
    if (!it.hasNext()) return fallback;
    const content = it.next().getBlob().getDataAsString();
    return JSON.parse(content);
  } catch (e) {
    Logger.log('readJSONFile error: ' + e.message);
    return fallback;
  }
}

function writeJSONFile(filename, data) {
  const content    = JSON.stringify(data, null, 2);
  const dataFolder = getOrCreateSubfolder(SUBFOLDER_NAMES.data);
  const it         = dataFolder.getFilesByName(filename);
  if (it.hasNext()) {
    // Atualiza arquivo existente
    it.next().setContent(content);
  } else {
    // Cria novo arquivo
    dataFolder.createFile(filename, content, MimeType.PLAIN_TEXT);
  }
}
