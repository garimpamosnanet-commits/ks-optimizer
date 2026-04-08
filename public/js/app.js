// ==================== KS OPTIMIZER - FRONTEND ====================
const socket = io();
let _accounts = [];
let _currentAccount = null;
let _campaigns = [];
let _configs = [];
let _dateFilter = localStorage.getItem('ks-date-filter') || 'last_7d';
let _settings = {};

// ==================== THEME ====================
function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('ks-theme', next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('theme-icon');
    if (icon) {
        // Moon for dark, Sun for light
        icon.innerHTML = theme === 'dark' ? '&#9790;' : '&#9728;';
    }
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    // Sync theme icon with current theme
    updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');
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
    document.getElementById('setup-wizard').style.display = 'block';
    document.getElementById('main-app').style.display = 'none';
}

async function loadApp() {
    document.getElementById('setup-wizard').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';

    // Load accounts
    try {
        _accounts = await api('/accounts');
    } catch (e) {
        _accounts = [];
    }

    populateAccountSelect();

    // Load settings into UI
    loadSettingsUI();

    // Restore saved account or auto-select first
    if (_accounts.length > 0) {
        const saved = localStorage.getItem('ks-selected-account');
        const exists = saved && _accounts.some(a => a.id === saved);
        _currentAccount = exists ? saved : _accounts[0].id;
        document.getElementById('account-select').value = _currentAccount;
        await onAccountChange();
    }

    // Setup socket listeners
    setupSocketListeners();

    // Setup search
    document.getElementById('campaign-search').addEventListener('input', filterCampaigns);

    // Restore saved tab
    const savedTab = localStorage.getItem('ks-active-tab');
    if (savedTab) switchTab(savedTab);

    // Sync date filter buttons with saved filter
    document.querySelectorAll('.date-filter-btn').forEach(b => {
        b.classList.toggle('active',
            (_dateFilter === 'today' && b.textContent === 'Hoje') ||
            (_dateFilter === 'last_3d' && b.textContent === '3D') ||
            (_dateFilter === 'last_7d' && b.textContent === '7D') ||
            (_dateFilter === 'last_14d' && b.textContent === '14D') ||
            (_dateFilter === 'last_30d' && b.textContent === '30D'));
    });
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
        // Save token first
        await api('/token', 'PUT', { token });

        // Then validate
        const data = await api('/token/validate', 'POST');

        if (data.accounts && data.accounts.length > 0) {
            // Save accounts
            await api('/accounts/discover', 'POST');
            _accounts = await api('/accounts');

            // Show step 2
            document.getElementById('setup-step-1').style.display = 'none';
            document.getElementById('setup-step-2').style.display = 'block';

            const container = document.getElementById('setup-accounts');
            container.innerHTML = data.accounts.map(a => `
                <div class="account-item">
                    <div>
                        <div style="font-size:14px;font-weight:600">${esc(a.name)}</div>
                        <div style="font-size:12px;color:var(--text-muted)">${a.id}</div>
                    </div>
                    <span class="badge badge-success">Conectada</span>
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
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
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

// ==================== ACCOUNT ====================
function populateAccountSelect() {
    const sel = document.getElementById('account-select');
    sel.innerHTML = '<option value="">Selecione uma conta</option>';
    for (const acc of _accounts) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = `${acc.name || acc.id}`;
        sel.appendChild(opt);
    }
}

async function onAccountChange() {
    _currentAccount = document.getElementById('account-select').value;
    if (!_currentAccount) return;

    // Persist selected account
    localStorage.setItem('ks-selected-account', _currentAccount);

    await Promise.all([
        loadDashboard(),
        loadCampaigns(),
        loadOptConfigs(),
        loadOptLog()
    ]);
}

// ==================== DASHBOARD ====================
async function loadDashboard() {
    if (!_currentAccount) return;

    try {
        // Account insights
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
            const convs = extractConversions(raw.actions);
            const cpa = convs > 0 ? spend / convs : 0;

            setText('stat-spend', `R$ ${spend.toFixed(2)}`);
            setText('stat-conversions', convs.toString());
            setText('stat-cpa', cpa > 0 ? `R$ ${cpa.toFixed(2)}` : '--');
            setText('stat-ctr', `${ctr.toFixed(2)}%`);
            setText('stat-cpc', `R$ ${cpc.toFixed(2)}`);
            setText('stat-cpm', `R$ ${cpm.toFixed(2)}`);
            setText('stat-impressions', formatNumber(impressions));
            setText('stat-reach', formatNumber(reach));
            setText('stat-clicks', formatNumber(clicks));
            setText('stat-frequency', freq.toFixed(2));
        }

        // Active campaigns count
        const campaigns = await api(`/campaigns?account_id=${_currentAccount}&status=ACTIVE`);
        setText('stat-active-campaigns', campaigns.length.toString());

        // Today's optimizations
        const logs = await api(`/optimization/log?account_id=${_currentAccount}&limit=1000`);
        const today = new Date().toISOString().slice(0, 10);
        const todayLogs = logs.filter(l => l.timestamp.slice(0, 10) === today);
        setText('stat-optimizations-today', todayLogs.length.toString());

        // Campaign performance summary
        await loadDashboardCampaigns(campaigns);

    } catch (e) {
        console.error('Dashboard error:', e);
    }

    updateHeaderStatus();
}

async function loadDashboardCampaigns(campaigns) {
    const container = document.getElementById('dashboard-campaigns-summary');

    if (!campaigns || campaigns.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="icon">📊</div><h3>Nenhuma campanha ativa</h3></div>';
        return;
    }

    let html = '';
    for (const c of campaigns.slice(0, 10)) {
        try {
            const ins = await api(`/insights/${c.id}?date_preset=${_dateFilter}`);
            const raw = ins[0] || {};
            const spend = parseFloat(raw.spend) || 0;
            const convs = extractConversions(raw.actions);
            const cpa = convs > 0 ? spend / convs : 0;
            const ctr = parseFloat(raw.ctr) || 0;
            const freq = parseFloat(raw.frequency) || 0;
            const config = c.optimization_config;

            const cpaClass = config && config.max_cpa ? (cpa > config.max_cpa ? 'bad' : cpa > config.max_cpa * 0.8 ? 'warning' : 'good') : '';

            html += `
            <div class="campaign-card">
                <div class="campaign-header">
                    <div class="campaign-name">${esc(c.name)}</div>
                    <span class="campaign-status ${c.status.toLowerCase()}">
                        <span class="dot"></span> ${c.status}
                    </span>
                </div>
                <div class="campaign-metrics">
                    <div class="campaign-metric">
                        <div class="metric-label">Spend</div>
                        <div class="metric-value">R$${spend.toFixed(2)}</div>
                    </div>
                    <div class="campaign-metric">
                        <div class="metric-label">Conversoes</div>
                        <div class="metric-value">${convs}</div>
                    </div>
                    <div class="campaign-metric">
                        <div class="metric-label">CPA</div>
                        <div class="metric-value ${cpaClass}">${cpa > 0 ? 'R$' + cpa.toFixed(2) : '--'}</div>
                    </div>
                    <div class="campaign-metric">
                        <div class="metric-label">CTR</div>
                        <div class="metric-value">${ctr.toFixed(2)}%</div>
                    </div>
                    <div class="campaign-metric">
                        <div class="metric-label">Freq</div>
                        <div class="metric-value ${freq > 3.5 ? 'bad' : freq > 3.0 ? 'warning' : ''}">${freq.toFixed(2)}</div>
                    </div>
                </div>
                ${config ? `
                <div class="campaign-footer">
                    <div class="campaign-config-badges">
                        <span class="badge ${config.pause_behavior === 'rigorous' ? 'badge-danger' : 'badge-warning'}">
                            ${config.pause_behavior === 'rigorous' ? 'Pausa Rigorosa' : 'Pausa Flexivel'}
                        </span>
                        <span class="badge ${config.scale_method === 'accelerated' ? 'badge-success' : 'badge-info'}">
                            ${config.scale_method === 'accelerated' ? 'Escala Acelerada' : 'Escala Conservadora'}
                        </span>
                        <span class="badge badge-muted">CPA max: R$${config.max_cpa.toFixed(2)}</span>
                    </div>
                </div>
                ` : ''}
            </div>`;
        } catch (e) {
            html += `<div class="campaign-card"><div class="campaign-name">${esc(c.name)}</div><div style="color:var(--text-muted);font-size:12px">Erro ao carregar metricas</div></div>`;
        }
    }

    container.innerHTML = html;
}

function setDateFilter(preset) {
    _dateFilter = preset;
    localStorage.setItem('ks-date-filter', preset);
    document.querySelectorAll('.date-filter-btn').forEach(b => {
        b.classList.toggle('active', b.textContent.toLowerCase().replace(' ', '') === preset.replace('last_', '').replace('d', 'D') ||
            (preset === 'today' && b.textContent === 'Hoje') ||
            (preset === 'last_3d' && b.textContent === '3D') ||
            (preset === 'last_7d' && b.textContent === '7D') ||
            (preset === 'last_14d' && b.textContent === '14D') ||
            (preset === 'last_30d' && b.textContent === '30D'));
    });
    loadDashboard();
}

// ==================== CAMPAIGNS ====================
async function loadCampaigns() {
    if (!_currentAccount) return;

    try {
        _campaigns = await api(`/campaigns?account_id=${_currentAccount}`);
        renderCampaigns(_campaigns);
    } catch (e) {
        document.getElementById('campaigns-list').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><h3>Erro ao carregar</h3><p>${esc(e.message)}</p></div>`;
    }
}

function renderCampaigns(campaigns) {
    const container = document.getElementById('campaigns-list');

    if (!campaigns || campaigns.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><h3>Nenhuma campanha encontrada</h3></div>';
        return;
    }

    container.innerHTML = campaigns.map(c => {
        const budget = c.daily_budget ? `R$${(parseInt(c.daily_budget) / 100).toFixed(2)}/dia` : (c.lifetime_budget ? `R$${(parseInt(c.lifetime_budget) / 100).toFixed(2)} total` : '--');
        const config = c.optimization_config;

        return `
        <div class="campaign-card">
            <div class="campaign-header">
                <div class="campaign-name">${esc(c.name)}</div>
                <span class="campaign-status ${c.status.toLowerCase()}">
                    <span class="dot"></span> ${c.status}
                </span>
            </div>
            <div style="display:flex;gap:12px;font-size:12px;color:var(--text-secondary);margin-bottom:12px">
                <span>ID: ${c.id}</span>
                <span>Objetivo: ${c.objective || '--'}</span>
                <span>Budget: ${budget}</span>
            </div>
            <div class="campaign-footer">
                <div class="campaign-config-badges">
                    ${config ? `
                        <span class="badge badge-success">Otimizacao ativa</span>
                        <span class="badge badge-muted">CPA max: R$${config.max_cpa}</span>
                    ` : '<span class="badge badge-muted">Sem otimizacao</span>'}
                </div>
                <div class="campaign-actions">
                    <button class="btn btn-outline btn-sm" onclick="openOptConfigModal('${c.id}', '${esc(c.name)}', '${_currentAccount}')">
                        Configurar
                    </button>
                    ${c.status === 'ACTIVE' ?
                        `<button class="btn btn-warning btn-sm" onclick="quickPause('${c.id}')">Pausar</button>` :
                        `<button class="btn btn-success btn-sm" onclick="quickActivate('${c.id}')">Ativar</button>`
                    }
                </div>
            </div>
        </div>`;
    }).join('');
}

function filterCampaigns() {
    const q = document.getElementById('campaign-search').value.toLowerCase();
    const filtered = _campaigns.filter(c => c.name.toLowerCase().includes(q));
    renderCampaigns(filtered);
}

async function refreshCampaigns() {
    await loadCampaigns();
    showToast('Campanhas atualizadas', 'success');
}

// ==================== OPTIMIZATION CONFIG ====================
async function loadOptConfigs() {
    if (!_currentAccount) return;

    try {
        _configs = await api(`/optimization/configs?account_id=${_currentAccount}`);
        renderOptCampaigns();
    } catch (e) {
        console.error('Error loading configs:', e);
    }
}

async function renderOptCampaigns() {
    // Get all campaigns for this account
    let campaigns = _campaigns;
    if (!campaigns.length) {
        try {
            campaigns = await api(`/campaigns?account_id=${_currentAccount}`);
        } catch (e) { return; }
    }

    const enabledContainer = document.getElementById('opt-campaigns-enabled');
    const disabledContainer = document.getElementById('opt-campaigns-disabled');

    const enabledConfigs = _configs.filter(c => c.enabled);
    const enabledIds = new Set(enabledConfigs.map(c => c.campaign_id));

    // Enabled campaigns — OneClick-style inline cards
    if (enabledConfigs.length === 0) {
        enabledContainer.innerHTML = '<div class="empty-state"><div class="icon">🤖</div><h3>Nenhuma campanha ativada</h3><p>Ative a otimizacao em uma campanha na aba "Desativadas".</p></div>';
    } else {
        enabledContainer.innerHTML = enabledConfigs.map(config => {
            const campaign = campaigns.find(c => c.id === config.campaign_id);
            const name = campaign ? campaign.name : config.campaign_name || config.campaign_id;
            const status = campaign ? campaign.status : '';

            return `
            <div class="opt-config-card">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                    <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Otimizacao Manual</div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <a href="https://www.facebook.com/adsmanager/manage/campaigns?act=${(config.account_id||'').replace('act_','')}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;display:flex;align-items:center;gap:4px">↗ Meta</a>
                        <button class="btn btn-ghost btn-sm" onclick="toggleOptConfig('${config.campaign_id}', false)" style="font-size:11px;color:var(--danger)">Desativar</button>
                    </div>
                </div>
                <div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:16px">${esc(name)}</div>

                <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
                    <!-- Pause behavior toggle -->
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px">Comportamento para pausar:</div>
                        <div style="display:flex;gap:4px;background:var(--bg-secondary);border-radius:var(--radius-sm);padding:3px">
                            <button class="opt-toggle-btn ${config.pause_behavior === 'rigorous' ? 'active danger' : ''}" onclick="updateOptField('${config.campaign_id}','pause_behavior','rigorous')">Pausa Rigorosa</button>
                            <button class="opt-toggle-btn ${config.pause_behavior === 'flexible' ? 'active warning' : ''}" onclick="updateOptField('${config.campaign_id}','pause_behavior','flexible')">Pausa Flexivel</button>
                        </div>
                    </div>

                    <!-- Scale method toggle -->
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px">Metodo de escala:</div>
                        <div style="display:flex;gap:4px;background:var(--bg-secondary);border-radius:var(--radius-sm);padding:3px">
                            <button class="opt-toggle-btn ${config.scale_method === 'accelerated' ? 'active success' : ''}" onclick="updateOptField('${config.campaign_id}','scale_method','accelerated')">Escala Acelerada</button>
                            <button class="opt-toggle-btn ${config.scale_method === 'conservative' ? 'active info' : ''}" onclick="updateOptField('${config.campaign_id}','scale_method','conservative')">Escala Conservadora</button>
                        </div>
                    </div>

                    <!-- CPA max -->
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px">Custo por Conversao para PAUSAR (Conjunto de Anuncios)</div>
                        <div style="display:flex;align-items:center;gap:6px">
                            <span style="font-size:12px;color:var(--text-secondary)">BRL</span>
                            <input type="number" step="0.01" class="opt-inline-input" id="opt-cpa-${config.campaign_id}" value="${config.max_cpa.toFixed(2)}" onchange="updateOptCpa('${config.campaign_id}', this.value)">
                        </div>
                    </div>

                    <!-- Budget max -->
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:6px">Orcamento Diario Maximo da Campanha (CBO)</div>
                        <div style="display:flex;align-items:center;gap:6px">
                            <span style="font-size:12px;color:var(--text-secondary)">BRL</span>
                            <input type="number" step="0.01" class="opt-inline-input" id="opt-budget-${config.campaign_id}" value="${config.max_daily_budget_cbo.toFixed(2)}" onchange="updateOptBudget('${config.campaign_id}', this.value)">
                        </div>
                        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--text-secondary);cursor:pointer">
                            <input type="checkbox" ${config.unlimited_scale ? 'checked' : ''} onchange="updateOptField('${config.campaign_id}','unlimited_scale',this.checked)"> Escala Ilimitada
                        </label>
                    </div>

                    <!-- OPTIMIZE BUTTON -->
                    <div style="display:flex;align-items:center;margin-left:auto">
                        <button class="btn-optimize-green" onclick="runOptimize('${config.campaign_id}')">
                            <span style="font-size:16px">&#9654;</span> Otimizar
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    // Disabled / unconfigured campaigns
    const disabledCampaigns = campaigns.filter(c => !enabledIds.has(c.id));
    const disabledConfigs = _configs.filter(c => !c.enabled);

    if (disabledCampaigns.length === 0 && disabledConfigs.length === 0) {
        disabledContainer.innerHTML = '<div class="empty-state"><div class="icon">✅</div><h3>Todas as campanhas estao ativadas</h3></div>';
    } else {
        disabledContainer.innerHTML = disabledCampaigns.map(c => {
            const config = disabledConfigs.find(dc => dc.campaign_id === c.id);
            return `
            <div class="opt-config-card" style="opacity:0.7">
                <div class="opt-config-header">
                    <div class="opt-config-name">${esc(c.name)}</div>
                    <div style="display:flex;gap:8px">
                        <span class="badge badge-muted">${c.status}</span>
                        <button class="btn btn-outline btn-sm" onclick="openOptConfigModal('${c.id}', '${esc(c.name)}', '${_currentAccount}')">Configurar</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

// Quick inline config updates (no modal needed)
async function updateOptField(campaignId, field, value) {
    const config = _configs.find(c => c.campaign_id === campaignId);
    if (!config) return;
    try {
        await api(`/optimization/configs/${campaignId}`, 'PUT', { ...config, [field]: value });
        showToast('Configuracao atualizada', 'success');
        _configs = await api(`/optimization/configs?account_id=${_currentAccount}`);
        renderOptCampaigns();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function updateOptCpa(campaignId, value) {
    const cpa = parseFloat(value);
    if (!cpa || cpa <= 0) { showToast('CPA invalido', 'error'); return; }
    await updateOptField(campaignId, 'max_cpa', cpa);
}

async function updateOptBudget(campaignId, value) {
    const budget = parseFloat(value) || 0;
    await updateOptField(campaignId, 'max_daily_budget_cbo', budget);
}

function switchOptTab(tab) {
    const enabled = document.getElementById('opt-campaigns-enabled');
    const disabled = document.getElementById('opt-campaigns-disabled');
    const btns = document.querySelectorAll('#tab-optimization .tabs .tab-btn');

    if (tab === 'enabled') {
        enabled.style.display = 'flex';
        disabled.style.display = 'none';
        btns[0].classList.add('active');
        btns[1].classList.remove('active');
    } else {
        enabled.style.display = 'none';
        disabled.style.display = 'flex';
        btns[0].classList.remove('active');
        btns[1].classList.add('active');
    }
}

// ==================== OPT CONFIG MODAL ====================
function openOptConfigModal(campaignId, campaignName, accountId) {
    document.getElementById('modal-opt-campaign-id').value = campaignId;
    document.getElementById('modal-opt-account-id').value = accountId;
    document.getElementById('modal-opt-campaign-name').textContent = campaignName;

    const config = _configs.find(c => c.campaign_id === campaignId);

    if (config) {
        document.getElementById('modal-opt-pause').value = config.pause_behavior || 'flexible';
        document.getElementById('modal-opt-scale').value = config.scale_method || 'conservative';
        document.getElementById('modal-opt-max-cpa').value = config.max_cpa || '';
        document.getElementById('modal-opt-max-budget').value = config.max_daily_budget_cbo || '';
        document.getElementById('modal-opt-unlimited').checked = config.unlimited_scale || false;
        document.getElementById('btn-remove-opt').style.display = 'inline-flex';
    } else {
        document.getElementById('modal-opt-pause').value = _settings.default_pause_behavior || 'flexible';
        document.getElementById('modal-opt-scale').value = _settings.default_scale_method || 'conservative';
        document.getElementById('modal-opt-max-cpa').value = '';
        document.getElementById('modal-opt-max-budget').value = '';
        document.getElementById('modal-opt-unlimited').checked = false;
        document.getElementById('btn-remove-opt').style.display = 'none';
    }

    document.getElementById('modal-opt-config').classList.add('show');
}

async function saveOptConfig() {
    const campaignId = document.getElementById('modal-opt-campaign-id').value;
    const accountId = document.getElementById('modal-opt-account-id').value;
    const campaignName = document.getElementById('modal-opt-campaign-name').textContent;
    const maxCpa = parseFloat(document.getElementById('modal-opt-max-cpa').value);

    if (!maxCpa || maxCpa <= 0) {
        showToast('Informe o CPA maximo para pausar', 'error');
        return;
    }

    try {
        await api(`/optimization/configs/${campaignId}`, 'PUT', {
            campaign_name: campaignName,
            account_id: accountId,
            pause_behavior: document.getElementById('modal-opt-pause').value,
            scale_method: document.getElementById('modal-opt-scale').value,
            max_cpa: maxCpa,
            max_daily_budget_cbo: parseFloat(document.getElementById('modal-opt-max-budget').value) || 0,
            unlimited_scale: document.getElementById('modal-opt-unlimited').checked,
            enabled: true
        });

        closeModal('modal-opt-config');
        showToast('Configuracao salva!', 'success');
        await loadOptConfigs();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function removeOptConfig() {
    const campaignId = document.getElementById('modal-opt-campaign-id').value;
    if (!confirm('Remover configuracao de otimizacao?')) return;

    try {
        await api(`/optimization/configs/${campaignId}`, 'DELETE');
        closeModal('modal-opt-config');
        showToast('Configuracao removida', 'success');
        await loadOptConfigs();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function toggleOptConfig(campaignId, enabled) {
    const config = _configs.find(c => c.campaign_id === campaignId);
    if (!config) return;

    try {
        await api(`/optimization/configs/${campaignId}`, 'PUT', { ...config, enabled });
        showToast(enabled ? 'Otimizacao ativada' : 'Otimizacao desativada', 'success');
        await loadOptConfigs();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== OPTIMIZATION EXECUTION ====================
async function runOptimize(campaignId) {
    try {
        showOptProgress();
        await api(`/optimization/run/${campaignId}`, 'POST');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
        hideOptProgress();
    }
}

async function runOptimizeAll() {
    try {
        showOptProgress();
        await api('/optimization/run-all', 'POST');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
        hideOptProgress();
    }
}

function showOptProgress() {
    const el = document.getElementById('optimization-progress');
    el.style.display = 'block';
    document.getElementById('opt-progress-text').textContent = 'Otimizando...';
    document.getElementById('opt-progress-log').innerHTML = '';
    document.getElementById('btn-optimize-all').disabled = true;
    document.getElementById('btn-optimize-all').classList.add('running');
}

function hideOptProgress() {
    document.getElementById('btn-optimize-all').disabled = false;
    document.getElementById('btn-optimize-all').classList.remove('running');
}

// ==================== LOG ====================
async function loadOptLog() {
    try {
        const action = document.getElementById('log-filter-action')?.value || '';
        const params = new URLSearchParams();
        if (_currentAccount) params.set('account_id', _currentAccount);
        if (action) params.set('action', action);
        params.set('limit', '100');

        const logs = await api(`/optimization/log?${params}`);
        renderOptLog(logs);
    } catch (e) {
        document.getElementById('log-list').innerHTML = `<div class="empty-state"><p>Erro: ${esc(e.message)}</p></div>`;
    }
}

function renderOptLog(logs) {
    const container = document.getElementById('log-list');

    if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="icon">📜</div><h3>Nenhuma otimizacao registrada</h3><p>As acoes aparecerao aqui quando voce executar otimizacoes.</p></div>';
        return;
    }

    container.innerHTML = logs.map(l => {
        const iconClass = l.action.includes('pause') || l.action.includes('reduction') ? 'pause' :
            l.action.includes('scale') || l.action.includes('surf') ? 'scale' :
            l.action.includes('reactivate') ? 'reactivate' :
            l.success === false ? 'error' : 'info';

        const icon = iconClass === 'pause' ? '⏸' :
            iconClass === 'scale' ? '📈' :
            iconClass === 'reactivate' ? '▶️' :
            iconClass === 'error' ? '❌' : 'ℹ️';

        const time = new Date(l.timestamp);
        const timeStr = `${time.getHours().toString().padStart(2,'0')}:${time.getMinutes().toString().padStart(2,'0')}`;
        const dateStr = time.toLocaleDateString('pt-BR');

        return `
        <div class="log-item">
            <div class="log-icon ${iconClass}">${icon}</div>
            <div class="log-content">
                <div class="log-title">${esc(l.object_name || l.object_id)}</div>
                <div class="log-detail">${esc(l.reason)}</div>
                ${l.suffix ? `<div style="font-size:11px;color:var(--accent);margin-top:2px">Sufixo: ${esc(l.suffix)}</div>` : ''}
                ${!l.success ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">Erro: ${esc(l.error)}</div>` : ''}
            </div>
            <div class="log-time">${dateStr}<br>${timeStr}</div>
        </div>`;
    }).join('');
}

// ==================== SETTINGS ====================
function loadSettingsUI() {
    const s = _settings;
    const tokenEl = document.getElementById('settings-token-status');
    if (s.has_token) {
        tokenEl.textContent = `Configurado (${s.token_preview || '***'})`;
        tokenEl.style.color = 'var(--success)';
    } else {
        tokenEl.textContent = 'Nao configurado';
        tokenEl.style.color = 'var(--danger)';
    }

    document.getElementById('settings-auto-optimize').checked = s.auto_optimize || false;
    document.getElementById('settings-interval').value = s.optimization_interval_minutes || 30;
    document.getElementById('settings-default-pause').value = s.default_pause_behavior || 'flexible';
    document.getElementById('settings-default-scale').value = s.default_scale_method || 'conservative';

    // Render accounts
    const accContainer = document.getElementById('settings-accounts');
    if (_accounts.length === 0) {
        accContainer.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Nenhuma conta vinculada</p>';
    } else {
        accContainer.innerHTML = _accounts.map(a => `
        <div class="settings-row">
            <div>
                <div class="label">${esc(a.name || a.id)}</div>
                <div class="hint">${a.id} | ${a.currency || 'BRL'}</div>
            </div>
            <span class="badge ${a.status === 1 ? 'badge-success' : 'badge-warning'}">${a.status === 1 ? 'Ativa' : 'Status ' + a.status}</span>
        </div>
        `).join('');
    }
}

async function saveSettings() {
    try {
        await api('/settings', 'PUT', {
            auto_optimize: document.getElementById('settings-auto-optimize').checked,
            optimization_interval_minutes: parseInt(document.getElementById('settings-interval').value) || 30,
            default_pause_behavior: document.getElementById('settings-default-pause').value,
            default_scale_method: document.getElementById('settings-default-scale').value
        });
        showToast('Configuracoes salvas', 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

function showChangeTokenModal() {
    document.getElementById('modal-token-input').value = '';
    document.getElementById('modal-token').classList.add('show');
}

async function changeToken() {
    const token = document.getElementById('modal-token-input').value.trim();
    if (!token) return;

    try {
        await api('/token', 'PUT', { token });
        closeModal('modal-token');
        showToast('Token atualizado!', 'success');

        // Re-discover accounts
        await discoverAccounts();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function discoverAccounts() {
    try {
        await api('/accounts/discover', 'POST');
        _accounts = await api('/accounts');
        populateAccountSelect();
        loadSettingsUI();
        showToast(`${_accounts.length} contas encontradas`, 'success');
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== QUICK ACTIONS ====================
async function quickPause(objectId) {
    if (!confirm('Pausar este item?')) return;
    try {
        await api(`/actions/pause/${objectId}`, 'POST');
        showToast('Pausado com sucesso', 'success');
        await loadCampaigns();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

async function quickActivate(objectId) {
    if (!confirm('Ativar este item?')) return;
    try {
        await api(`/actions/activate/${objectId}`, 'POST');
        showToast('Ativado com sucesso', 'success');
        await loadCampaigns();
    } catch (e) {
        showToast(`Erro: ${e.message}`, 'error');
    }
}

// ==================== SOCKET.IO ====================
function setupSocketListeners() {
    socket.on('connect', () => {
        updateHeaderStatus('online');
    });

    socket.on('disconnect', () => {
        updateHeaderStatus('offline');
    });

    socket.on('optimization_progress', (data) => {
        const logEl = document.getElementById('opt-progress-log');
        if (logEl) {
            const line = document.createElement('div');
            line.textContent = `[${new Date(data.timestamp).toLocaleTimeString('pt-BR')}] ${data.message}`;
            line.style.padding = '2px 0';
            if (data.status === 'error') line.style.color = 'var(--danger)';
            if (data.status === 'action') line.style.color = 'var(--success)';
            logEl.appendChild(line);
            logEl.scrollTop = logEl.scrollHeight;
        }

        document.getElementById('opt-progress-text').textContent = data.message;

        // Add to sidebar
        addSidebarActivity(data.status === 'action' ? '⚡' : 'ℹ️', data.message);
    });

    socket.on('optimization_result', (result) => {
        hideOptProgress();
        showToast(`Otimizacao concluida: ${result.successful_actions || 0} acoes`, 'success');
        loadOptLog();
        loadDashboard();
    });

    socket.on('optimization_all_complete', (results) => {
        hideOptProgress();
        const total = results.reduce((s, r) => s + (r.total_actions || 0), 0);
        showToast(`Todas as campanhas otimizadas: ${total} acoes`, 'success');
        loadOptLog();
        loadDashboard();
    });

    socket.on('optimization_error', (data) => {
        hideOptProgress();
        showToast(`Erro na otimizacao: ${data.error}`, 'error');
    });

    socket.on('midnight_reset', (data) => {
        showToast(`Reset meia-noite: ${data.reactivated} itens reativados`, 'info');
        addSidebarActivity('🌙', `Reset meia-noite: ${data.reactivated} reativados`);
    });

    socket.on('settings_changed', () => {
        // Reload settings
        api('/settings').then(s => { _settings = s; loadSettingsUI(); });
    });
}

function updateHeaderStatus(status) {
    const el = document.getElementById('header-status');
    if (status === 'online' || (!status && socket.connected)) {
        el.innerHTML = '<span class="dot"></span> <span>Online</span>';
    } else if (status === 'offline') {
        el.innerHTML = '<span class="dot idle"></span> <span>Offline</span>';
    }
}

function addSidebarActivity(icon, text) {
    const container = document.getElementById('sidebar-activity');
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.innerHTML = `
        <span class="icon">${icon}</span>
        <div class="text">
            <div class="title">${esc(text)}</div>
        </div>
        <span class="time">${time}</span>
    `;

    // Remove initial empty message
    const first = container.firstElementChild;
    if (first && first.querySelector('.title')?.style.color) {
        container.removeChild(first);
    }

    container.insertBefore(item, container.firstChild);

    // Keep max 50 items
    while (container.children.length > 50) {
        container.removeChild(container.lastChild);
    }
}

// ==================== TABS ====================
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tabs > .tab-btn').forEach(el => el.classList.remove('active'));

    const tabEl = document.getElementById(`tab-${tab}`);
    if (tabEl) tabEl.classList.add('active');

    // Highlight the correct tab button
    const tabNames = ['dashboard', 'optimization', 'campaigns', 'log', 'settings'];
    const idx = tabNames.indexOf(tab);
    const btns = document.querySelector('.main-content > .tabs').querySelectorAll('.tab-btn');
    if (btns[idx]) btns[idx].classList.add('active');

    // Persist active tab
    localStorage.setItem('ks-active-tab', tab);
}

// ==================== MODAL ====================
function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// Close modals on overlay click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('show');
    }
});

// ==================== TOAST ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = '0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================== HELPERS ====================
function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function extractConversions(actions) {
    if (!actions || !Array.isArray(actions)) return 0;
    const a = actions.find(x =>
        x.action_type === 'lead' ||
        x.action_type === 'onsite_conversion.lead_grouped' ||
        x.action_type === 'offsite_conversion.fb_pixel_lead' ||
        x.action_type === 'offsite_conversion.fb_pixel_purchase' ||
        x.action_type === 'purchase'
    );
    return a ? parseInt(a.value) || 0 : 0;
}

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
}
