const BUILD_VERSION = '1.0.0-20260408';
console.log(`\n========================================`);
console.log(`  KS Optimizer v${BUILD_VERSION}`);
console.log(`  Started at: ${new Date().toISOString()}`);
console.log(`========================================\n`);

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./src/database/db');
const MetaAPI = require('./src/meta/api');
const Optimizer = require('./src/meta/optimizer');
const apiRoutes = require('./src/routes/api');
const setupWebSocket = require('./src/routes/websocket');
const Scheduler = require('./src/scheduler');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// ==================== AUTH CONFIG ====================
const USERS = [
    { email: 'souzamktonline@gmail.com', password: 'K@zame12', name: 'Gabriel' },
    { email: 'sabaziuscp@gmail.com', password: 'Net@2019@', name: 'Mario' }
];
const sessions = new Map();

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(c => {
        const [key, val] = c.trim().split('=');
        if (key && val) cookies[key] = val;
    });
    return cookies;
}

function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.auth_token;
    if (!token || !sessions.has(token)) return false;
    if (sessions.get(token).expiry < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

// Middleware
app.use(express.json());

// Login endpoint
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = USERS.find(u => u.email === email && u.password === password);
    if (user) {
        const token = generateToken();
        const expiry = Date.now() + (7 * 24 * 60 * 60 * 1000);
        sessions.set(token, { expiry, name: user.name });
        res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`);
        return res.json({ ok: true, name: user.name });
    }
    res.status(401).json({ error: 'Credenciais invalidas' });
});

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Auth middleware
app.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/login.html' || req.path === '/api/login' || req.path === '/ks-logo.png' || req.path === '/css/style.css') {
        return next();
    }
    if (!isAuthenticated(req)) {
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
            return res.status(401).json({ error: 'Nao autorizado' });
        }
        return res.redirect('/login');
    }
    const cookies = parseCookies(req.headers.cookie);
    const session = sessions.get(cookies.auth_token);
    if (session) req.userName = session.name;
    next();
});

// Logout
app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.auth_token) sessions.delete(cookies.auth_token);
    res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Initialize components
const database = db.getDb();
const metaAPI = new MetaAPI(database);
const optimizer = new Optimizer(metaAPI, database, io);
const scheduler = new Scheduler(optimizer, database, io);

// Routes
app.use('/api', apiRoutes(metaAPI, optimizer, database, io, scheduler));

// WebSocket auth
io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const cookies = parseCookies(cookieHeader);
    const token = cookies.auth_token;
    if (token && sessions.has(token) && sessions.get(token).expiry > Date.now()) {
        return next();
    }
    next(new Error('Nao autorizado'));
});

// WebSocket
setupWebSocket(io, metaAPI, optimizer, database);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log('');
    console.log('=========================================');
    console.log('   KS OPTIMIZER - META ADS');
    console.log('=========================================');
    console.log(`   Dashboard: http://localhost:${PORT}`);
    console.log('=========================================');
    console.log('');

    console.log('[DB] Banco de dados inicializado');

    // Start scheduler
    scheduler.start();
    console.log('[Scheduler] Agendador de otimizacao iniciado');

    console.log('');
});

process.on('SIGINT', () => {
    console.log('\n[Server] Desligando...');
    scheduler.stop();
    process.exit(0);
});
