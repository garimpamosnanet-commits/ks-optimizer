module.exports = function setupWebSocket(io, metaAPI, optimizer, database) {
    io.on('connection', (socket) => {
        console.log(`[WS] Cliente conectado: ${socket.id}`);

        // Send current optimization status
        socket.emit('optimization_status', {
            running: optimizer.isRunning(),
            last_run: optimizer.getLastRun()
        });

        // Request optimization for a campaign
        socket.on('optimize_campaign', async (data) => {
            const { campaign_id } = data;
            if (!campaign_id) return;

            if (optimizer.isRunning()) {
                socket.emit('optimization_error', { error: 'Otimizacao ja em execucao' });
                return;
            }

            try {
                const result = await optimizer.optimizeCampaign(campaign_id);
                io.emit('optimization_result', result);
            } catch (e) {
                socket.emit('optimization_error', { error: e.message });
            }
        });

        // Request optimization for all
        socket.on('optimize_all', async () => {
            if (optimizer.isRunning()) {
                socket.emit('optimization_error', { error: 'Otimizacao ja em execucao' });
                return;
            }

            try {
                const results = await optimizer.optimizeAll();
                io.emit('optimization_all_complete', results);
            } catch (e) {
                socket.emit('optimization_error', { error: e.message });
            }
        });

        // Fetch fresh data
        socket.on('refresh_campaigns', async (data) => {
            try {
                const { account_id } = data;
                const campaigns = await metaAPI.getCampaigns(account_id);
                socket.emit('campaigns_data', { account_id, campaigns });
            } catch (e) {
                socket.emit('api_error', { error: e.message });
            }
        });

        socket.on('refresh_insights', async (data) => {
            try {
                const { object_id, date_preset } = data;
                const insights = await metaAPI.getInsights(object_id, {
                    date_preset: date_preset || 'last_7d'
                });
                socket.emit('insights_data', { object_id, insights });
            } catch (e) {
                socket.emit('api_error', { error: e.message });
            }
        });

        socket.on('disconnect', () => {
            console.log(`[WS] Cliente desconectado: ${socket.id}`);
        });
    });
};
