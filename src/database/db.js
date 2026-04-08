const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'optimizer.json');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');

let _db = null;

function getDefaultDb() {
    return {
        accounts: [],
        campaigns_config: [],
        optimization_log: [],
        tags: [],
        settings: {
            token: '',
            optimization_interval_minutes: 30,
            auto_optimize: false,
            timezone: 'America/Sao_Paulo',
            default_pause_behavior: 'flexible',
            default_scale_method: 'conservative'
        },
        _version: 1
    };
}

function getDb() {
    if (_db) return _db;

    try {
        if (fs.existsSync(DB_PATH)) {
            const raw = fs.readFileSync(DB_PATH, 'utf-8');
            _db = JSON.parse(raw);
        } else {
            _db = getDefaultDb();
            saveDb();
        }
    } catch (e) {
        console.error('[DB] Erro ao carregar banco:', e.message);
        _db = getDefaultDb();
        saveDb();
    }

    // Migrations
    if (!_db.accounts) _db.accounts = [];
    if (!_db.campaigns_config) _db.campaigns_config = [];
    if (!_db.optimization_log) _db.optimization_log = [];
    if (!_db.tags) _db.tags = [];
    if (!_db.settings) _db.settings = getDefaultDb().settings;
    if (!_db.settings.token) _db.settings.token = '';
    if (!_db.settings.default_pause_behavior) _db.settings.default_pause_behavior = 'flexible';
    if (!_db.settings.default_scale_method) _db.settings.default_scale_method = 'conservative';

    saveDb();
    return _db;
}

function saveDb() {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2), 'utf-8');
    } catch (e) {
        console.error('[DB] Erro ao salvar:', e.message);
    }
}

// ==================== ACCOUNTS ====================
function getAccounts() {
    return _db.accounts;
}

function addAccount(account) {
    const existing = _db.accounts.find(a => a.id === account.id);
    if (existing) {
        Object.assign(existing, account);
    } else {
        _db.accounts.push({
            id: account.id,
            name: account.name || '',
            currency: account.currency || 'BRL',
            timezone: account.timezone || '',
            status: account.status || 0,
            added_at: new Date().toISOString()
        });
    }
    saveDb();
}

function removeAccount(accountId) {
    _db.accounts = _db.accounts.filter(a => a.id !== accountId);
    _db.campaigns_config = _db.campaigns_config.filter(c => c.account_id !== accountId);
    saveDb();
}

// ==================== CAMPAIGN CONFIG ====================
function getCampaignConfigs(accountId) {
    if (accountId) {
        return _db.campaigns_config.filter(c => c.account_id === accountId);
    }
    return _db.campaigns_config;
}

function getCampaignConfig(campaignId) {
    return _db.campaigns_config.find(c => c.campaign_id === campaignId);
}

function saveCampaignConfig(config) {
    const idx = _db.campaigns_config.findIndex(c => c.campaign_id === config.campaign_id);
    const record = {
        campaign_id: config.campaign_id,
        campaign_name: config.campaign_name || '',
        account_id: config.account_id,
        pause_behavior: config.pause_behavior || 'flexible',
        scale_method: config.scale_method || 'conservative',
        max_cpa: config.max_cpa || 0,
        max_daily_budget_cbo: config.max_daily_budget_cbo || 0,
        unlimited_scale: config.unlimited_scale || false,
        enabled: config.enabled !== undefined ? config.enabled : true,
        updated_at: new Date().toISOString()
    };

    if (idx >= 0) {
        _db.campaigns_config[idx] = record;
    } else {
        record.created_at = new Date().toISOString();
        _db.campaigns_config.push(record);
    }
    saveDb();
    return record;
}

function removeCampaignConfig(campaignId) {
    _db.campaigns_config = _db.campaigns_config.filter(c => c.campaign_id !== campaignId);
    saveDb();
}

// ==================== OPTIMIZATION LOG ====================
function addOptimizationLog(entry) {
    const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        campaign_id: entry.campaign_id || '',
        campaign_name: entry.campaign_name || '',
        account_id: entry.account_id || '',
        object_type: entry.object_type || '',  // campaign, adset, ad
        object_id: entry.object_id || '',
        object_name: entry.object_name || '',
        action: entry.action || '',  // pause, activate, scale_horizontal, scale_vertical, reactivate, suffix
        reason: entry.reason || '',
        suffix: entry.suffix || '',
        details: entry.details || {},
        success: entry.success !== undefined ? entry.success : true,
        error: entry.error || null
    };
    _db.optimization_log.unshift(record);

    // Keep last 5000 entries
    if (_db.optimization_log.length > 5000) {
        _db.optimization_log = _db.optimization_log.slice(0, 5000);
    }
    saveDb();
    return record;
}

function getOptimizationLog(filters = {}) {
    let logs = _db.optimization_log;

    if (filters.campaign_id) {
        logs = logs.filter(l => l.campaign_id === filters.campaign_id);
    }
    if (filters.account_id) {
        logs = logs.filter(l => l.account_id === filters.account_id);
    }
    if (filters.action) {
        logs = logs.filter(l => l.action === filters.action);
    }
    if (filters.limit) {
        logs = logs.slice(0, filters.limit);
    }

    return logs;
}

function clearOptimizationLog(accountId) {
    if (accountId) {
        _db.optimization_log = _db.optimization_log.filter(l => l.account_id !== accountId);
    } else {
        _db.optimization_log = [];
    }
    saveDb();
}

// ==================== TAGS ====================
function getTags() {
    return _db.tags;
}

function addTag(tag) {
    if (!_db.tags.includes(tag)) {
        _db.tags.push(tag);
        saveDb();
    }
}

function removeTag(tag) {
    _db.tags = _db.tags.filter(t => t !== tag);
    saveDb();
}

// ==================== SETTINGS ====================
function getSettings() {
    return _db.settings;
}

function updateSettings(updates) {
    Object.assign(_db.settings, updates);
    saveDb();
    return _db.settings;
}

function getToken() {
    return _db.settings.token || '';
}

function setToken(token) {
    _db.settings.token = token;
    saveDb();
}

// ==================== BACKUP ====================
function backup() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `optimizer-${ts}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(_db, null, 2));

        // Keep max 10 backups
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('optimizer-'))
            .sort()
            .reverse();
        for (let i = 10; i < files.length; i++) {
            fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
        }
        console.log(`[DB] Backup salvo: ${backupPath}`);
    } catch (e) {
        console.error('[DB] Erro no backup:', e.message);
    }
}

module.exports = {
    getDb,
    saveDb,
    getAccounts,
    addAccount,
    removeAccount,
    getCampaignConfigs,
    getCampaignConfig,
    saveCampaignConfig,
    removeCampaignConfig,
    addOptimizationLog,
    getOptimizationLog,
    clearOptimizationLog,
    getTags,
    addTag,
    removeTag,
    getSettings,
    updateSettings,
    getToken,
    setToken,
    backup
};
