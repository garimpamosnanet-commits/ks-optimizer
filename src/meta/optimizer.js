/**
 * KS Optimizer - Optimization Engine
 *
 * Implements 4 profiles:
 * - Pausa Rigorosa: Low tolerance, pauses aggressively
 * - Pausa Flexivel: Higher tolerance, more chances
 * - Escala Acelerada: Aggressive scaling (horizontal + vertical)
 * - Escala Conservadora: Conservative scaling (vertical only, smaller increments)
 *
 * Suffix system for transparency on every action taken.
 */

const MetaAPI = require('./api');
const db = require('../database/db');

// ==================== SUFFIX DEFINITIONS ====================
const SUFFIXES = {
    // Pausas por Falta de Conversao
    PAUSE_NEVER_CONVERTED: ' | Pausado nunca converteu',
    PAUSE_NO_CONV_14D: ' | Pausado sem conversoes 14 dias',
    PAUSE_NO_CONV_7D: ' | Pausado sem conversoes 7 dias',
    PAUSE_NO_CONV_3D: ' | Pausado sem conversoes 3 dias',
    PAUSE_NO_CONV_NO_CHECKOUT: ' | Pausado sem conversoes e sem checkout',
    PAUSE_NO_CONV_CPC_EXPENSIVE: ' | Pausado sem conversoes e CPC caro',

    // Pausas por Perda de Performance
    PAUSE_MAX_CPA: ' | Pausado CPA maximo',
    PAUSE_PERF_LOSS_14D: ' | Pausado perda de performance 14 dias',
    PAUSE_PERF_LOSS_7D: ' | Pausado perda de performance 7 dias',
    PAUSE_PERF_LOSS_3D: ' | Pausado perda de performance 3 dias',
    PAUSE_EXTREME_CPA: ' | Pausado CPA extremo ultimos dias',
    PAUSE_CHECKOUT_EXPENSIVE: ' | Pausado checkout caro',

    // Pausas Temporarias (auto-reactivate at midnight)
    TEMP_PAUSE_CPA_TODAY: ' | Pausado temporariamente CPA hoje',
    TEMP_PAUSE_CPA_3D: ' | Pausado temporariamente CPA 3d',
    TEMP_PAUSE_CPA_7D: ' | Pausado temporariamente CPA 7d',
    TEMP_PAUSE_NO_CONV_TODAY: ' | Pausado temporariamente sem conversoes hoje',
    TEMP_PAUSE_NO_CONV_3D: ' | Pausado temporariamente sem conversoes 3d',
    TEMP_PAUSE_NO_CONV_7D: ' | Pausado temporariamente sem conversoes 7d',
    TEMP_PAUSE_NO_CHECKOUT_TODAY: ' | Pausado temporariamente sem checkout hoje',
    TEMP_PAUSE_CHECKOUT_EXPENSIVE: ' | Pausado temporariamente checkout caro',
    TEMP_PAUSE_MAXIMIZING: ' | Pausado temporariamente maximizando campanha hoje',

    // Reativacao
    REACTIVATE_LATE_CONV: ' | Reativado conversao tardia',
    REACTIVATE_SECONDARY: ' | Reativacao metricas secundarias tardias',

    // Escala
    SCALE_HORIZONTAL: ' | Escala horizontal',
    SCALE_HORIZONTAL_VALIDATED: ' | Escala horizontal Conjunto Validado',
    SCALE_VERTICAL_AGGRESSIVE: ' | Escala vertical agressiva',
    SCALE_VERTICAL: ' | Escala vertical',
    SCALE_SURFING: ' | Surfando conversoes hoje',
    REPLICA_VALIDATED: ' [Replica de Conjunto Validado]',

    // Ativacao
    ACTIVATE_PAUSED_AD: ' | Ativacao de Anuncio Pausado',

    // Outras
    TOP_ADS_VALIDATED: ' | Top Anuncios em conjunto validado',
    BEST_ADS_ISOLATED: ' | Melhores Anuncios Isolados',
    TOP_ADS_ISOLATED: ' | Top Anuncios Isolados',
    REPLICA_REVALIDATION: ' [Replica de Revalidacao]',
    REDUCTION_LOW_PERF: ' | Reducao por baixa performance',
    REDUCTION_CPA_TODAY: ' | Reducao CPA hoje',
    REDUCTION_HIGH_FREQ: ' | Reducao por alta frequencia',
    CORRECTION_MAX_BUDGET: ' | Correcao Orcamento Maximo'
};

