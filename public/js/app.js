// ==================== KS OPTIMIZER — FRONTEND ====================
const socket = io();
let _accounts = [];
let _currentAccount = null;
let _campaigns = [];
let _configs = [];
let _dateFilter = localStorage.getItem('ks-date-filter') || 'last_7d';
let _settings = {};
let _currentPage = 'dashboard';
let _optTab = 'enabled';

// ==================== THEME ====================
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || '';
    const next = current === 'dark' ? '' : 'dark';
    if (next) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('ks-theme', next || 'light');
    updateThemeIcon();
}

function updateThemeIcon() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const svg = document.getElementById('theme-icon-svg');
    if (svg) {
        svg.innerHTML = isDark
            ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>'
            : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    }
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    // Apply saved theme
    const savedTheme = localStorage.getItem('ks-theme') || 'light';
    if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    updateThemeIcon();
    await checkSetup();
});

async function checkSetup() {
    try {
        const resp = await api('/settings');
        _settings = resp;
        if (!resp.has_token) {
            showSetupWizard();
        } else {
            await loadApp();
        }
    } catch (e) {
        if (e.status === 401) {
            window.location.href = '/login';
        } else {
            showSetupWizard();
        }
    }
}

function showSetupWizard() {
    document.getElementById('setup-wizard').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
}

async function loadApp() {
    document.getElementById('setup-wizard').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';

    // Set user name from cookie/session
    const savedName = localStorage.getItem('ks-user-name') || 'Usuario';
    setText('header-user-name', savedName);

    try {
        _accounts = await api('/accounts');
    } catch (e) {
        _accounts = [];
    }

    populateAccountSelect();
    loadSettingsUI();

    if (_accounts.length > 0) {
        const saved = localStorage.getItem('ks-selected-account');
        const exists = saved && _accounts.some(a => a.id === saved);
        _currentAccount = exists ? saved : _accounts[0].id;
        document.getElementById('account-select').value = _currentAccount;
        await onAccountChange();
    }

    setupSocketListeners();

    const savedPage = localStorage.getItem('ks-active-page') || 'dashboard';
    navigateTo(savedPage);

    syncDateFilterButtons();
}

// ==================== SETUP WIZARD ====================
async function setupValidateToken() {
    const token = document.getElementById('setup-token').value.trim();
    if (!token) return;

    const btn = document.getElementById('setup-validate-btn');
    const errEl = document.getElementById('setup-error');
    btn.textContent = 'Validando...';
    btn.disabled = true;
    errEl.style.display = 'none';

    try {
        await api('/token', 'PUT', { token });
        const data = await api('/token/validate', 'POST');

        if (data.accounts && data.accounts.length > 0) {
            await api('/accounts/discover', 'POST');
            _accounts = await api('/accounts');

            document.getElementById('setup-step-1').style.display = 'none';
            document.getElementById('setup-step-2').style.display = 'block';

            const container = document.getElementById('setup-accounts');
            container.innerHTML = data.accounts.map(a => `
                <div class="account-card">
                    <div class="account-card-info">
                        <h4>${esc(a.name)}</h4>
                        <p>${a.id} - ${a.currency || 'BRL'}</p>
                    </div>
                    <span class="opt-status-badge active">Conectada</span>
                </div>
            `).join('');
        } else {
            errEl.textContent = 'Token valido mas nenhuma conta encontrada.';
            errEl.style.display = 'block';
        }
    } catch (e) {
        errEl.textContent = `Erro: ${e.message || 'Token invalido'}`;
        errEl.style.display = 'block';
    }

    btn.textContent = 'Validar Token';
    btn.disabled = false;
}

async function setupComplete() {
    await loadApp();
}

// ==================== API HELPER ====================
async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`/api${path}`, opts);
    const data = await resp.json();
    if (!resp.ok) {
        const err = new Error(data.error || 'Erro na API');
        err.status = resp.status;
        throw err;
    }
    return data;
}

// ==================== NAVIGATION ====================
function navigateTo(page) {
    _currentPage = page;
    localStorage.setItem('ks-active-page', page);

    // Update sidebar
    document.querySelectorAll('.sidebar-link').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });

    // Switch page
    document.querySelectorAll('.page').forEach(el => {
        el.classList.toggle('active', el.id === `page-${page}`);
    });

    // Load page-specific data
    if (page === 'dashboard') loadDashboard();
    if (page === 'optimization') loadOptimizationPage();
    if (page === 'log') loadOptLog();
    if (page === 'accounts') loadAccountsPage();
    if (page === 'settings') loadSettingsUI();
    if (page === 'suffixes') loadSuffixesPage();
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('.main-content');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}

// ==================== ACCOUNT SELECT ====================
function populateAccountSelect() {
    const sel = document.getElementById('account-select');
    sel.innerHTML = '<option value="">Selecione uma conta</option>';
    for (const acc of _accounts) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = acc.name ? `${acc.name}` : acc.id;
        sel.appendChild(opt);
    }
}

async function onAccountChange() {
    _currentAccount = document.getElementById('account-select').value;
    if (!_currentAccount) return;
    localStorage.setItem('ks-selected-account', _currentAccount);

    updateHeaderStatus('online');

    // Load data for current page
    if (_currentPage === 'dashboard') await loadDashboard();
    if (_currentPage === 'optimization') await loadOptimizationPage();
    if (_currentPage === 'log') await loadOptLog();
}

// ==================== DASHBOARD ====================
async function loadDashboard() {
    if (!_currentAccount) return;

    try {
        const insights = await api(`/insights/${_currentAccount}?date_preset=${_dateFilter}&level=account`);
        const raw = insights[0] || null;

        if (raw) {
            const spend = parseFloat(raw.spend) || 0;
            const impressions = parseInt(raw.impressions) || 0;
            const clicks = parseInt(raw.clicks) || 0;
            const reach = parseInt(raw.reach) || 0;
            const ctr = parseFloat(raw.ctr) || 0;
            const cpc = parseFloat(raw.cpc) || 0;
            const cpm = parseFloat(raw.cpm) || 0;
            const freq = parseFloat(raw.frequency) || 0;
            const leads = extractLeads(raw.actions);
            const cpl = leads > 0 ? spend / leads : 0;

            setText('stat-spend', `R$ ${formatMoney(spend)}`);
            setText('stat-leads', formatNumber(leads));
            setText('stat-cpl', cpl > 0 ? `R$ ${formatMoney(cpl)}` : 'R$ 0,00');
            setText('stat-impressions', formatNumber(impressions));
            setText('stat-reach', formatNumber(reach));
            setText('stat-frequency', freq.toFixed(2));
            setText('stat-ctr', `${ctr.toFixed(2)}%`);
            setText('stat-cpc', `R$ ${formatMoney(cpc)}`);
            setText('stat-cpm', `R$ ${formatMoney(cpm)}`);
            setText('stat-clicks', formatNumber(clicks));
        }

        // Load real entries from SalesEcommerce
        const metaLeads = raw ? extractLeads(raw.actions) : 0;
        await loadRealEntries(raw ? parseFloat(raw.spend) || 0 : 0, metaLeads);

        // Load campaign performance
        const campaigns = await api(`/campaigns?account_id=${_currentAccount}&status=ACTIVE`);
        await loadDashboardCampaigns(campaigns);

    } catch (e) {
        console.error('Dashboard error:', e);
    }
}

