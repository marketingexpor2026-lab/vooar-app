const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── Banco de dados ────────────────────────────────────────────────────────────
const DB = require('./database.js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Diretório de uploads (usa STORAGE_DIR em produção na nuvem) ──────────────
const STORAGE_DIR  = process.env.STORAGE_DIR || __dirname;
const UPLOADS_BASE = path.join(STORAGE_DIR, 'uploads');
['images', 'videos', 'mind'].forEach(sub =>
  fs.mkdirSync(path.join(UPLOADS_BASE, sub), { recursive: true })
);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_BASE));

// ── Upload config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isMind  = file.originalname.endsWith('.mind');
    const isVideo = file.mimetype.startsWith('video/');
    const sub     = isMind ? 'mind' : isVideo ? 'videos' : 'images';
    cb(null, path.join(UPLOADS_BASE, sub));
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase() || '.bin'}`);
  }
});
const LIMIT_IMAGE_BYTES = 3  * 1024 * 1024;  //  3 MB
const LIMIT_VIDEO_BYTES = 60 * 1024 * 1024;  // 60 MB
const LIMIT_MIND_BYTES  = 60 * 1024 * 1024;  // 60 MB (arquivo .mind pode ser grande)

const upload = multer({
  storage,
  limits: { fileSize: LIMIT_VIDEO_BYTES },   // limite global = maior dos limites
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.endsWith('.mind')
      || /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)
      || /^video\/(mp4|webm|ogg|quicktime)$/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo não permitido'), ok);
  }
});

// ── Admin middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  // Aceita token via header (fetch/XHR) ou query param ?t= (EventSource não suporta headers)
  const token = req.headers['x-admin-token'] || req.query.t;
  if (token !== DB.ADMIN_TOKEN)
    return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ── SSE: clientes conectados ao painel admin ──────────────────────────────────
const sseClients = new Set();

function broadcastAdmin(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch { sseClients.delete(res); } });
}

// Broadcast de stats a cada 10s
setInterval(() => {
  if (sseClients.size === 0) return;
  broadcastAdmin('stats', DB.getStats());
}, 10_000);

// ═══════════════════════════════════════════════════════════════════════════════
//  ROTAS PÚBLICAS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Health check (SyncManager) ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), version: '2.0' });
});

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });

  const isMind  = req.file.originalname.endsWith('.mind');
  const isVideo = req.file.mimetype.startsWith('video/');
  const isImage = req.file.mimetype.startsWith('image/');

  // Validação de tamanho por tipo (proteção server-side)
  if (isImage && req.file.size > LIMIT_IMAGE_BYTES) {
    fs.unlink(req.file.path, () => {});
    return res.status(413).json({ error: `Imagem muito grande. Máximo permitido: 3 MB.` });
  }
  if ((isVideo || isMind) && req.file.size > LIMIT_VIDEO_BYTES) {
    fs.unlink(req.file.path, () => {});
    return res.status(413).json({ error: `Arquivo muito grande. Máximo permitido: 60 MB.` });
  }

  const folder = isMind ? 'mind' : isVideo ? 'videos' : 'images';
  const url    = `/uploads/${folder}/${req.file.filename}`;
  console.log(`[upload] ${req.file.originalname} → ${url} (${Math.round(req.file.size/1024)} KB)`);
  broadcastAdmin('upload', { filename: req.file.originalname, url, size: req.file.size });
  res.json({ ok: true, url, filename: req.file.filename, sizeKB: Math.round(req.file.size/1024) });
});

// ── Auth: login ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
  const user = DB.getUserByEmail(email.toLowerCase().trim());
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  res.json({ ok: true, user: { ...user, password: undefined } });
});

// ── Auth: cadastro ────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha mínima: 6 caracteres' });
  const exists = DB.getUserByEmail(email.toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'E-mail já cadastrado' });
  const user = DB.createUser({
    id: Date.now(), name, email: email.toLowerCase().trim(), password,
    plan: 'Free', createdAt: new Date().toISOString(),
  });
  broadcastAdmin('new_user', { name: user.name, email: user.email });
  res.json({ ok: true, user: { ...user, password: undefined } });
});

// ── Usuários (compatibilidade com index.html) ─────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(DB.getAllUsers().map(u => ({ ...u, password: undefined })));
});
app.post('/api/users', (req, res) => {
  const u = req.body;
  DB.updateUser(u.id, u);
  res.json({ ok: true });
});

// ── Limite de projetos do plano ───────────────────────────────────────────────
app.get('/api/plan-limits/:uid', (req, res) => {
  const user  = DB.getUserById(req.params.uid);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const limit   = DB.getProjectLimit(user.plan);
  const current = DB.countProjectsByUser(user.id);
  res.json({ plan: user.plan, limit, current, canCreate: current < limit });
});

// ── Projects ──────────────────────────────────────────────────────────────────
app.get('/api/projects/:uid', (req, res) => {
  res.json(DB.getProjectsByUser(req.params.uid));
});

app.get('/api/projects/:uid/:id', (req, res) => {
  const p = DB.getProjectById(req.params.uid, req.params.id);
  if (!p) return res.status(404).json({ error: 'Projeto não encontrado' });
  res.json(p);
});

app.post('/api/projects/:uid', (req, res) => {
  try {
    const project = req.body;
    const saved   = DB.upsertProject(req.params.uid, project);
    broadcastAdmin('project_update', {
      projectId: project.id,
      name:      project.name,
      userId:    req.params.uid,
      action:    'upsert',
    });
    res.json({ ok: true, project: saved });
  } catch(e) {
    console.error('[POST /api/projects] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:uid/:id', (req, res) => {
  DB.deleteProject(req.params.uid, req.params.id);
  broadcastAdmin('project_update', { projectId: req.params.id, userId: req.params.uid, action: 'delete' });
  res.json({ ok: true });
});

// Views
app.post('/api/projects/:uid/:id/view', (req, res) => {
  DB.incrementProjectViews(req.params.uid, req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ROTAS ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

// ── SSE: stream de eventos em tempo real ──────────────────────────────────────
app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx: desativa buffering
  res.flushHeaders();

  // Envia estado inicial
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  res.write(`event: stats\ndata: ${JSON.stringify(DB.getStats())}\n\n`);

  sseClients.add(res);
  console.log(`[SSE] Admin conectado (${sseClients.size} ativos)`);

  // Heartbeat a cada 25s (evita timeout de proxy)
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
  }, 25_000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(hb);
    console.log(`[SSE] Admin desconectado (${sseClients.size} ativos)`);
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(DB.getStats());
});

// ── Todos os usuários ─────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = DB.getAllUsers().map(u => ({
    ...u,
    password:     undefined,
    projectCount: DB.countProjectsByUser(u.id),
    limit:        DB.getProjectLimit(u.plan),
  }));
  res.json(users);
});

// ── Alterar plano do usuário ──────────────────────────────────────────────────
app.put('/api/admin/users/:id/plan', requireAdmin, (req, res) => {
  const { plan } = req.body;
  if (!DB.PLAN_LIMITS[plan]) return res.status(400).json({ error: 'Plano inválido' });
  if (String(req.params.id) === String(DB.ADMIN_ID))
    return res.status(400).json({ error: 'Admin sempre tem plano Developer' });
  DB.updateUser(req.params.id, { plan });
  broadcastAdmin('user_update', { userId: req.params.id, plan });
  res.json({ ok: true });
});

// ── Excluir usuário ───────────────────────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (String(req.params.id) === String(DB.ADMIN_ID))
    return res.status(400).json({ error: 'Não é possível excluir o admin' });
  DB.deleteUser(req.params.id);
  broadcastAdmin('user_deleted', { userId: req.params.id });
  res.json({ ok: true });
});

// ── Todos os projetos ─────────────────────────────────────────────────────────
app.get('/api/admin/projects', requireAdmin, (req, res) => {
  res.json(DB.getAllProjects());
});

// ── Excluir qualquer projeto ──────────────────────────────────────────────────
app.delete('/api/admin/projects/:uid/:id', requireAdmin, (req, res) => {
  DB.deleteProject(req.params.uid, req.params.id);
  broadcastAdmin('project_update', { projectId: req.params.id, userId: req.params.uid, action: 'delete' });
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const stats = DB.getStats();
  console.log(`
  ╔══════════════════════════════════════╗
  ║   VOOAR Server v2.0  —  Porta ${PORT}  ║
  ╠══════════════════════════════════════╣
  ║  Banco:     data/vooar.db (SQLite)   ║
  ║  Usuários:  ${String(stats.users).padEnd(27)}║
  ║  Projetos:  ${String(stats.projects).padEnd(27)}║
  ║  Admin:     joabe@vooar.dev          ║
  ╚══════════════════════════════════════╝
  `);
});