// Prefixo de campanha ativa no otimizador
const KS_ON_PREFIX = '[KS ON] ';

// Tags de Controle
const CONTROL_TAGS = {
    MANUAL: '[manual]',
    NO_DUPLICATE: '[nao duplicar]',
    ACTIVE_DAILY: '[ativo diariamente]'
};

class Optimizer {
    constructor(metaAPI, database, io) {
        this.api = metaAPI;
        this.io = io;
        this._running = false;
        this._lastRun = null;
        this._results = {};
    }

    isRunning() {
        return this._running;
    }

    getLastRun() {
        return this._lastRun;
    }

    getResults() {
        return this._results;
    }

    /**
     * Run optimization for a single campaign
     */
    async optimizeCampaign(campaignId) {
        const config = db.getCampaignConfig(campaignId);
        if (!config) throw new Error(`Configuracao nao encontrada para campanha ${campaignId}`);
        if (!config.enabled) throw new Error(`Otimizacao desabilitada para campanha ${campaignId}`);

        this._running = true;
        const startTime = Date.now();
        const results = {
            campaign_id: campaignId,
            campaign_name: config.campaign_name,
            account_id: config.account_id,
            actions: [],
            errors: [],
            metrics: {},
            started_at: new Date().toISOString()
        };

        this._emitProgress(campaignId, 'started', `Iniciando otimizacao: ${config.campaign_name}`);

        try {
            // 1. Fetch campaign data
            this._emitProgress(campaignId, 'fetching', 'Buscando dados da campanha...');
            const campaign = await this.api.getCampaignDetails(campaignId);

            // 2. Fetch all ad sets
            this._emitProgress(campaignId, 'fetching', 'Buscando conjuntos de anuncios...');
            const adSets = await this.api.getAdSets(config.account_id, {
                campaign_id: campaignId,
                status: ['ACTIVE', 'PAUSED']
            });

            // 3. Fetch insights for each ad set (multi-window)
            this._emitProgress(campaignId, 'analyzing', `Analisando ${adSets.length} conjuntos...`);

            const adSetData = [];
            for (const adSet of adSets) {
                const insights = await this.api.getMultiWindowInsights(adSet.id, ['today', 'last_3d', 'last_7d', 'last_14d', 'last_30d']);
                const ads = await this.api.getAds(config.account_id, { adset_id: adSet.id });

                // Fetch insights for each ad
                const adData = [];
                for (const ad of ads) {
                    const adInsights = await this.api.getMultiWindowInsights(ad.id, ['today', 'last_3d', 'last_7d']);
                    adData.push({
                        ...ad,
                        insights: adInsights,
                        metrics: {
                            today: MetaAPI.parseMetrics(adInsights.today),
                            last_3d: MetaAPI.parseMetrics(adInsights.last_3d),
                            last_7d: MetaAPI.parseMetrics(adInsights.last_7d)
                        }
                    });
                }

                adSetData.push({
                    ...adSet,
                    insights,
                    metrics: {
                        today: MetaAPI.parseMetrics(insights.today),
                        last_3d: MetaAPI.parseMetrics(insights.last_3d),
                        last_7d: MetaAPI.parseMetrics(insights.last_7d),
                        last_14d: MetaAPI.parseMetrics(insights.last_14d),
                        last_30d: MetaAPI.parseMetrics(insights.last_30d)
                    },
                    ads: adData
                });
            }

            // 4. Calculate campaign averages (dynamic thresholds)
            const campaignInsights = await this.api.getMultiWindowInsights(campaignId, ['today', 'last_3d', 'last_7d', 'last_14d', 'last_30d']);
            const campaignMetrics = {
                today: MetaAPI.parseMetrics(campaignInsights.today),
                last_3d: MetaAPI.parseMetrics(campaignInsights.last_3d),
                last_7d: MetaAPI.parseMetrics(campaignInsights.last_7d),
                last_14d: MetaAPI.parseMetrics(campaignInsights.last_14d),
                last_30d: MetaAPI.parseMetrics(campaignInsights.last_30d)
            };

            results.metrics = campaignMetrics;

            // 5. Apply optimization rules
            this._emitProgress(campaignId, 'optimizing', 'Aplicando regras de otimizacao...');

            // First pass: Check for reactivation (late conversions)
            for (const adSet of adSetData) {
                if (adSet.status === 'PAUSED') {
                    const reactivation = this._checkReactivation(adSet, config);
                    if (reactivation) {
                        results.actions.push(reactivation);
                    }
                }

                for (const ad of adSet.ads) {
                    if (ad.status === 'PAUSED') {
                        const reactivation = this._checkReactivation(ad, config, 'ad');
                        if (reactivation) {
                            results.actions.push(reactivation);
                        }
                    }
                }
            }

            // Second pass: Pause rules for active items
            for (const adSet of adSetData) {
                if (adSet.status !== 'ACTIVE') continue;

                // Check control tags
                if (this._hasControlTag(adSet.name, CONTROL_TAGS.MANUAL)) continue;

                // Check ad set pause rules
                const pauseAction = this._checkPauseRules(adSet, config, campaignMetrics, 'adset');
                if (pauseAction) {
                    results.actions.push(pauseAction);
                    continue; // Don't check ads if adset is being paused
                }

                // Check individual ads
                for (const ad of adSet.ads) {
                    if (ad.status !== 'ACTIVE') continue;
                    if (this._hasControlTag(ad.name, CONTROL_TAGS.MANUAL)) continue;

                    const adPause = this._checkPauseRules(ad, config, campaignMetrics, 'ad');
                    if (adPause) {
                        results.actions.push(adPause);
                    }
                }
            }

            // Third pass: Scale rules for performing items
            for (const adSet of adSetData) {
                if (adSet.status !== 'ACTIVE') continue;
                if (this._hasControlTag(adSet.name, CONTROL_TAGS.MANUAL)) continue;
                if (this._hasControlTag(adSet.name, CONTROL_TAGS.NO_DUPLICATE)) continue;

                const scaleAction = this._checkScaleRules(adSet, config, campaignMetrics, campaign);
                if (scaleAction) {
                    results.actions.push(scaleAction);
                }
            }

            // 6. Execute actions
            this._emitProgress(campaignId, 'executing', `Executando ${results.actions.length} acoes...`);

            for (const action of results.actions) {
                try {
                    await this._executeAction(action, config);
                    action.executed = true;
                    action.executed_at = new Date().toISOString();

                    // Log to database
                    db.addOptimizationLog({
                        campaign_id: campaignId,
                        campaign_name: config.campaign_name,
                        account_id: config.account_id,
                        object_type: action.object_type,
                        object_id: action.object_id,
                        object_name: action.object_name,
                        action: action.type,
                        reason: action.reason,
                        suffix: action.suffix || '',
                        details: action.details || {},
                        success: true
                    });

                    this._emitProgress(campaignId, 'action', `${action.type}: ${action.object_name} - ${action.reason}`);
                } catch (e) {
                    action.executed = false;
                    action.error = e.message;
                    results.errors.push({ action, error: e.message });

                    db.addOptimizationLog({
                        campaign_id: campaignId,
                        campaign_name: config.campaign_name,
                        account_id: config.account_id,
                        object_type: action.object_type,
                        object_id: action.object_id,
                        object_name: action.object_name,
                        action: action.type,
                        reason: action.reason,
                        success: false,
                        error: e.message
                    });
                }
            }

            results.completed_at = new Date().toISOString();
            results.duration_ms = Date.now() - startTime;
            results.total_actions = results.actions.length;
            results.successful_actions = results.actions.filter(a => a.executed).length;
            results.failed_actions = results.errors.length;

            this._emitProgress(campaignId, 'completed',
                `Concluido: ${results.successful_actions} acoes executadas, ${results.failed_actions} erros`
            );

        } catch (e) {
            results.error = e.message;
            results.completed_at = new Date().toISOString();
            this._emitProgress(campaignId, 'error', `Erro: ${e.message}`);
        }

        this._running = false;
        this._lastRun = new Date().toISOString();
        this._results[campaignId] = results;

        return results;
    }