let _perfTab = 'campaign';
let _dashboardAutoRefresh = null;

// Mapeamento conta Meta -> instancia SalesEcommerce (TODAS)
const ACCOUNT_INSTANCE_MAP = {
    'act_343078820487125': 'hudson-oliveira',         // Hudson 2.0
    'act_4260177337539586': 'hudson-oliveira',        // Hudson (outra conta)
    'act_700924378146370': 'junior-automotiva',       // Livia Bombo / Junior
    'act_1319994062238404': 'junior-automotiva',      // Junior (conta propria)
    'act_1220899122923055': 'achados-secretos',       // Andre / Larisse
    'act_321696970444959': 'achados-secretos',        // Jorge
    'act_1239747731524637': 'ofertas-da-jenni',       // Jennifer / Dani Wal
    'act_1720931478425787': 'achadinho-da-ivis',      // Ivone
    'act_1916013155820452': 'achadinhos-do-gilioli',  // Gilioli
    'act_328201254007546': 'sabaziuscp',              // Sabazius
    'act_338281941994189': 'promocoes-do-dia',        // Renata
    'act_339589001914046': 'achadinhos-da-dri',       // Adriana
    'act_829642158833837': 'achadinhos-da-anna',      // Amanda
    'act_840398074413162': 'achadinhos-do-borogodo',  // Danielli
    'act_6745107755555484': 'ze-ofertas',             // Filipe
    'act_1843590456346828': 'garimpo-da-mamae',       // Franci
    'act_1139088090094699': 'dicas-da-ca',            // Debaldi
    'act_25573157989016239': 'promo-da-oportunidade', // Paloma
    'act_4036561509942696': 'promo-da-dinda',         // Dani Wal / Wal / Jose Camilo
    'act_841869274830958': 'achadinhos-para-pobre',   // Jonathan
    'act_2068647333624515': 'sabaziuscp',             // Mario Jr
    'act_1949016345666216': 'dicas-da-ca',            // Carina
    'act_2056603588205127': 'achadinhos-da-anna',     // Carol
    'act_1393268055150638': 'achadinhos-da-tata',     // Tais
    'act_1254904646649965': 'achadinhos-imbativel',   // Eber/Tiko
};
let _entriesData = null;

async function loadRealEntries(totalSpend, metaLeads) {
    const instanceName = ACCOUNT_INSTANCE_MAP[_currentAccount];
    const section = document.getElementById('section-entries');

    if (!instanceName) {
        if (section) section.style.display = 'none';
        return;
    }

    // Calculate date range based on filter
    const now = new Date();
    let from, to;
    to = now.toISOString().slice(0, 10);

    if (_dateFilter === 'today') {
        from = to;
    } else if (_dateFilter === 'last_3d') {
        from = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
    } else if (_dateFilter === 'last_7d') {
        from = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    } else if (_dateFilter === 'last_14d') {
        from = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
    } else if (_dateFilter === 'last_30d') {
        from = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
    } else {
        from = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    }

    try {
        const data = await api(`/entries/${instanceName}?from=${from}&to=${to}`);

        // Response format: { totals: { organicJoins, fastExits, validLeads, ... }, instances: [...] }
        const totals = data.totals || data.instances?.[0] || data;
        const totalJoins = totals.organicJoins || 0;
        const totalFastExits = totals.fastExits || 0;
        // Formula correta: Leads Validos = Entradas - Saiu (simples, sem misterio)
        const validLeads = totalJoins - totalFastExits;
        const netEntries = validLeads;
        const cplReal = validLeads > 0 && totalSpend > 0 ? totalSpend / validLeads : 0;

        setText('stat-leads-meta', formatNumber(metaLeads || 0));
        setText('stat-entries', formatNumber(totalJoins));
        setText('stat-fast-exits', formatNumber(totalFastExits));
        setText('stat-net-entries', formatNumber(validLeads));
        setText('stat-cpl-real', cplReal > 0 ? `R$ ${formatMoney(cplReal)}` : '--');
        // Retencao 24h = validLeads / totalJoins (identico ao Pedro)
        const retention = totalJoins > 0 ? ((validLeads / totalJoins) * 100) : 0;
        setText('stat-conv-rate', retention > 0 ? `${retention.toFixed(1)}%` : '--');

        if (section) section.style.display = 'block';
        _entriesData = { totalJoins, totalFastExits, netEntries, cplReal };
    } catch (e) {
        console.error('Entries error:', e);
        if (section) section.style.display = 'none';
    }
}

async function loadDashboardCampaigns(campaigns) {
    _dashboardCampaigns = campaigns;
    await loadPerfTab(_perfTab);

    // Auto-refresh every 5 minutes
    if (_dashboardAutoRefresh) clearInterval(_dashboardAutoRefresh);
    _dashboardAutoRefresh = setInterval(() => {
        if (_currentPage === 'dashboard') loadDashboard();
    }, 5 * 60 * 1000);
}

function switchPerfTab(tab) {
    _perfTab = tab;
    document.querySelectorAll('.perf-tab').forEach(t => t.classList.remove('active'));
    const tabs = document.querySelectorAll('.perf-tab');
    if (tab === 'campaign') tabs[0]?.classList.add('active');
    else if (tab === 'adset') tabs[1]?.classList.add('active');
    else tabs[2]?.classList.add('active');
    loadPerfTab(tab);
}

let _dashboardCampaigns = [];

