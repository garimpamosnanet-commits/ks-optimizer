/**
 * Optimization Scheduler
 * Runs periodic optimization and midnight resets
 */

const db = require('./database/db');

class Scheduler {
    constructor(optimizer, database, io) {
        this.optimizer = optimizer;
        this.io = io;
        this._interval = null;
        this._midnightTimeout = null;
        this._backupInterval = null;
    }

    start() {
        const settings = db.getSettings();
        const intervalMinutes = settings.optimization_interval_minutes || 15;
        const intervalMs = intervalMinutes * 60 * 1000;

        // Optimization interval — always runs, checks auto_optimize flag each cycle
        this._interval = setInterval(async () => {
            const currentSettings = db.getSettings();
            if (!currentSettings.auto_optimize) return;

            if (this.optimizer.isRunning()) {
                console.log('[Scheduler] Otimizacao ja em execucao, pulando...');
                return;
            }

            const configs = db.getCampaignConfigs().filter(c => c.enabled);
            if (configs.length === 0) return;

            console.log(`[Scheduler] Executando otimizacao automatica (${configs.length} campanhas habilitadas)...`);
            try {
                const results = await this.optimizer.optimizeAll();
                const totalActions = results.reduce((sum, r) => sum + (r.total_actions || 0), 0);
                console.log(`[Scheduler] Otimizacao concluida: ${configs.length} campanhas, ${totalActions} acoes`);

                if (this.io) {
                    this.io.emit('optimization_complete', {
                        campaigns: results.length,
                        total_actions: totalActions,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (e) {
                console.error('[Scheduler] Erro na otimizacao:', e.message);
            }
        }, intervalMs);

        console.log(`[Scheduler] Auto-otimizacao a cada ${intervalMinutes} min (auto_optimize=${settings.auto_optimize})`);


        // Midnight reset for temporary pauses
        this._scheduleMidnight();

        // Backup every 6 hours
        this._backupInterval = setInterval(() => {
            db.backup();
        }, 6 * 60 * 60 * 1000);

        // Initial backup
        setTimeout(() => db.backup(), 5000);
    }

    stop() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        if (this._midnightTimeout) {
            clearTimeout(this._midnightTimeout);
            this._midnightTimeout = null;
        }
        if (this._backupInterval) {
            clearInterval(this._backupInterval);
            this._backupInterval = null;
        }
    }

    restart() {
        this.stop();
        this.start();
    }

    _scheduleMidnight() {
        const now = new Date();
        // Next midnight in Sao Paulo (UTC-3)
        const midnight = new Date();
        midnight.setHours(24 + 3, 0, 0, 0); // Next day 00:00 BRT = 03:00 UTC

        if (midnight.getTime() - now.getTime() < 0) {
            midnight.setDate(midnight.getDate() + 1);
        }

        const delay = midnight.getTime() - now.getTime();

        this._midnightTimeout = setTimeout(async () => {
            console.log('[Scheduler] Meia-noite BRT - resetando pausas temporarias...');
            try {
                const count = await this.optimizer.resetTemporaryPauses();
                console.log(`[Scheduler] ${count} itens reativados`);

                if (this.io) {
                    this.io.emit('midnight_reset', {
                        reactivated: count,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (e) {
                console.error('[Scheduler] Erro no reset meia-noite:', e.message);
            }

            // Schedule next midnight
            this._scheduleMidnight();
        }, delay);

        console.log(`[Scheduler] Proximo reset meia-noite em ${Math.round(delay / 1000 / 60)} min`);
    }
}

module.exports = Scheduler;