    /**
     * Run optimization for all enabled campaigns
     */
    async optimizeAll() {
        const configs = db.getCampaignConfigs().filter(c => c.enabled);
        const results = [];

        for (const config of configs) {
            try {
                const result = await this.optimizeCampaign(config.campaign_id);
                results.push(result);
            } catch (e) {
                results.push({
                    campaign_id: config.campaign_id,
                    campaign_name: config.campaign_name,
                    error: e.message
                });
            }
        }

        return results;
    }

    /**
     * Reset temporary pauses (run at midnight)
     */
    async resetTemporaryPauses() {
        const configs = db.getCampaignConfigs().filter(c => c.enabled);
        const tempSuffixes = [
            SUFFIXES.TEMP_PAUSE_CPA_TODAY,
            SUFFIXES.TEMP_PAUSE_CPA_3D,
            SUFFIXES.TEMP_PAUSE_CPA_7D,
            SUFFIXES.TEMP_PAUSE_NO_CONV_TODAY,
            SUFFIXES.TEMP_PAUSE_NO_CONV_3D,
            SUFFIXES.TEMP_PAUSE_NO_CONV_7D,
            SUFFIXES.TEMP_PAUSE_NO_CHECKOUT_TODAY,
            SUFFIXES.TEMP_PAUSE_CHECKOUT_EXPENSIVE,
            SUFFIXES.TEMP_PAUSE_MAXIMIZING
        ];

        let reactivated = 0;

        for (const config of configs) {
            try {
                const adSets = await this.api.getAdSets(config.account_id, {
                    campaign_id: config.campaign_id,
                    status: ['PAUSED']
                });

                for (const adSet of adSets) {
                    const hasTempSuffix = tempSuffixes.some(s => adSet.name.includes(s.trim()));
                    if (hasTempSuffix) {
                        // Remove suffix and reactivate
                        let cleanName = adSet.name;
                        for (const suffix of tempSuffixes) {
                            cleanName = cleanName.replace(suffix, '');
                        }

                        await this.api.updateName(adSet.id, cleanName.trim());
                        await this.api.updateStatus(adSet.id, 'ACTIVE');
                        reactivated++;

                        db.addOptimizationLog({
                            campaign_id: config.campaign_id,
                            campaign_name: config.campaign_name,
                            account_id: config.account_id,
                            object_type: 'adset',
                            object_id: adSet.id,
                            object_name: adSet.name,
                            action: 'reactivate_midnight',
                            reason: 'Reset de pausa temporaria (meia-noite)',
                            success: true
                        });
                    }
                }

                // Also check ads
                const ads = await this.api.getAds(config.account_id, {
                    campaign_id: config.campaign_id,
                    status: ['PAUSED']
                });

                for (const ad of ads) {
                    const hasTempSuffix = tempSuffixes.some(s => ad.name.includes(s.trim()));
                    if (hasTempSuffix) {
                        let cleanName = ad.name;
                        for (const suffix of tempSuffixes) {
                            cleanName = cleanName.replace(suffix, '');
                        }

                        await this.api.updateName(ad.id, cleanName.trim());
                        await this.api.updateStatus(ad.id, 'ACTIVE');
                        reactivated++;
                    }
                }
            } catch (e) {
                console.error(`[Optimizer] Erro reset temp pauses ${config.campaign_name}:`, e.message);
            }
        }

        console.log(`[Optimizer] Reset meia-noite: ${reactivated} itens reativados`);
        return reactivated;
    }