async function loadPerfTab(level) {
    const container = document.getElementById('dashboard-perf-content');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div> Carregando...</div>';

    try {
        if (level === 'campaign') {
            await renderPerfCampaigns(container);
        } else if (level === 'adset') {
            await renderPerfAdsets(container);
        } else {
            await renderPerfAds(container);
        }
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><h3>Erro ao carregar</h3><p>${esc(e.message)}</p></div>`;
    }
}

async function renderPerfCampaigns(container) {
    const campaigns = _dashboardCampaigns || [];
    if (campaigns.length === 0) {
        container.innerHTML = '<div class="empty-state"><h3>Nenhuma campanha ativa</h3></div>';
        return;
    }

    // Collect all data first to find top performer
    const rows = [];
    for (const c of campaigns.slice(0, 20)) {
        try {
            const ins = await api(`/insights/${c.id}?date_preset=${_dateFilter}`);
            const raw = ins[0] || {};
            const spend = parseFloat(raw.spend) || 0;
            const leads = extractLeads(raw.actions);
            const cpl = leads > 0 ? spend / leads : 0;
            const ctr = parseFloat(raw.ctr) || 0;
            const freq = parseFloat(raw.frequency) || 0;
            const config = c.optimization_config;
            const cplClass = config && config.max_cpa
                ? (cpl > config.max_cpa * 1.3 ? 'bad' : cpl > config.max_cpa ? 'warning' : 'good')
                : '';
            const budget = c.daily_budget ? parseInt(c.daily_budget) / 100 : (c.lifetime_budget ? parseInt(c.lifetime_budget) / 100 : 0);
            rows.push({ name: c.name, spend, leads, cpl, ctr, freq, cplClass, budget, status: c.status });
        } catch (e) { /* skip */ }
    }

    // Find top leads performer
    const maxLeads = Math.max(...rows.map(r => r.leads));
    const html = rows.map(r => buildPerfRow(r.name, r.spend, r.leads, r.cpl, r.ctr, r.freq, r.cplClass, r.budget, r.leads > 0 && r.leads === maxLeads, r.status)).join('');
    container.innerHTML = html || '<div class="empty-state"><h3>Sem dados</h3></div>';
}

async function renderPerfAdsets(container) {
    // Fetch adsets with budget info
    const adsets = await api(`/campaigns/${_dashboardCampaigns.map(c=>c.id).join(',')}/adsets`).catch(() => []);
    const insights = await api(`/insights/${_currentAccount}?date_preset=${_dateFilter}&level=adset`);
    if (!insights || insights.length === 0) {
        container.innerHTML = '<div class="empty-state"><h3>Sem dados de conjuntos</h3></div>';
        return;
    }

    // Build budget map from adsets
    const budgetMap = {};
    if (Array.isArray(adsets)) {
        for (const a of adsets) {
            budgetMap[a.id] = a.daily_budget ? parseInt(a.daily_budget) / 100 : 0;
        }
    }

    // Build status map from adsets
    const statusMap = {};
    if (Array.isArray(adsets)) {
        for (const a of adsets) {
            statusMap[a.id] = a.status;
        }
    }

    // Collect rows and find top
    const rows = insights.slice(0, 30).map(raw => {
        const spend = parseFloat(raw.spend) || 0;
        const leads = extractLeads(raw.actions);
        const cpl = leads > 0 ? spend / leads : 0;
        const ctr = parseFloat(raw.ctr) || 0;
        const freq = parseFloat(raw.frequency) || 0;
        const budget = budgetMap[raw.adset_id] || 0;
        const status = statusMap[raw.adset_id] || '';
        return { name: raw.adset_name || raw.adset_id, spend, leads, cpl, ctr, freq, budget, status };
    });

    const maxLeads = Math.max(...rows.map(r => r.leads));
    const html = rows.map(r => buildPerfRow(r.name, r.spend, r.leads, r.cpl, r.ctr, r.freq, '', r.budget, r.leads > 0 && r.leads === maxLeads, r.status)).join('');
    container.innerHTML = html || '<div class="empty-state"><h3>Sem dados</h3></div>';
}

async function renderPerfAds(container) {
    const insights = await api(`/insights/${_currentAccount}?date_preset=${_dateFilter}&level=ad`);
    if (!insights || insights.length === 0) {
        container.innerHTML = '<div class="empty-state"><h3>Sem dados de anuncios</h3></div>';
        return;
    }

    const rows = insights.slice(0, 30).map(raw => {
        const spend = parseFloat(raw.spend) || 0;
        const leads = extractLeads(raw.actions);
        const cpl = leads > 0 ? spend / leads : 0;
        const ctr = parseFloat(raw.ctr) || 0;
        const freq = parseFloat(raw.frequency) || 0;
        return { name: raw.ad_name || raw.ad_id, spend, leads, cpl, ctr, freq };
    });

    const maxLeads = Math.max(...rows.map(r => r.leads));
    const html = rows.map(r => buildPerfRow(r.name, r.spend, r.leads, r.cpl, r.ctr, r.freq, '', 0, r.leads > 0 && r.leads === maxLeads)).join('');
    container.innerHTML = html || '<div class="empty-state"><h3>Sem dados</h3></div>';
}

function buildPerfRow(name, spend, leads, cpl, ctr, freq, cplClass, budget, isTopLeads, status) {
    const budgetDisplay = budget ? `R$${formatMoney(budget)}` : '--';
    const topClass = isTopLeads ? 'top-performer' : '';
    const statusBadge = status === 'ACTIVE' ? '<span class="status-active-badge">ATIVO</span>'
        : status === 'PAUSED' ? '<span class="status-paused-badge">PAUSADO</span>'
        : '';
    return `
    <div class="campaign-summary-row ${topClass} ${status === 'PAUSED' ? 'row-paused' : ''}">
        <div class="campaign-summary-name" title="${esc(name)}">
            ${isTopLeads ? '<span class="top-badge">TOP</span>' : ''}
            ${statusBadge}
            ${esc(name)}
        </div>
        <div class="campaign-summary-metric">
            <div class="label">Budget/dia</div>
            <div class="value">${budgetDisplay}</div>
        </div>
        <div class="campaign-summary-metric">
            <div class="label">Gasto</div>
            <div class="value">R$${formatMoney(spend)}</div>
        </div>
        <div class="campaign-summary-metric">
            <div class="label">Leads</div>
            <div class="value ${isTopLeads ? 'leads-top' : ''}">${leads}</div>
        </div>
        <div class="campaign-summary-metric">
            <div class="label">CPL</div>
            <div class="value ${cplClass} ${cpl > 0 && cpl <= 1.0 ? 'cpl-fire' : ''}">${cpl > 0 ? 'R$' + formatMoney(cpl) : '--'}</div>
        </div>
        <div class="campaign-summary-metric">
            <div class="label">CTR</div>
            <div class="value">${ctr.toFixed(2)}%</div>
        </div>
        <div class="campaign-summary-metric">
            <div class="label">Freq</div>
            <div class="value ${freq > 3.5 ? 'warning' : ''}">${freq.toFixed(1)}</div>
        </div>
    </div>`;
}

function setDateFilter(preset) {
    _dateFilter = preset;
    localStorage.setItem('ks-date-filter', preset);
    syncDateFilterButtons();
    loadDashboard();
}

function syncDateFilterButtons() {
    const map = { today: 'Hoje', last_3d: '3D', last_7d: '7D', last_14d: '14D', last_30d: '30D' };
    document.querySelectorAll('.date-btn').forEach(b => {
        b.classList.toggle('active', b.textContent.trim() === (map[_dateFilter] || '7D'));
    });
}

// ==================== OPTIMIZATION PAGE ====================
async function loadOptimizationPage() {
    if (!_currentAccount) return;

    try {
        // Only load ACTIVE campaigns (like OneClick) — not archived/deleted
        _campaigns = await api(`/campaigns?account_id=${_currentAccount}&status=ACTIVE`);
        _configs = await api(`/optimization/configs?account_id=${_currentAccount}`);
    } catch (e) {
        console.error('Opt page error:', e);
        _campaigns = [];
        _configs = [];
    }

    renderOptCampaigns();
}

function renderOptCampaigns() {
    const enabledContainer = document.getElementById('opt-campaigns-enabled');
    const disabledContainer = document.getElementById('opt-campaigns-disabled');

    const searchTerm = (document.getElementById('opt-search')?.value || '').toLowerCase();

    const enriched = _campaigns.map(c => {
        const config = _configs.find(cfg => cfg.campaign_id === c.id);
        return { ...c, config };
    });

    // Filter
    let filtered = enriched;
    if (searchTerm) {
        filtered = filtered.filter(c => c.name.toLowerCase().includes(searchTerm));
    }

    const statusFilter = document.getElementById('opt-status-filter')?.value;
    if (statusFilter === 'enabled') {
        filtered = filtered.filter(c => c.config && c.config.enabled);
    } else if (statusFilter === 'disabled') {
        filtered = filtered.filter(c => !c.config || !c.config.enabled);
    }

    const enabled = filtered.filter(c => c.config && c.config.enabled);
    const disabled = filtered.filter(c => !c.config || !c.config.enabled);

    enabledContainer.innerHTML = enabled.length > 0
        ? enabled.map(c => renderOptCard(c, true)).join('')
        : '<div class="empty-state"><h3>Nenhuma campanha otimizando</h3><p>Ative a otimizacao na aba "Campanhas Desativadas".</p></div>';

    disabledContainer.innerHTML = disabled.length > 0
        ? disabled.map(c => renderOptCard(c, false)).join('')
        : '<div class="empty-state"><h3>Todas as campanhas estao sendo otimizadas</h3></div>';
}

function renderOptCard(campaign, isEnabled) {
    const c = campaign;
    const cfg = c.config || {};
    const pauseBehavior = cfg.pause_behavior || _settings.default_pause_behavior || 'flexible';
    const scaleMethod = cfg.scale_method || _settings.default_scale_method || 'conservative';
    const maxCpa = cfg.max_cpa || 0;
    const maxBudget = cfg.max_daily_budget_cbo || 0;
    const hasBudgetLimit = maxBudget > 0;
    const campaignId = c.id;

    return `
    <div class="opt-card" id="opt-card-${campaignId}">
        <div class="opt-card-header">
            <div class="opt-card-type">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
                Otimizacao Manual
            </div>
            <div class="opt-card-actions">
                <a class="opt-card-meta-link" href="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${(cfg.account_id || _currentAccount || '').replace('act_','')}&campaign_ids=${campaignId}" target="_blank" title="Abrir no Meta Ads Manager">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    Meta
                </a>
                <button class="opt-card-menu" title="Opcoes">...</button>
            </div>
        </div>

        <div class="opt-card-body">
            <div class="opt-card-name-label">Nome da campanha</div>
            <div class="opt-card-name">${esc(c.name)}</div>

            <div class="opt-card-controls">
                <div class="opt-control-group">
                    <label>Comportamento para pausar:</label>
                    <div class="toggle-group">
                        <button class="toggle-option ${pauseBehavior === 'rigorous' ? 'active' : ''}" onclick="setOptParam('${campaignId}', 'pause_behavior', 'rigorous', this)">Pausa Rigorosa</button>
                        <button class="toggle-option ${pauseBehavior === 'flexible' ? 'active' : ''}" onclick="setOptParam('${campaignId}', 'pause_behavior', 'flexible', this)">Pausa Flexivel</button>
                    </div>
                </div>
                <div class="opt-control-group">
                    <label>Metodo de escala:</label>
                    <div class="toggle-group">
                        <button class="toggle-option ${scaleMethod === 'accelerated' ? 'active' : ''}" onclick="setOptParam('${campaignId}', 'scale_method', 'accelerated', this)">Escala Acelerada</button>
                        <button class="toggle-option ${scaleMethod === 'conservative' ? 'active' : ''}" onclick="setOptParam('${campaignId}', 'scale_method', 'conservative', this)">Escala Conservadora</button>
                    </div>
                </div>
            </div>

            <div class="opt-card-params">
                <div class="opt-param-group">
                    <div class="opt-param-label">
                        Custo por Conversao para PAUSAR (Conjunto de Anuncios)
                        <span class="info-icon" title="Custo maximo por conversao. Conjuntos acima deste valor serao pausados automaticamente.">i</span>
                    </div>
                    <div class="opt-param-input">
                        <span class="opt-param-prefix">BRL</span>
                        <input type="text" value="${formatMoneyInput(maxCpa)}" onchange="setOptCpa('${campaignId}', this.value)" placeholder="0,00">
                    </div>
                </div>

                <div class="opt-param-group">
                    <div class="opt-budget-toggle">
                        <input type="checkbox" id="budget-check-${campaignId}" ${hasBudgetLimit ? 'checked' : ''} onchange="toggleBudgetLimit('${campaignId}', this.checked)">
                        <label for="budget-check-${campaignId}">
                            Definir Orcamento Diario Maximo
                            <span class="info-icon" title="Limita o orcamento diario maximo da campanha (CBO). O otimizador nao escalara acima deste valor.">i</span>
                        </label>
                    </div>
                    <div class="opt-param-input" id="budget-input-${campaignId}" style="display:${hasBudgetLimit ? 'flex' : 'none'};margin-top:8px">
                        <span class="opt-param-prefix">BRL</span>
                        <input type="text" value="${formatMoneyInput(maxBudget)}" onchange="setOptBudget('${campaignId}', this.value)" placeholder="0,00">
                    </div>
                </div>
            </div>
        </div>

        <div class="opt-card-footer">
            <div class="opt-card-ai">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                Parametrizacao inteligente com IA
                <span class="badge-soon">Em breve</span>
            </div>
            <div class="opt-card-action-btns">
                ${isEnabled
                    ? `<span class="opt-status-badge active opt-pulse" style="margin-right:8px">
                        <svg class="opt-arrow-anim" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg>
                        Otimizando 24/7
                    </span>
                    <button class="btn-optimize" onclick="runOptimize('${campaignId}')" title="Forcar uma otimizacao manual agora">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg>
                        Otimizar Agora
                    </button>
                    <button class="btn-pause-campaign" onclick="disableOptimization('${campaignId}')">Parar</button>`
                    : `<button class="btn-optimize" onclick="enableOptimization('${campaignId}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21 5,3"/></svg>
                        Ativar Otimizacao
                    </button>`
                }
            </div>
        </div>

        <!-- LOG DE OTIMIZACOES DESTA CAMPANHA -->
        ${isEnabled ? `
        <div class="opt-card-log" id="opt-log-${campaignId}">
            <div class="opt-card-log-header" onclick="toggleCardLog('${campaignId}')">
                <span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    Historico de acoes
                </span>
                <svg class="opt-log-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
            </div>
            <div class="opt-card-log-body" id="opt-log-body-${campaignId}" style="display:none">
                <div class="opt-card-log-loading">Carregando...</div>
            </div>
        </div>` : ''}
    </div>`;
}

function filterOptCampaigns() {
    renderOptCampaigns();
}

// ==================== CARD LOG (inline history) ====================
async function toggleCardLog(campaignId) {
    const body = document.getElementById(`opt-log-body-${campaignId}`);
    const chevron = document.querySelector(`#opt-log-${campaignId} .opt-log-chevron`);

    if (body.style.display === 'none') {
        body.style.display = 'block';
        if (chevron) chevron.style.transform = 'rotate(180deg)';
        await loadCardLog(campaignId);
    } else {
        body.style.display = 'none';
        if (chevron) chevron.style.transform = '';
    }
}

async function loadCardLog(campaignId) {
    const body = document.getElementById(`opt-log-body-${campaignId}`);
    if (!body) return;

    body.innerHTML = '<div class="opt-card-log-loading"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Carregando historico...</div>';

    try {
        const logs = await api(`/optimization/log?campaign_id=${campaignId}&limit=30`);

        if (!logs || logs.length === 0) {
            body.innerHTML = '<div class="opt-card-log-empty">Nenhuma acao executada ainda. O optimizer analisara esta campanha no proximo ciclo (a cada 15 min).</div>';
            return;
        }

        body.innerHTML = logs.map(log => {
            const time = formatDateTime(log.timestamp);
            const actionType = log.action.includes('pause') ? 'pause'
                : log.action.includes('scale') ? 'scale'
                : log.action.includes('reactivate') ? 'reactivate'
                : 'other';

            const actionLabel = log.action.includes('temp_pause') ? 'Pausa Temp'
                : log.action.includes('pause') ? 'Pausou'
                : log.action.includes('scale_horizontal') ? 'Duplicou'
                : log.action.includes('scale') ? 'Escalou'
                : log.action.includes('reactivate') ? 'Reativou'
                : log.action.includes('reduction') ? 'Reduziu'
                : log.action;

            const icon = actionType === 'pause' ? '⏸'
                : actionType === 'scale' ? '📈'
                : actionType === 'reactivate' ? '▶️'
                : '⚡';

            const statusClass = log.success ? '' : 'failed';

            return `
            <div class="opt-card-log-entry ${statusClass}">
                <div class="opt-log-entry-header">
                    <span class="opt-log-entry-icon">${icon}</span>
                    <span class="opt-log-entry-action ${actionType}">${esc(actionLabel)}</span>
                    <span class="opt-log-entry-time">${time}</span>
                </div>
                <div class="opt-log-entry-name">${esc(log.object_name || '')}</div>
                <div class="opt-log-entry-reason">${esc(log.reason || '')}</div>
                ${!log.success ? `<div class="opt-log-entry-error">Erro: ${esc(log.error || 'desconhecido')}</div>` : ''}
            </div>`;
        }).join('');
    } catch (e) {
        body.innerHTML = `<div class="opt-card-log-empty">Erro ao carregar: ${esc(e.message)}</div>`;
    }
}

function switchOptTab(tab) {
    _optTab = tab;
    document.querySelectorAll('.opt-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.opt-tab:${tab === 'enabled' ? 'first-child' : 'last-child'}`).classList.add('active');
    document.getElementById('opt-campaigns-enabled').style.display = tab === 'enabled' ? 'flex' : 'none';
    document.getElementById('opt-campaigns-disabled').style.display = tab === 'disabled' ? 'flex' : 'none';

    // Show/hide bulk action buttons
    const btnActivateAll = document.getElementById('btn-activate-all');
    const btnOptimizeAll = document.getElementById('btn-optimize-all');
    if (btnActivateAll) btnActivateAll.style.display = tab === 'disabled' ? 'inline-flex' : 'none';
    if (btnOptimizeAll) btnOptimizeAll.style.display = tab === 'enabled' ? 'inline-flex' : 'none';
}

// ==================== BULK CONFIG ====================
let _bulkPause = 'flexible';
let _bulkScale = 'accelerated';

function toggleBulkConfig() {
    const body = document.getElementById('opt-bulk-config-body');
    const chevron = document.querySelector('.opt-bulk-chevron');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        if (chevron) chevron.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (chevron) chevron.style.transform = '';
    }
}

function setBulkToggle(type, value) {
    if (type === 'pause') {
        _bulkPause = value;
        document.getElementById('bulk-pause-rigorous').classList.toggle('active', value === 'rigorous');
        document.getElementById('bulk-pause-flexible').classList.toggle('active', value === 'flexible');
    } else {
        _bulkScale = value;
        document.getElementById('bulk-scale-accelerated').classList.toggle('active', value === 'accelerated');
        document.getElementById('bulk-scale-conservative').classList.toggle('active', value === 'conservative');
    }
}

async function applyBulkConfig(andActivate) {
    const maxCpa = parseMoneyInput(document.getElementById('bulk-max-cpa')?.value || '0');
    const maxBudget = parseMoneyInput(document.getElementById('bulk-max-budget')?.value || '0');

    if (maxCpa <= 0) {
        showToast('Configure o CPL Maximo antes de aplicar', 'error');
        return;
    }

    const campaigns = _campaigns;
    if (campaigns.length === 0) {
        showToast('Nenhuma campanha encontrada', 'error');
        return;
    }

    const action = andActivate ? 'Aplicando e ativando' : 'Aplicando';
    showToast(`${action} em ${campaigns.length} campanhas...`, 'info');

    let count = 0;
    for (const c of campaigns) {
        try {
            const updates = {
                pause_behavior: _bulkPause,
                scale_method: _bulkScale,
                max_cpa: maxCpa,
                max_daily_budget_cbo: maxBudget,
                unlimited_scale: maxBudget <= 0
            };
            if (andActivate) updates.enabled = true;

            await saveOptConfig(c.id, updates);
            count++;
        } catch (e) {
            console.error(`Erro em ${c.name}:`, e);
        }
    }

    if (andActivate && !_settings.auto_optimize) {
        await api('/settings', 'PUT', { auto_optimize: true });
        _settings.auto_optimize = true;
    }

    showToast(`${count} campanha(s) configuradas${andActivate ? ' e ativadas 24/7' : ''}!`, 'success');
    await loadOptimizationPage();
    if (andActivate) switchOptTab('enabled');
}

async function activateAllOptimization() {
    const disabled = _campaigns.filter(c => {
        const cfg = _configs.find(cfg => cfg.campaign_id === c.id);
        return !cfg || !cfg.enabled;
    });

    if (disabled.length === 0) {
        showToast('Todas as campanhas ja estao ativadas', 'info');
        return;
    }

    // Check if all have CPA configured
    const withoutCPA = disabled.filter(c => {
        const cfg = _configs.find(cfg => cfg.campaign_id === c.id);
        return !cfg || !cfg.max_cpa || cfg.max_cpa <= 0;
    });

    if (withoutCPA.length > 0) {
        showToast(`${withoutCPA.length} campanha(s) sem CPL maximo configurado. Configure antes de ativar.`, 'error');
        return;
    }

    const btn = document.getElementById('btn-activate-all');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Ativando...';
    }

    let activated = 0;
    for (const campaign of disabled) {
        try {
            await saveOptConfig(campaign.id, { enabled: true });
            activated++;
        } catch (e) {
            console.error(`Erro ao ativar ${campaign.name}:`, e);
        }
    }

    // Ensure auto-optimize is ON
    if (!_settings.auto_optimize) {
        await api('/settings', 'PUT', { auto_optimize: true });
        _settings.auto_optimize = true;
    }

    showToast(`${activated} campanha(s) ativadas pra otimizacao 24/7!`, 'success');

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21 5,3"/></svg> Ativar Todas';
    }

    // Refresh
    await loadOptimizationPage();
    switchOptTab('enabled');
}

