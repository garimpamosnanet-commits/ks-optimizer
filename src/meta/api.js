/**
 * Meta Marketing API Client
 * Uses Node 20 built-in fetch
 */

const API_BASE = 'https://graph.facebook.com/v21.0';

class MetaAPI {
    constructor(db) {
        this.db = db;
        this._requestCount = 0;
        this._lastRequest = 0;
    }

    getToken() {
        const settings = this.db ? require('../database/db').getSettings() : {};
        return settings.token || '';
    }

    async _request(endpoint, params = {}, method = 'GET') {
        const token = this.getToken();
        if (!token) throw new Error('Token Meta nao configurado');

        // Rate limiting: min 200ms between requests (Meta allows ~200 calls/hour per token)
        const now = Date.now();
        const elapsed = now - this._lastRequest;
        if (elapsed < 200) {
            await new Promise(r => setTimeout(r, 200 - elapsed));
        }
        this._lastRequest = Date.now();
        this._requestCount++;

        const url = new URL(`${API_BASE}${endpoint}`);

        if (method === 'GET') {
            url.searchParams.set('access_token', token);
            for (const [key, val] of Object.entries(params)) {
                if (val !== undefined && val !== null) {
                    url.searchParams.set(key, String(val));
                }
            }
        }

        const fetchOpts = { method };
        if (method === 'POST') {
            url.searchParams.set('access_token', token);
            if (Object.keys(params).length > 0) {
                // For POST, use URL params (Meta API style)
                for (const [key, val] of Object.entries(params)) {
                    if (val !== undefined && val !== null) {
                        url.searchParams.set(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
                    }
                }
            }
        }

        // Retry with backoff for rate limits
        let retries = 0;
        const maxRetries = 3;

        while (true) {
            try {
                const resp = await fetch(url.toString(), fetchOpts);
                const data = await resp.json();

                if (data.error) {
                    // Rate limit: retry with exponential backoff
                    if ((data.error.code === 32 || data.error.code === 4 ||
                         (data.error.message && data.error.message.includes('limit'))) && retries < maxRetries) {
                        retries++;
                        const wait = Math.pow(2, retries) * 2000; // 4s, 8s, 16s
                        console.log(`[MetaAPI] Rate limit hit, retry ${retries}/${maxRetries} in ${wait}ms...`);
                        await new Promise(r => setTimeout(r, wait));
                        continue;
                    }

                    const err = new Error(data.error.message || 'Meta API error');
                    err.code = data.error.code;
                    err.type = data.error.type;
                    err.fbtrace_id = data.error.fbtrace_id;
                    throw err;
                }

                return data;
            } catch (e) {
                if (e.code) throw e; // Already a Meta API error
                throw new Error(`Meta API request failed: ${e.message}`);
            }
        }
    }

    // ==================== ACCOUNTS ====================
    async getAdAccounts() {
        const data = await this._request('/me/adaccounts', {
            fields: 'name,account_status,currency,timezone_name,amount_spent',
            limit: 100
        });
        return data.data || [];
    }

    async getAccountInfo(accountId) {
        return await this._request(`/${accountId}`, {
            fields: 'name,account_status,currency,timezone_name,amount_spent,balance,spend_cap'
        });
    }

    // ==================== CAMPAIGNS ====================
    async getCampaigns(accountId, filters = {}) {
        const params = {
            fields: 'name,status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time,start_time,stop_time,special_ad_categories,bid_strategy',
            limit: filters.limit || 200
        };

        if (filters.status) {
            params.effective_status = JSON.stringify(
                Array.isArray(filters.status) ? filters.status : [filters.status]
            );
        }

        const data = await this._request(`/${accountId}/campaigns`, params);
        return data.data || [];
    }

    async getCampaignDetails(campaignId) {
        return await this._request(`/${campaignId}`, {
            fields: 'name,status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time,bid_strategy,special_ad_categories'
        });
    }

    // ==================== AD SETS ====================
    async getAdSets(accountId, filters = {}) {
        const params = {
            fields: 'name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,created_time,updated_time,start_time,end_time,bid_amount,bid_strategy',
            limit: filters.limit || 500
        };

        if (filters.campaign_id) {
            // Get ad sets for a specific campaign
            const data = await this._request(`/${filters.campaign_id}/adsets`, params);
            return data.data || [];
        }

        if (filters.status) {
            params.effective_status = JSON.stringify(
                Array.isArray(filters.status) ? filters.status : [filters.status]
            );
        }

        const data = await this._request(`/${accountId}/adsets`, params);
        return data.data || [];
    }

    async getAdSetDetails(adsetId) {
        return await this._request(`/${adsetId}`, {
            fields: 'name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,created_time,updated_time,bid_amount,bid_strategy'
        });
    }

    // ==================== ADS ====================
    async getAds(accountId, filters = {}) {
        const params = {
            fields: 'name,status,adset_id,campaign_id,creative,created_time,updated_time',
            limit: filters.limit || 500
        };

        if (filters.adset_id) {
            const data = await this._request(`/${filters.adset_id}/ads`, params);
            return data.data || [];
        }

        if (filters.campaign_id) {
            const data = await this._request(`/${filters.campaign_id}/ads`, params);
            return data.data || [];
        }

        if (filters.status) {
            params.effective_status = JSON.stringify(
                Array.isArray(filters.status) ? filters.status : [filters.status]
            );
        }

        const data = await this._request(`/${accountId}/ads`, params);
        return data.data || [];
    }

    // ==================== INSIGHTS ====================
    async getInsights(objectId, params = {}) {
        const defaultFields = 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,conversions,cost_per_conversion';
        // Add name fields when querying by level
        let fields = params.fields || defaultFields;
        if (params.level === 'adset') fields += ',adset_name,adset_id';
        if (params.level === 'ad') fields += ',ad_name,ad_id,adset_name';
        const insightParams = {
            fields,
            date_preset: params.date_preset || 'last_7d'
        };

        if (params.time_range) {
            delete insightParams.date_preset;
            insightParams.time_range = JSON.stringify(params.time_range);
        }

        if (params.level) {
            insightParams.level = params.level;
        }

        if (params.breakdowns) {
            insightParams.breakdowns = params.breakdowns;
        }

        if (params.time_increment) {
            insightParams.time_increment = params.time_increment;
        }

        if (params.limit) {
            insightParams.limit = params.limit;
        }

        const data = await this._request(`/${objectId}/insights`, insightParams);
        return data.data || [];
    }

    /**
     * Fetch insights for multiple time windows in parallel
     */
    async getMultiWindowInsights(objectId, windows = ['today', 'last_3d', 'last_7d', 'last_14d', 'last_30d']) {
        const results = {};
        const promises = windows.map(async (window) => {
            try {
                const data = await this.getInsights(objectId, { date_preset: window });
                results[window] = data[0] || null;
            } catch (e) {
                results[window] = null;
                console.error(`[MetaAPI] Insights ${window} error for ${objectId}:`, e.message);
            }
        });

        await Promise.all(promises);
        return results;
    }

    // ==================== UPDATE OPERATIONS ====================
    async updateObject(objectId, updates) {
        return await this._request(`/${objectId}`, updates, 'POST');
    }

    async updateStatus(objectId, status) {
        return await this.updateObject(objectId, { status });
    }

    async updateBudget(objectId, dailyBudget) {
        // Meta API expects budget in cents
        const budgetCents = Math.round(dailyBudget * 100);
        return await this.updateObject(objectId, { daily_budget: budgetCents });
    }

    async updateName(objectId, name) {
        return await this.updateObject(objectId, { name });
    }

    // ==================== DUPLICATE ====================
    async duplicateAdSet(adsetId, campaignId, newName) {
        const params = {
            copied_adset_id: adsetId
        };
        if (newName) params.rename_options = JSON.stringify({ rename_suffix: newName });
        if (campaignId) params.campaign_id = campaignId;
        params.status_option = 'PAUSED';

        return await this._request(`/${campaignId || adsetId}/copies`, params, 'POST');
    }

    async duplicateAd(adId, adsetId) {
        const params = {
            status_option: 'PAUSED'
        };
        if (adsetId) params.adset_id = adsetId;

        return await this._request(`/${adId}/copies`, params, 'POST');
    }

    // ==================== HELPERS ====================
    /**
     * Extract lead count from actions array
     */
    static extractLeads(actions) {
        if (!actions || !Array.isArray(actions)) return 0;
        const leadAction = actions.find(a =>
            a.action_type === 'lead' ||
            a.action_type === 'onsite_conversion.lead_grouped' ||
            a.action_type === 'offsite_conversion.fb_pixel_lead'
        );
        return leadAction ? parseInt(leadAction.value) || 0 : 0;
    }

    /**
     * Extract purchase/conversion count from actions
     */
    static extractConversions(actions) {
        if (!actions || !Array.isArray(actions)) return 0;
        const convAction = actions.find(a =>
            a.action_type === 'offsite_conversion.fb_pixel_purchase' ||
            a.action_type === 'purchase' ||
            a.action_type === 'lead' ||
            a.action_type === 'onsite_conversion.lead_grouped'
        );
        return convAction ? parseInt(convAction.value) || 0 : 0;
    }

    /**
     * Extract checkout/initiate_checkout count
     */
    static extractCheckouts(actions) {
        if (!actions || !Array.isArray(actions)) return 0;
        const action = actions.find(a =>
            a.action_type === 'offsite_conversion.fb_pixel_initiate_checkout' ||
            a.action_type === 'initiate_checkout'
        );
        return action ? parseInt(action.value) || 0 : 0;
    }

    /**
     * Extract landing page views
     */
    static extractLPV(actions) {
        if (!actions || !Array.isArray(actions)) return 0;
        const action = actions.find(a => a.action_type === 'landing_page_view');
        return action ? parseInt(action.value) || 0 : 0;
    }

    /**
     * Extract link clicks
     */
    static extractLinkClicks(actions) {
        if (!actions || !Array.isArray(actions)) return 0;
        const action = actions.find(a => a.action_type === 'link_click');
        return action ? parseInt(action.value) || 0 : 0;
    }

    /**
     * Calculate CPA from insights data
     */
    static calculateCPA(insights) {
        if (!insights) return null;
        const spend = parseFloat(insights.spend) || 0;
        const conversions = MetaAPI.extractConversions(insights.actions);
        if (conversions === 0) return spend > 0 ? Infinity : null;
        return spend / conversions;
    }

    /**
     * Parse metrics from raw insights into a clean object
     */
    static parseMetrics(insights) {
        if (!insights) return null;
        const spend = parseFloat(insights.spend) || 0;
        const impressions = parseInt(insights.impressions) || 0;
        const clicks = parseInt(insights.clicks) || 0;
        const reach = parseInt(insights.reach) || 0;
        const conversions = MetaAPI.extractConversions(insights.actions);
        const leads = MetaAPI.extractLeads(insights.actions);
        const checkouts = MetaAPI.extractCheckouts(insights.actions);
        const lpv = MetaAPI.extractLPV(insights.actions);
        const linkClicks = MetaAPI.extractLinkClicks(insights.actions);

        return {
            spend,
            impressions,
            clicks,
            reach,
            ctr: parseFloat(insights.ctr) || 0,
            cpc: parseFloat(insights.cpc) || 0,
            cpm: parseFloat(insights.cpm) || 0,
            frequency: parseFloat(insights.frequency) || 0,
            conversions,
            leads,
            checkouts,
            lpv,
            linkClicks,
            cpa: conversions > 0 ? spend / conversions : (spend > 0 ? Infinity : null),
            cpl: leads > 0 ? spend / leads : (spend > 0 ? Infinity : null),
            costPerCheckout: checkouts > 0 ? spend / checkouts : null,
            connectRate: clicks > 0 ? (lpv / clicks * 100) : 0
        };
    }

    getRequestCount() {
        return this._requestCount;
    }

    resetRequestCount() {
        this._requestCount = 0;
    }
}

module.exports = MetaAPI;