    // ==================== PAUSE RULES ====================
    _checkPauseRules(item, config, campaignMetrics, objectType) {
        const metrics = item.metrics || {};
        const maxCPA = config.max_cpa;
        const isRigorous = config.pause_behavior === 'rigorous';

        // Calculate thresholds based on campaign averages (dynamic)
        const avgCPA7d = campaignMetrics.last_7d?.cpa || maxCPA;
        const avgCPC7d = campaignMetrics.last_7d?.cpc || 999;

        const m30d = metrics.last_30d;
        const m14d = metrics.last_14d;
        const m7d = metrics.last_7d;
        const m3d = metrics.last_3d;
        const mToday = metrics.today;

        // === 24H PROTECTION ===
        // Don't touch anything in the first 24 hours — learning phase
        const createdTime = item.created_time ? new Date(item.created_time) : null;
        if (createdTime) {
            const hoursActive = (Date.now() - createdTime.getTime()) / (1000 * 60 * 60);
            if (hoursActive < 24) {
                return null; // First 24h, let it learn
            }
        }

        // === MINIMUM SPEND GUARD ===
        // Don't evaluate any pause rules until adset has meaningful data
        const minSpendForRules = Math.max(maxCPA * 5, 10); // At least 5x CPA or R$10
        const totalSpend7d = m7d ? m7d.spend : 0;
        if (totalSpend7d < minSpendForRules) {
            return null; // Not enough data yet, let it run
        }

        // === FALTA DE CONVERSAO ===

        // Rule 1: Never converted (3+ days active, 0 conversions, significant spend)

        if (m7d && m7d.spend > maxCPA * 2 && m7d.conversions === 0 && m7d.checkouts === 0) {
            return this._createPauseAction(item, objectType, 'pause_never_converted',
                SUFFIXES.PAUSE_NEVER_CONVERTED,
                `Nunca converteu (spend R$${m7d.spend.toFixed(2)}, 0 conversoes em 7 dias)`
            );
        }

        // Rule 2: No conversions in 14 days (had conversions before)
        if (m14d && m14d.conversions === 0 && m14d.spend > maxCPA * 3 && m30d && m30d.conversions > 0) {
            return this._createPauseAction(item, objectType, 'pause_no_conv_14d',
                SUFFIXES.PAUSE_NO_CONV_14D,
                `Sem conversoes ha 14 dias (gastou R$${m14d.spend.toFixed(2)})`
            );
        }

        // Rule 3: No conversions in 7 days (rigorous) or 14 days (flexible)
        if (isRigorous && m7d && m7d.conversions === 0 && m7d.spend > maxCPA * 2) {
            return this._createPauseAction(item, objectType, 'pause_no_conv_7d',
                SUFFIXES.PAUSE_NO_CONV_7D,
                `Sem conversoes ha 7 dias (spend R$${m7d.spend.toFixed(2)}) [Rigorosa]`
            );
        }

        // Rule 4: No conversions + no checkout
        if (m7d && m7d.conversions === 0 && m7d.checkouts === 0 && m7d.spend > maxCPA * 1.5) {
            return this._createPauseAction(item, objectType, 'pause_no_conv_no_checkout',
                SUFFIXES.PAUSE_NO_CONV_NO_CHECKOUT,
                `Sem conversoes e sem checkout em 7d (spend R$${m7d.spend.toFixed(2)})`
            );
        }

        // Rule 5: No conversions + expensive CPC
        if (m7d && m7d.conversions === 0 && m7d.cpc > avgCPC7d * 1.5 && m7d.spend > maxCPA) {
            return this._createPauseAction(item, objectType, 'pause_no_conv_cpc_expensive',
                SUFFIXES.PAUSE_NO_CONV_CPC_EXPENSIVE,
                `Sem conversoes e CPC caro (R$${m7d.cpc.toFixed(2)} vs avg R$${avgCPC7d.toFixed(2)})`
            );
        }

        // === PERDA DE PERFORMANCE ===

        // Rule 6: Max CPA exceeded
        if (m7d && m7d.cpa && m7d.cpa !== Infinity && m7d.cpa > maxCPA * (isRigorous ? 1.2 : 1.5)) {
            return this._createPauseAction(item, objectType, 'pause_max_cpa',
                SUFFIXES.PAUSE_MAX_CPA,
                `CPA acima do maximo (R$${m7d.cpa.toFixed(2)} vs limite R$${maxCPA.toFixed(2)})`
            );
        }

        // Rule 7: Performance loss 14d vs 30d
        if (m14d && m30d && m14d.cpa && m30d.cpa && m14d.cpa !== Infinity && m30d.cpa !== Infinity) {
            if (m14d.cpa > m30d.cpa * (isRigorous ? 1.3 : 1.5)) {
                return this._createPauseAction(item, objectType, 'pause_perf_loss_14d',
                    SUFFIXES.PAUSE_PERF_LOSS_14D,
                    `Perda de performance 14d (CPA R$${m14d.cpa.toFixed(2)} vs 30d R$${m30d.cpa.toFixed(2)})`
                );
            }
        }

        // Rule 8: Performance loss 7d vs 14d
        if (m7d && m14d && m7d.cpa && m14d.cpa && m7d.cpa !== Infinity && m14d.cpa !== Infinity) {
            if (m7d.cpa > m14d.cpa * (isRigorous ? 1.3 : 1.5)) {
                return this._createPauseAction(item, objectType, 'pause_perf_loss_7d',
                    SUFFIXES.PAUSE_PERF_LOSS_7D,
                    `Perda de performance 7d (CPA R$${m7d.cpa.toFixed(2)} vs 14d R$${m14d.cpa.toFixed(2)})`
                );
            }
        }

        // Rule 9: Extreme CPA (3x max)
        if (m3d && m3d.cpa && m3d.cpa !== Infinity && m3d.cpa > maxCPA * 3) {
            return this._createPauseAction(item, objectType, 'pause_extreme_cpa',
                SUFFIXES.PAUSE_EXTREME_CPA,
                `CPA extremo ultimos 3 dias (R$${m3d.cpa.toFixed(2)} = ${(m3d.cpa / maxCPA).toFixed(1)}x o limite)`
            );
        }

        // Rule 10: Expensive checkout
        if (m7d && m7d.costPerCheckout && m7d.costPerCheckout > maxCPA * 2) {
            return this._createPauseAction(item, objectType, 'pause_checkout_expensive',
                SUFFIXES.PAUSE_CHECKOUT_EXPENSIVE,
                `Checkout caro (R$${m7d.costPerCheckout.toFixed(2)} vs CPA max R$${maxCPA.toFixed(2)})`
            );
        }

        // === PAUSAS TEMPORARIAS ===

        // Rule 11: CPA today above threshold (needs significant spend first)
        if (mToday && mToday.cpa && mToday.cpa !== Infinity && mToday.spend > maxCPA * 3 && mToday.cpa > maxCPA * (isRigorous ? 2 : 2.5)) {
            return this._createPauseAction(item, objectType, 'temp_pause_cpa_today',
                SUFFIXES.TEMP_PAUSE_CPA_TODAY,
                `CPA hoje alto (R$${mToday.cpa.toFixed(2)}) - reativa a meia-noite`,
                true // temporary
            );
        }

        // Rule 12: No conversions today with significant spend (3x CPA rigorosa, 5x flexivel)
        if (mToday && mToday.conversions === 0 && mToday.spend > maxCPA * (isRigorous ? 3 : 5)) {
            return this._createPauseAction(item, objectType, 'temp_pause_no_conv_today',
                SUFFIXES.TEMP_PAUSE_NO_CONV_TODAY,
                `Sem conversoes hoje (spend R$${mToday.spend.toFixed(2)}) - reativa a meia-noite`,
                true
            );
        }

        // Rule 13: High frequency
        if (m7d && m7d.frequency > (isRigorous ? 3.0 : 3.5)) {
            return this._createPauseAction(item, objectType, 'reduction_high_freq',
                SUFFIXES.REDUCTION_HIGH_FREQ,
                `Frequencia alta (${m7d.frequency.toFixed(1)}) - fadiga de audiencia`
            );
        }

        return null;
    }