// ==================== OPTIMIZATION ACTIONS ====================
function setOptParam(campaignId, param, value, btn) {
    // Update toggle UI
    const group = btn.parentElement;
    group.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Save
    saveOptConfig(campaignId, { [param]: value });
}

function setOptCpa(campaignId, value) {
    const numVal = parseMoneyInput(value);
    saveOptConfig(campaignId, { max_cpa: numVal });
}

function setOptBudget(campaignId, value) {
    const numVal = parseMoneyInput(value);
    saveOptConfig(campaignId, { max_daily_budget_cbo: numVal });
}

function toggleBudgetLimit(campaignId, checked) {
    const inputDiv = document.getElementById(`budget-input-${campaignId}`);
    inputDiv.style.display = checked ? 'flex' : 'none';
    if (!checked) {
        saveOptConfig(campaignId, { max_daily_budget_cbo: 0, unlimited_scale: true });
    } else {
        saveOptConfig(campaignId, { unlimited_scale: false });
    }
}

async function saveOptConfig(campaignId, updates) {
    const campaign = _campaigns.find(c => c.id === campaignId);
    const existing = _configs.find(c => c.campaign_id === campaignId) || {};

    const config = {
        campaign_id: campaignId,
        campaign_name: campaign?.name || existing.campaign_name || '',
        account_id: _currentAccount,
        pause_behavior: existing.pause_behavior || _settings.default_pause_behavior || 'flexible',
        scale_method: existing.scale_method || _settings.default_scale_method || 'conservative',
        max_cpa: existing.max_cpa || 0,
        max_daily_budget_cbo: existing.max_daily_budget_cbo || 0,
        unlimited_scale: existing.unlimited_scale || false,
        enabled: existing.enabled !== undefined ? existing.enabled : false,
        ...updates
    };

    try {
        await api(`/optimization/configs/${campaignId}`, 'PUT', config);
        // Update local cache
        const idx = _configs.findIndex(c => c.campaign_id === campaignId);
        if (idx >= 0) {
            Object.assign(_configs[idx], config);
        } else {
            _configs.push(config);
        }
        showToast('Configuracao salva', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function enableOptimization(campaignId) {
    const campaign = _campaigns.find(c => c.id === campaignId);
    const existing = _configs.find(c => c.campaign_id === campaignId) || {};

    // Check if CPA is set
    const cpa = existing.max_cpa || 0;
    if (cpa <= 0) {
        showToast('Configure o Custo por Conversao antes de ativar', 'error');
        return;
    }

    // 1. Enable optimization for this campaign
    await saveOptConfig(campaignId, { enabled: true });

    // 2. Ensure auto-optimize is ON globally (so scheduler keeps running 24/7)
    if (!_settings.auto_optimize) {
        await api('/settings', 'PUT', { auto_optimize: true });
        _settings.auto_optimize = true;
    }

    showToast(`Otimizacao ATIVA 24/7: ${campaign?.name || campaignId}. Rodando primeira analise agora...`, 'success');
    renderOptCampaigns();

    // 3. Run first optimization immediately (don't wait for scheduler)
    try {
        await api(`/optimization/run/${campaignId}`, 'POST');
    } catch (e) {
        // Non-blocking — scheduler will pick it up anyway
        console.log('First run queued:', e.message);
    }
}

async function disableOptimization(campaignId) {
    const campaign = _campaigns.find(c => c.id === campaignId);
    await saveOptConfig(campaignId, { enabled: false });
    showToast(`Otimizacao pausada: ${campaign?.name || campaignId}`, 'info');
    renderOptCampaigns();
}

async function runOptimize(campaignId) {
    const btn = document.querySelector(`#opt-card-${campaignId} .btn-optimize`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Otimizando...';
    }

    try {
        await api(`/optimization/run/${campaignId}`, 'POST');
        showToast('Otimizacao iniciada', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg> Otimizar';
        }
    }
}

async function runOptimizeAll() {
    try {
        await api('/optimization/run-all', 'POST');
        showToast('Otimizacao de todas as campanhas iniciada', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== ACCOUNTS PAGE ====================
async function loadAccountsPage() {
    const container = document.getElementById('accounts-list');
    container.innerHTML = _accounts.map(acc => `
        <div class="account-card">
            <div class="account-card-info">
                <h4>${esc(acc.name || acc.id)}</h4>
                <p>${acc.id} - ${acc.currency || 'BRL'} - ${acc.timezone || '--'}</p>
            </div>
            <span class="opt-status-badge active">Ativa</span>
        </div>
    `).join('') || '<div class="empty-state"><h3>Nenhuma conta vinculada</h3></div>';
}

async function discoverAccounts() {
    try {
        const data = await api('/accounts/discover', 'POST');
        showToast(`${data.accounts?.length || 0} contas encontradas`, 'success');
        _accounts = await api('/accounts');
        populateAccountSelect();
        loadAccountsPage();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== LOG PAGE ====================
async function loadOptLog() {
    if (!_currentAccount) return;

    const actionFilter = document.getElementById('log-filter-action')?.value || '';
    try {
        const logs = await api(`/optimization/log?account_id=${_currentAccount}&action=${actionFilter}&limit=200`);
        const container = document.getElementById('log-list');

        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>Nenhuma otimizacao registrada</h3><p>O historico aparecera aqui apos as otimizacoes serem executadas.</p></div>';
            return;
        }

        container.innerHTML = logs.map(log => {
            const actionType = log.action.includes('pause') ? 'pause'
                : log.action.includes('scale') ? 'scale'
                : log.action.includes('reactivate') ? 'reactivate'
                : 'other';

            const actionLabel = log.action.includes('pause') ? 'Pausa'
                : log.action.includes('scale') ? 'Escala'
                : log.action.includes('reactivate') ? 'Reativacao'
                : log.action;

            return `
            <div class="log-entry">
                <div class="log-time">${formatDateTime(log.timestamp)}</div>
                <div class="log-action ${actionType}">${actionLabel}</div>
                <div>
                    <div class="log-detail">${esc(log.object_name || '--')}</div>
                    <div class="log-reason">${esc(log.reason || '--')}</div>
                </div>
                <div class="log-campaign" style="font-size:11px;color:var(--text-muted)">${esc(log.campaign_name || '')}</div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Log error:', e);
    }
}

// ==================== SUFFIXES PAGE ====================
function loadSuffixesPage() {
    const suffixes = [
        { code: '| Pausado nunca converteu', desc: 'Conjunto/anuncio que nunca gerou conversao' },
        { code: '| Pausado sem conversoes 7 dias', desc: 'Sem conversoes nos ultimos 7 dias' },
        { code: '| Pausado sem conversoes 14 dias', desc: 'Sem conversoes nos ultimos 14 dias' },
        { code: '| Pausado CPA maximo', desc: 'CPA acima do limite configurado' },
        { code: '| Pausado perda de performance 7d', desc: 'CPA 7d pior que 14d' },
        { code: '| Pausado CPA extremo ultimos dias', desc: 'CPA acima de 3x o maximo' },
        { code: '| Pausado temporariamente CPA hoje', desc: 'CPA alto hoje - reativa a meia-noite' },
        { code: '| Pausado temporariamente sem conversoes hoje', desc: 'Sem conversoes hoje - reativa a meia-noite' },
        { code: '| Reativado conversao tardia', desc: 'Conversao detectada apos pausa' },
        { code: '| Escala horizontal', desc: 'Conjunto duplicado por performance excelente' },
        { code: '| Escala vertical', desc: 'Budget aumentado por boa performance' },
        { code: '| Escala vertical agressiva', desc: 'Aumento de budget acima de 20%' },
        { code: '| Surfando conversoes hoje', desc: 'Budget aumentado por performance excepcional hoje' },
        { code: '| Reducao por alta frequencia', desc: 'Frequencia acima do limite' },
        { code: '| Correcao Orcamento Maximo', desc: 'Budget corrigido para nao ultrapassar o maximo CBO' },
    ];

    const container = document.getElementById('suffixes-list');
    container.innerHTML = suffixes.map(s => `
        <div class="suffix-item">
            <code>${esc(s.code)}</code>
            <span>${esc(s.desc)}</span>
        </div>
    `).join('');
}

// ==================== SETTINGS ====================
function loadSettingsUI() {
    const autoOpt = document.getElementById('settings-auto-optimize');
    const interval = document.getElementById('settings-interval');
    const pauseSel = document.getElementById('settings-default-pause');
    const scaleSel = document.getElementById('settings-default-scale');
    const tokenStatus = document.getElementById('settings-token-status');

    if (autoOpt) autoOpt.checked = _settings.auto_optimize !== false;
    if (interval) interval.value = _settings.optimization_interval_minutes || 15;
    if (pauseSel) pauseSel.value = _settings.default_pause_behavior || 'flexible';
    if (scaleSel) scaleSel.value = _settings.default_scale_method || 'conservative';
    if (tokenStatus) {
        tokenStatus.textContent = _settings.has_token
            ? `Configurado (${_settings.token_preview || '***'})`
            : 'Nao configurado';
    }

    // Accounts in settings
    const accContainer = document.getElementById('settings-accounts');
    if (accContainer) {
        accContainer.innerHTML = _accounts.map(a => `
            <div class="settings-row">
                <div>
                    <div class="settings-label">${esc(a.name || a.id)}</div>
                    <div class="settings-hint">${a.id}</div>
                </div>
                <span class="opt-status-badge active">Ativa</span>
            </div>
        `).join('') || '<p style="color:var(--text-muted);font-size:13px">Nenhuma conta vinculada.</p>';
    }
}

async function saveSettings() {
    const updates = {
        auto_optimize: document.getElementById('settings-auto-optimize')?.checked ?? true,
        optimization_interval_minutes: parseInt(document.getElementById('settings-interval')?.value) || 15,
        default_pause_behavior: document.getElementById('settings-default-pause')?.value || 'flexible',
        default_scale_method: document.getElementById('settings-default-scale')?.value || 'conservative'
    };

    try {
        await api('/settings', 'PUT', updates);
        Object.assign(_settings, updates);
        showToast('Configuracoes salvas', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

function showChangeTokenModal() {
    document.getElementById('modal-token').style.display = 'flex';
    document.getElementById('modal-token-input').value = '';
    document.getElementById('modal-token-input').focus();
}

function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

async function changeToken() {
    const token = document.getElementById('modal-token-input').value.trim();
    if (!token) return;

    try {
        await api('/token', 'PUT', { token });
        const result = await api('/token/validate', 'POST');
        if (result.accounts) {
            await api('/accounts/discover', 'POST');
            _accounts = await api('/accounts');
            populateAccountSelect();
        }
        _settings.has_token = true;
        _settings.token_preview = token.slice(0, 10) + '...' + token.slice(-5);
        loadSettingsUI();
        closeModal('modal-token');
        showToast('Token atualizado com sucesso', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== SOCKET LISTENERS ====================
function setupSocketListeners() {
    socket.on('optimization_progress', (data) => {
        const progressEl = document.getElementById('optimization-progress');
        const textEl = document.getElementById('opt-progress-text');
        const logEl = document.getElementById('opt-progress-log');

        if (data.status === 'started') {
            progressEl.style.display = 'block';
        }

        if (textEl) textEl.textContent = data.message || 'Otimizando...';

        if (logEl && data.message) {
            const div = document.createElement('div');
            div.textContent = `[${new Date().toLocaleTimeString('pt-BR')}] ${data.message}`;
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
        }

        // Add to sidebar activity
        addActivityItem(data.message, data.status);

        if (data.status === 'completed' || data.status === 'error') {
            setTimeout(() => {
                progressEl.style.display = 'none';
                if (logEl) logEl.innerHTML = '';
            }, 5000);

            // Refresh optimization page
            loadOptimizationPage();

            // Re-enable buttons
            document.querySelectorAll('.btn-optimize').forEach(btn => {
                btn.disabled = false;
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg> Otimizar';
            });
        }
    });

    socket.on('optimization_result', (result) => {
        if (result.total_actions > 0) {
            showToast(`${result.campaign_name}: ${result.successful_actions} acoes executadas`, 'success');
        } else {
            showToast(`${result.campaign_name}: nenhuma acao necessaria`, 'info');
        }
    });

    socket.on('optimization_all_complete', (results) => {
        const totalActions = results.reduce((sum, r) => sum + (r.total_actions || 0), 0);
        showToast(`Otimizacao concluida: ${results.length} campanhas, ${totalActions} acoes`, 'success');
        loadOptimizationPage();
    });

    socket.on('optimization_error', (data) => {
        showToast(`Erro na otimizacao: ${data.error}`, 'error');
    });

    socket.on('midnight_reset', (data) => {
        showToast(`Reset meia-noite: ${data.reactivated} itens reativados`, 'info');
        addActivityItem(`Reset meia-noite: ${data.reactivated} reativados`, 'info');
    });

    socket.on('optimization_complete', (data) => {
        addActivityItem(`Auto-otimizacao: ${data.total_actions} acoes em ${data.campaigns} campanhas`, 'completed');
    });

    socket.on('connect', () => updateHeaderStatus('online'));
    socket.on('disconnect', () => updateHeaderStatus('offline'));
}

// ==================== ACTIVITY SIDEBAR ====================
// Note: we don't have a visual sidebar for activity anymore (like OneClick)
// but we track it via toasts
function addActivityItem(message, status) {
    // Could be extended to add a real-time activity panel
    console.log(`[Activity] [${status}] ${message}`);
}

// ==================== HEADER STATUS ====================
function updateHeaderStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.getElementById('status-text');
    if (dot) {
        dot.className = 'status-dot';
        if (status === 'online') dot.classList.add('online');
        else if (status === 'warning') dot.classList.add('warning');
    }
    if (text) {
        text.textContent = status === 'online' ? 'Online' : status === 'warning' ? 'Processando' : 'Offline';
    }
}

// ==================== USER MENU ====================
function toggleUserMenu() {
    const dd = document.getElementById('user-dropdown');
    const name = localStorage.getItem('ks-user-name') || 'Usuario';
    const ddName = document.getElementById('dropdown-user-name');
    if (ddName) ddName.textContent = name;
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function closeUserMenu() {
    document.getElementById('user-dropdown').style.display = 'none';
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.header-user-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        const dd = document.getElementById('user-dropdown');
        if (dd) dd.style.display = 'none';
    }
});

// ==================== LOGOUT ====================
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    window.location.href = '/login';
}

// ==================== TOAST ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================== HELPERS ====================
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNumber(n) {
    if (n === null || n === undefined) return '0';
    return new Intl.NumberFormat('pt-BR').format(n);
}

function formatMoney(n) {
    if (n === null || n === undefined) return '0,00';
    return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatMoneyInput(n) {
    if (!n || n === 0) return '0,00';
    return formatMoney(n);
}

function parseMoneyInput(value) {
    if (!value) return 0;
    // Handle both formats: "1.234,56" or "1234.56"
    const cleaned = value.replace(/\./g, '').replace(',', '.');
    return parseFloat(cleaned) || 0;
}

function formatDateTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function extractLeads(actions) {
    if (!actions || !Array.isArray(actions)) return 0;
    const leadAction = actions.find(a =>
        a.action_type === 'lead' ||
        a.action_type === 'onsite_conversion.lead_grouped' ||
        a.action_type === 'offsite_conversion.fb_pixel_lead'
    );
    return leadAction ? parseInt(leadAction.value) || 0 : 0;
}

function extractConversions(actions) {
    if (!actions || !Array.isArray(actions)) return 0;
    const convAction = actions.find(a =>
        a.action_type === 'offsite_conversion.fb_pixel_purchase' ||
        a.action_type === 'purchase' ||
        a.action_type === 'lead' ||
        a.action_type === 'onsite_conversion.lead_grouped'
    );
    return convAction ? parseInt(convAction.value) || 0 : 0;
}
