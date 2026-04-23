const express = require('express');
const db = require('../database/db');

module.exports = function(metaAPI, optimizer, database, io, scheduler) {
    const router = express.Router();

    // ==================== TOKEN / SETTINGS ====================
    router.get('/settings', (req, res) => {
        const settings = db.getSettings();
        // Mask token for security
        const masked = { ...settings };
        if (masked.token) {
            masked.token_preview = masked.token.slice(0, 10) + '...' + masked.token.slice(-5);
            masked.has_token = true;
        } else {
            masked.has_token = false;
        }
        delete masked.token;
        res.json(masked);
    });

    router.put('/settings', (req, res) => {
        const updates = req.body;
        // Don't allow direct token update through general settings
        delete updates.token;
        const settings = db.updateSettings(updates);
        res.json({ ok: true, settings });

        // Restart scheduler if auto_optimize changed
        if (updates.auto_optimize !== undefined || updates.optimization_interval_minutes !== undefined) {
            io.emit('settings_changed', { auto_optimize: settings.auto_optimize });
            // Restart scheduler to pick up new interval/toggle
            if (scheduler) {
                scheduler.restart();
                console.log('[API] Scheduler reiniciado com novas configuracoes');
            }
        }
    });

    router.put('/token', (req, res) => {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token obrigatorio' });
        db.setToken(token);
        res.json({ ok: true });
    });

    router.post('/token/validate', async (req, res) => {
        try {
            const accounts = await metaAPI.getAdAccounts();
            res.json({ ok: true, accounts });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== ACCOUNTS ====================
    router.get('/accounts', (req, res) => {
        res.json(db.getAccounts());
    });

    router.post('/accounts', (req, res) => {
        const account = req.body;
        if (!account.id) return res.status(400).json({ error: 'ID da conta obrigatorio' });
        db.addAccount(account);
        res.json({ ok: true });
    });

    router.delete('/accounts/:id', (req, res) => {
        db.removeAccount(req.params.id);
        res.json({ ok: true });
    });

    router.post('/accounts/discover', async (req, res) => {
        try {
            const accounts = await metaAPI.getAdAccounts();
            // Save all discovered accounts
            for (const acc of accounts) {
                db.addAccount({
                    id: acc.id,
                    name: acc.name,
                    currency: acc.currency,
                    timezone: acc.timezone_name,
                    status: acc.account_status
                });
            }
            res.json({ ok: true, accounts });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== CAMPAIGNS ====================
    router.get('/campaigns', async (req, res) => {
        try {
            const { account_id, status } = req.query;
            if (!account_id) return res.status(400).json({ error: 'account_id obrigatorio' });

            const campaigns = await metaAPI.getCampaigns(account_id, {
                status: status ? status.split(',') : undefined
            });

            // Attach local config if exists
            const enriched = campaigns.map(c => {
                const config = db.getCampaignConfig(c.id);
                return { ...c, optimization_config: config || null };
            });

            res.json(enriched);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/campaigns/:id', async (req, res) => {
        try {
            const campaign = await metaAPI.getCampaignDetails(req.params.id);
            const config = db.getCampaignConfig(req.params.id);
            res.json({ ...campaign, optimization_config: config || null });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/campaigns/:id/adsets', async (req, res) => {
        try {
            const adsets = await metaAPI.getAdSets(null, {
                campaign_id: req.params.id,
                status: req.query.status ? req.query.status.split(',') : undefined
            });
            res.json(adsets);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/campaigns/:id/ads', async (req, res) => {
        try {
            const ads = await metaAPI.getAds(null, { campaign_id: req.params.id });
            res.json(ads);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== INSIGHTS ====================
    router.get('/insights/:id', async (req, res) => {
        try {
            const { date_preset, level } = req.query;
            const insights = await metaAPI.getInsights(req.params.id, {
                date_preset: date_preset || 'last_7d',
                level: level || undefined
            });
            res.json(insights);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/insights/:id/multi', async (req, res) => {
        try {
            const windows = req.query.windows ?
                req.query.windows.split(',') :
                ['today', 'last_3d', 'last_7d', 'last_14d', 'last_30d'];
            const data = await metaAPI.getMultiWindowInsights(req.params.id, windows);
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== OPTIMIZATION CONFIG ====================
    router.get('/optimization/configs', (req, res) => {
        const { account_id } = req.query;
        res.json(db.getCampaignConfigs(account_id));
    });

    router.get('/optimization/configs/:campaign_id', (req, res) => {
        const config = db.getCampaignConfig(req.params.campaign_id);
        if (!config) return res.status(404).json({ error: 'Config nao encontrada' });
        res.json(config);
    });

    router.put('/optimization/configs/:campaign_id', async (req, res) => {
        const campaignId = req.params.campaign_id;
        const config = {
            campaign_id: campaignId,
            ...req.body
        };

        // Check previous state to detect enable/disable transition
        const prevConfig = db.getCampaignConfig(campaignId);
        const wasEnabled = prevConfig ? prevConfig.enabled : false;
        const isEnabled = config.enabled;

        const saved = db.saveCampaignConfig(config);
        res.json({ ok: true, config: saved });

        // Update campaign nomenclature [KS ON] prefix
        try {
            if (isEnabled) {
                // Ensure prefix exists (idempotent - won't duplicate)
                await optimizer.addKsOnPrefix(campaignId);
            } else if (!isEnabled && wasEnabled) {
                // Just disabled → remove prefix
                await optimizer.removeKsOnPrefix(campaignId);
            }
        } catch (e) {
            console.error(`[API] Erro ao atualizar prefix KS ON:`, e.message);
        }
    });

    router.delete('/optimization/configs/:campaign_id', async (req, res) => {
        const campaignId = req.params.campaign_id;
        const prevConfig = db.getCampaignConfig(campaignId);

        db.removeCampaignConfig(campaignId);
        res.json({ ok: true });

        // Remove [KS ON] prefix if was enabled
        if (prevConfig && prevConfig.enabled) {
            try {
                await optimizer.removeKsOnPrefix(campaignId);
            } catch (e) {
                console.error(`[API] Erro ao remover prefix KS ON:`, e.message);
            }
        }
    });

    // Sync [KS ON] prefix for all enabled campaigns
    router.post('/optimization/sync-prefix', async (req, res) => {
        try {
            const configs = db.getCampaignConfigs().filter(c => c.enabled);
            let synced = 0;
            for (const config of configs) {
                try {
                    await optimizer.addKsOnPrefix(config.campaign_id);
                    synced++;
                } catch (e) {
                    console.error(`[API] Sync prefix erro ${config.campaign_id}:`, e.message);
                }
            }
            res.json({ ok: true, synced, total: configs.length });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== OPTIMIZATION EXECUTION ====================
    router.post('/optimization/run/:campaign_id', async (req, res) => {
        try {
            if (optimizer.isRunning()) {
                return res.status(409).json({ error: 'Otimizacao ja em execucao' });
            }

            // Don't await - run in background
            const campaignId = req.params.campaign_id;
            res.json({ ok: true, message: 'Otimizacao iniciada' });

            const result = await optimizer.optimizeCampaign(campaignId);
            io.emit('optimization_result', result);
        } catch (e) {
            io.emit('optimization_error', { error: e.message });
        }
    });

    router.post('/optimization/run-all', async (req, res) => {
        try {
            if (optimizer.isRunning()) {
                return res.status(409).json({ error: 'Otimizacao ja em execucao' });
            }

            res.json({ ok: true, message: 'Otimizacao de todas as campanhas iniciada' });

            const results = await optimizer.optimizeAll();
            io.emit('optimization_all_complete', results);
        } catch (e) {
            io.emit('optimization_error', { error: e.message });
        }
    });

    router.get('/optimization/status', (req, res) => {
        res.json({
            running: optimizer.isRunning(),
            last_run: optimizer.getLastRun(),
            results: optimizer.getResults()
        });
    });

    // ==================== OPTIMIZATION LOG ====================
    router.get('/optimization/log', (req, res) => {
        const { campaign_id, account_id, action, limit } = req.query;
        const logs = db.getOptimizationLog({
            campaign_id,
            account_id,
            action,
            limit: parseInt(limit) || 100
        });
        res.json(logs);
    });

    router.delete('/optimization/log', (req, res) => {
        const { account_id } = req.query;
        db.clearOptimizationLog(account_id);
        res.json({ ok: true });
    });

    // ==================== TAGS ====================
    router.get('/tags', (req, res) => {
        res.json(db.getTags());
    });

    router.post('/tags', (req, res) => {
        const { tag } = req.body;
        if (!tag) return res.status(400).json({ error: 'Tag obrigatoria' });
        db.addTag(tag);
        res.json({ ok: true });
    });

    router.delete('/tags/:tag', (req, res) => {
        db.removeTag(decodeURIComponent(req.params.tag));
        res.json({ ok: true });
    });

    // ==================== ENTRIES CACHE (server-side batch fetch) ====================
    // Refresh every 30s, serves all instances from memory
    if (!global._entriesCache) {
        global._entriesCache = { data: {}, lastFetch: 0, fetching: false };
    }

    const INSTANCES_LIST = [
        'hudson-oliveira','junior-automotiva','achados-secretos','ofertas-da-jenni',
        'Melhores-Promocoes','achadinhos-do-gilioli','sabaziuscp','promocoes-do-dia',
        'achadinhos-da-dri','achadinhos-do-borogodo','ze-ofertas','garimpo-da-mamae',
        'dicas-da-ca','promocoes-do-dia1','promo-da-dinda','achadinhos-para-pobre',
        'achadinho_para_pobres','achadinhos-da-tata','achadinhos-imbativel',
        'achadinhos-da-anna','promo-da-oportunidade','achadinhos-da-li'
    ];

    async function refreshEntriesCache() {
        if (global._entriesCache.fetching) return;
        global._entriesCache.fetching = true;
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

        const newData = { today: {}, yesterday: {} };
        // Sequential to avoid rate limits (21 instances × 2 periods × ~500ms = ~21s)
        for (const inst of INSTANCES_LIST) {
            for (const period of [['today', today], ['yesterday', yesterday]]) {
                try {
                    const url = `https://production.salesecommerce.com.br/api/v1/whatsappweb/cpl/metrics/summary?instanceName=${inst}&from=${period[1]}&to=${period[1]}`;
                    const resp = await fetch(url, { headers: { 'x-api-key': 'bot_dfe7011d0bcf2c3e4b26b6be9be125fc' } });
                    const d = await resp.json();
                    newData[period[0]][inst] = d.totals || d.instances?.[0] || {};
                } catch (e) {
                    newData[period[0]][inst] = newData[period[0]][inst] || {};
                }
                await new Promise(r => setTimeout(r, 150));
            }
        }
        global._entriesCache.data = newData;
        global._entriesCache.lastFetch = Date.now();
        global._entriesCache.fetching = false;
        console.log(`[EntriesCache] Refreshed ${INSTANCES_LIST.length} instances`);
    }

    // Initial + auto-refresh
    refreshEntriesCache();
    setInterval(refreshEntriesCache, 60 * 1000); // every 60 seconds

    router.get('/entries-cache', (req, res) => {
        const period = req.query.period === 'yesterday' ? 'yesterday' : 'today';
        res.json({
            data: global._entriesCache.data[period] || {},
            lastFetch: global._entriesCache.lastFetch,
            cached: true
        });
    });

    // ==================== SALESECOMMERCE API (real group entries) ====================
    const SE_BASE = 'https://production.salesecommerce.com.br';
    const SE_KEY = 'bot_dfe7011d0bcf2c3e4b26b6be9be125fc';

    router.get('/entries/:instanceName', async (req, res) => {
        try {
            const { from, to } = req.query;
            const instance = req.params.instanceName;
            const url = `${SE_BASE}/api/v1/whatsappweb/cpl/metrics/summary?instanceName=${instance}&from=${from || ''}&to=${to || ''}`;
            const resp = await fetch(url, { headers: { 'x-api-key': SE_KEY } });
            const data = await resp.json();
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== LIVE LEAD FEED ====================
    // In-memory buffer of recent events (last 200)
    if (!global._leadFeed) global._leadFeed = [];

    // Receive events from n8n webhook
    router.post('/webhook/feed-leads', (req, res) => {
        const event = {
            ...req.body,
            received_at: new Date().toISOString()
        };
        global._leadFeed.unshift(event);
        if (global._leadFeed.length > 200) global._leadFeed = global._leadFeed.slice(0, 200);

        // Emit via WebSocket for real-time display
        if (io) io.emit('lead_event', event);

        res.json({ ok: true });
    });

    // Get current feed (for initial load)
    router.get('/webhook/feed-leads', (req, res) => {
        res.json(global._leadFeed || []);
    });

    // Get full campaign groups list (for management UI)
    router.get('/campaign-groups/:instanceName', async (req, res) => {
        try {
            const url = `${SE_BASE}/api/v1/whatsappweb/cpl/campaigngroups/${req.params.instanceName}`;
            const resp = await fetch(url, { headers: { 'x-api-key': SE_KEY } });
            const data = await resp.json();
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Update hasMetric for groups (batch)
    router.patch('/campaign-groups/:instanceName/hasMetric', async (req, res) => {
        try {
            const url = `${SE_BASE}/api/v1/whatsappweb/groups/${req.params.instanceName}/hasMetric`;
            const resp = await fetch(url, {
                method: 'PATCH',
                headers: { 'x-api-key': SE_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body)
            });
            const data = await resp.json();
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/members/:instanceName', async (req, res) => {
        try {
            const instance = req.params.instanceName;
            const url = `${SE_BASE}/api/v1/whatsappweb/cpl/campaigngroups/${instance}`;
            const resp = await fetch(url, { headers: { 'x-api-key': SE_KEY } });
            const data = await resp.json();
            // Sum ONLY groups with hasMetric: true (real operation groups)
            let totalMembers = 0, validGroups = 0, totalGroups = 0;
            if (Array.isArray(data)) {
                for (const campaign of data) {
                    if (campaign.groups && Array.isArray(campaign.groups)) {
                        for (const g of campaign.groups) {
                            totalGroups++;
                            if (g.hasMetric === true) {
                                totalMembers += g.participantCount || 0;
                                validGroups++;
                            }
                        }
                    }
                }
            }
            res.json({ totalMembers, validGroups, totalGroups, campaigns: Array.isArray(data) ? data.length : 0 });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/entries', async (req, res) => {
        try {
            const { from, to } = req.query;
            const url = `${SE_BASE}/api/v1/whatsappweb/cpl/metrics/summary?from=${from || ''}&to=${to || ''}`;
            const resp = await fetch(url, { headers: { 'x-api-key': SE_KEY } });
            const data = await resp.json();
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== DASHBOARD METRICS ====================
    router.get('/dashboard/:account_id', async (req, res) => {
        try {
            const accountId = req.params.account_id;
            const { date_preset } = req.query;

            // Get account-level insights
            const insights = await metaAPI.getInsights(accountId, {
                date_preset: date_preset || 'last_7d',
                level: 'account'
            });

            const metrics = insights[0] ? MetaAPI.parseMetrics(insights[0]) : null;

            // Get campaign count
            const campaigns = await metaAPI.getCampaigns(accountId, { status: ['ACTIVE'] });

            res.json({
                metrics,
                active_campaigns: campaigns.length,
                raw: insights[0] || null
            });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== QUICK ACTIONS ====================
    router.post('/actions/pause/:id', async (req, res) => {
        try {
            await metaAPI.updateStatus(req.params.id, 'PAUSED');
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.post('/actions/activate/:id', async (req, res) => {
        try {
            await metaAPI.updateStatus(req.params.id, 'ACTIVE');
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.post('/actions/budget/:id', async (req, res) => {
        try {
            const { budget } = req.body;
            if (!budget) return res.status(400).json({ error: 'Budget obrigatorio' });
            await metaAPI.updateBudget(req.params.id, parseFloat(budget));
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
};