    // ==================== SCALE RULES ====================
    _checkScaleRules(adSet, config, campaignMetrics, campaign) {
        const metrics = adSet.metrics || {};
        const maxCPA = config.max_cpa;
        const maxBudget = config.max_daily_budget_cbo;
        const isAccelerated = config.scale_method === 'accelerated';

        const m7d = metrics.last_7d;
        const m3d = metrics.last_3d;
        const mToday = metrics.today;

        if (!m7d || !m7d.cpa || m7d.cpa === Infinity) return null;

        // Only scale if performing well
        if (m7d.cpa > maxCPA * 0.8) return null;

        // Check budget limits
        const currentBudget = parseInt(adSet.daily_budget) / 100 || 0;
        if (!config.unlimited_scale && currentBudget >= maxBudget && maxBudget > 0) return null;

        // === ESCALA HORIZONTAL (duplicate ad set) ===
        if (isAccelerated && m7d.conversions >= 5 && m7d.cpa <= maxCPA * 0.6) {
            return {
                type: 'scale_horizontal',
                object_type: 'adset',
                object_id: adSet.id,
                object_name: adSet.name,
                suffix: SUFFIXES.SCALE_HORIZONTAL,
                reason: `Performance excelente (CPA R$${m7d.cpa.toFixed(2)} = ${((m7d.cpa / maxCPA) * 100).toFixed(0)}% do max) - duplicando`,
                details: {
                    current_cpa: m7d.cpa,
                    max_cpa: maxCPA,
                    conversions_7d: m7d.conversions,
                    action: 'duplicate'
                }
            };
        }

        // === ESCALA VERTICAL AGRESSIVA (>20% increase) ===
        if (isAccelerated && m3d && m3d.cpa && m3d.cpa !== Infinity && m3d.cpa <= maxCPA * 0.5) {
            const increase = 0.3; // 30% increase
            const newBudget = Math.min(currentBudget * (1 + increase), maxBudget || Infinity);

            if (newBudget > currentBudget) {
                return {
                    type: 'scale_vertical',
                    object_type: 'adset',
                    object_id: adSet.id,
                    object_name: adSet.name,
                    suffix: SUFFIXES.SCALE_VERTICAL_AGGRESSIVE,
                    reason: `CPA excelente 3d (R$${m3d.cpa.toFixed(2)}) - aumento agressivo de budget`,
                    details: {
                        current_budget: currentBudget,
                        new_budget: Math.round(newBudget * 100) / 100,
                        increase_pct: Math.round((newBudget / currentBudget - 1) * 100),
                        action: 'increase_budget'
                    }
                };
            }
        }

        // === ESCALA VERTICAL CONSERVADORA (10-15% increase) ===
        if (m7d.cpa <= maxCPA * 0.7 && m7d.conversions >= 3) {
            const increase = isAccelerated ? 0.2 : 0.1; // 20% or 10%
            const newBudget = Math.min(currentBudget * (1 + increase), maxBudget || Infinity);

            if (newBudget > currentBudget) {
                return {
                    type: 'scale_vertical',
                    object_type: 'adset',
                    object_id: adSet.id,
                    object_name: adSet.name,
                    suffix: SUFFIXES.SCALE_VERTICAL,
                    reason: `CPA bom 7d (R$${m7d.cpa.toFixed(2)}) - aumento conservador`,
                    details: {
                        current_budget: currentBudget,
                        new_budget: Math.round(newBudget * 100) / 100,
                        increase_pct: Math.round((newBudget / currentBudget - 1) * 100),
                        action: 'increase_budget'
                    }
                };
            }
        }

        // === SURFANDO CONVERSOES HOJE ===
        if (mToday && mToday.conversions >= 3 && mToday.cpa && mToday.cpa !== Infinity && mToday.cpa <= maxCPA * 0.5) {
            const increase = isAccelerated ? 0.5 : 0.25;
            const newBudget = Math.min(currentBudget * (1 + increase), maxBudget || Infinity);

            if (newBudget > currentBudget) {
                return {
                    type: 'scale_surfing',
                    object_type: 'adset',
                    object_id: adSet.id,
                    object_name: adSet.name,
                    suffix: SUFFIXES.SCALE_SURFING,
                    reason: `Surfando conversoes hoje (${mToday.conversions} conv, CPA R$${mToday.cpa.toFixed(2)})`,
                    details: {
                        current_budget: currentBudget,
                        new_budget: Math.round(newBudget * 100) / 100,
                        increase_pct: Math.round((newBudget / currentBudget - 1) * 100),
                        conversions_today: mToday.conversions,
                        action: 'increase_budget'
                    }
                };
            }
        }

        return null;
    }

