const express = require('express');
const db = require('../database/db');

module.exports = function(metaAPI, optimizer, database, io) {
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

    router.put('/optimization/configs/:campaign_id', (req, res) => {
        const config = {
            campaign_id: req.params.campaign_id,
            ...req.body
        };
        const saved = db.saveCampaignConfig(config);
        res.json({ ok: true, config: saved });
    });

    router.delete('/optimization/configs/:campaign_id', (req, res) => {
        db.removeCampaignConfig(req.params.campaign_id);
        res.json({ ok: true });
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