    // ==================== REACTIVATION RULES ====================
    _checkReactivation(item, config, objectType = 'adset') {
        // Check if item has a pause suffix
        const isPaused = item.status === 'PAUSED';
        if (!isPaused) return null;

        // Don't reactivate manually paused items
        if (this._hasControlTag(item.name, CONTROL_TAGS.MANUAL)) return null;

        const metrics = item.metrics || {};
        const mToday = metrics.today;
        const m3d = metrics.last_3d;

        // Late conversion: got a conversion after being paused
        if (mToday && mToday.conversions > 0 && mToday.cpa && mToday.cpa <= config.max_cpa) {
            return {
                type: 'reactivate',
                object_type: objectType,
                object_id: item.id,
                object_name: item.name,
                suffix: SUFFIXES.REACTIVATE_LATE_CONV,
                reason: `Conversao tardia detectada (${mToday.conversions} conv hoje, CPA R$${mToday.cpa.toFixed(2)})`,
                details: {
                    conversions_today: mToday.conversions,
                    cpa_today: mToday.cpa,
                    action: 'reactivate'
                }
            };
        }

        // Secondary metrics good: good CTR + checkouts
        if (m3d && m3d.ctr > 2.0 && m3d.checkouts > 0) {
            return {
                type: 'reactivate',
                object_type: objectType,
                object_id: item.id,
                object_name: item.name,
                suffix: SUFFIXES.REACTIVATE_SECONDARY,
                reason: `Metricas secundarias positivas (CTR ${m3d.ctr.toFixed(2)}%, ${m3d.checkouts} checkouts)`,
                details: {
                    ctr_3d: m3d.ctr,
                    checkouts_3d: m3d.checkouts,
                    action: 'reactivate'
                }
            };
        }

        return null;
    }

    // ==================== ACTION EXECUTION ====================
    async _executeAction(action, config) {
        switch (action.type) {
            case 'pause_never_converted':
            case 'pause_no_conv_14d':
            case 'pause_no_conv_7d':
            case 'pause_no_conv_3d':
            case 'pause_no_conv_no_checkout':
            case 'pause_no_conv_cpc_expensive':
            case 'pause_max_cpa':
            case 'pause_perf_loss_14d':
            case 'pause_perf_loss_7d':
            case 'pause_perf_loss_3d':
            case 'pause_extreme_cpa':
            case 'pause_checkout_expensive':
            case 'reduction_high_freq':
                // Permanent pause
                await this._executePause(action);
                break;

            case 'temp_pause_cpa_today':
            case 'temp_pause_cpa_3d':
            case 'temp_pause_cpa_7d':
            case 'temp_pause_no_conv_today':
            case 'temp_pause_no_conv_3d':
            case 'temp_pause_no_conv_7d':
            case 'temp_pause_no_checkout_today':
            case 'temp_pause_checkout_expensive':
            case 'temp_pause_maximizing':
                // Temporary pause
                await this._executePause(action);
                break;

            case 'reactivate':
                await this._executeReactivate(action);
                break;

            case 'scale_horizontal':
                await this._executeScaleHorizontal(action, config);
                break;

            case 'scale_vertical':
            case 'scale_surfing':
                await this._executeScaleVertical(action);
                break;

            default:
                console.warn(`[Optimizer] Acao desconhecida: ${action.type}`);
        }
    }

    async _executePause(action) {
        // Add suffix to name
        const newName = this._cleanSuffixes(action.object_name) + action.suffix;
        await this.api.updateName(action.object_id, newName);
        await this.api.updateStatus(action.object_id, 'PAUSED');
    }

    async _executeReactivate(action) {
        // Clean all suffixes and add reactivation suffix
        const cleanName = this._cleanSuffixes(action.object_name);
        const newName = cleanName + action.suffix;
        await this.api.updateName(action.object_id, newName);
        await this.api.updateStatus(action.object_id, 'ACTIVE');
    }

    async _executeScaleHorizontal(action, config) {
        try {
            // Duplicate the ad set
            await this.api.duplicateAdSet(action.object_id, null, ' - Escala horizontal');

            // Add suffix to original
            const newName = this._cleanSuffixes(action.object_name) + action.suffix;
            await this.api.updateName(action.object_id, newName);
        } catch (e) {
            throw new Error(`Erro na escala horizontal: ${e.message}`);
        }
    }

    async _executeScaleVertical(action) {
        const newBudget = action.details.new_budget;
        await this.api.updateBudget(action.object_id, newBudget);

        // Add suffix to name
        const newName = this._cleanSuffixes(action.object_name) + action.suffix;
        await this.api.updateName(action.object_id, newName);
    }

    // ==================== HELPERS ====================
    _createPauseAction(item, objectType, type, suffix, reason, temporary = false) {
        return {
            type,
            object_type: objectType,
            object_id: item.id,
            object_name: item.name,
            suffix,
            reason,
            temporary,
            details: {
                action: 'pause'
            }
        };
    }

    _hasControlTag(name, tag) {
        return name.toLowerCase().includes(tag.toLowerCase());
    }

    _cleanSuffixes(name) {
        // Remove all known suffixes from name
        let clean = name;
        for (const suffix of Object.values(SUFFIXES)) {
            clean = clean.replace(suffix, '');
        }
        return clean.trim();
    }

    // ==================== KS ON PREFIX ====================
    /**
     * Add [KS ON] prefix to campaign name via Meta API
     */
    async addKsOnPrefix(campaignId) {
        try {
            const campaign = await this.api.getCampaignDetails(campaignId);
            if (!campaign || !campaign.name) return;

            // Already has prefix
            if (campaign.name.startsWith(KS_ON_PREFIX)) return;

            const newName = KS_ON_PREFIX + campaign.name;
            await this.api.updateName(campaignId, newName);
            console.log(`[Optimizer] Prefix adicionado: ${newName}`);
        } catch (e) {
            console.error(`[Optimizer] Erro ao adicionar prefix KS ON: ${e.message}`);
        }
    }

    /**
     * Remove [KS ON] prefix from campaign name via Meta API
     */
    async removeKsOnPrefix(campaignId) {
        try {
            const campaign = await this.api.getCampaignDetails(campaignId);
            if (!campaign || !campaign.name) return;

            // Doesn't have prefix
            if (!campaign.name.startsWith(KS_ON_PREFIX)) return;

            const newName = campaign.name.slice(KS_ON_PREFIX.length);
            await this.api.updateName(campaignId, newName);
            console.log(`[Optimizer] Prefix removido: ${newName}`);
        } catch (e) {
            console.error(`[Optimizer] Erro ao remover prefix KS ON: ${e.message}`);
        }
    }

    _emitProgress(campaignId, status, message) {
        if (this.io) {
            this.io.emit('optimization_progress', {
                campaign_id: campaignId,
                status,
                message,
                timestamp: new Date().toISOString()
            });
        }
    }
}

Optimizer.KS_ON_PREFIX = KS_ON_PREFIX;
module.exports = Optimizer;
