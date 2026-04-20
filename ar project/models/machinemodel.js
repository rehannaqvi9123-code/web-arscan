/**
 * MODEL: machineModel.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles all machine / KPI data fetching and normalisation from Supabase.
 * Extracted and cleaned up from the original single-file AR app.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const MachineModel = (() => {

    // ── KPI field definitions ─────────────────────────────────────────────────
    // Each entry maps a human-readable label to a list of possible DB column
    // names, covering common naming conventions.
    const KPI_DEFINITIONS = [
        { label: 'OEE',         keys: ['oee', 'OEE', 'overall_oee', 'oee_percent', 'oee_pct'],                    suffix: '%'     },
        { label: 'Output',      keys: ['output', 'units_produced', 'production_count', 'units', 'production'],     suffix: ' units'},
        { label: 'Efficiency',  keys: ['efficiency', 'efficiency_percent', 'eff'],                                 suffix: '%'     },
        { label: 'Temperature', keys: ['temperature', 'temp', 'temp_c', 'temperature_c'],                         suffix: '°C'   },
        { label: 'Power Usage', keys: ['power_usage', 'power', 'power_percent', 'power_kw'],                      suffix: '%'     },
        { label: 'Speed',       keys: ['speed', 'rpm', 'spindle_speed', 'shaft_speed'],                           suffix: ' RPM' },
        { label: 'Cycle Time',  keys: ['cycle_time', 'cycle_time_sec', 'ct', 'cycle'],                            suffix: ' sec' },
        { label: 'Downtime',    keys: ['downtime', 'downtime_percent', 'downtime_pct'],                            suffix: '%'    }
    ];

    // ── Internal state ────────────────────────────────────────────────────────
    let _machinesData = [];
    let _machinesMap  = new Map(); // QR code string → machine object

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Flatten nested JSON columns and embedded FK arrays into a single flat
     * object so KPI lookups work regardless of how data is stored.
     * @param {object} row - Raw Supabase row.
     * @returns {object} Flattened row.
     */
    function normalizeMachineRow(row) {
        if (!row || typeof row !== 'object') return {};
        let out = { ...row };

        // Merge plain JSON object columns
        const jsonCols = ['metrics', 'kpis', 'kpi', 'performance', 'data', 'stats', 'telemetry', 'values'];
        for (const key of jsonCols) {
            const v = row[key];
            if (v != null && typeof v === 'object' && !Array.isArray(v)) {
                out = { ...out, ...v };
            } else if (typeof v === 'string' && v.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(v);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        out = { ...out, ...parsed };
                    }
                } catch (_) { /* ignore malformed JSON */ }
            }
        }

        // Merge embedded FK relation arrays (PostgREST select with `*`)
        const embedCols = ['machine_kpis', 'kpis', 'kpi_metrics', 'metrics'];
        for (const key of embedCols) {
            const v = row[key];
            if (Array.isArray(v) && v.length > 0) {
                out = { ...out, ...normalizeMachineRow(v[0]) };
            }
        }

        return out;
    }

    /**
     * Pick the first defined, non-empty value matching any of the given keys.
     * @param {object}   obj  - Flattened machine object.
     * @param {string[]} keys - Candidate key names to try in order.
     * @returns {*} First matching value, or undefined.
     */
    function pickKpiValue(obj, keys) {
        for (const k of keys) {
            if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        }
        return undefined;
    }

    /**
     * Fetch a single related KPI row from `table` where `fk` equals `id`.
     * Tries multiple ordering columns gracefully (some may not exist).
     * @param {string} table - Related table name.
     * @param {string} fk    - Foreign key column name.
     * @param {*}      id    - Machine id value.
     * @returns {Promise<object|null>}
     */
    async function _tryFetchRelatedKpiRow(table, fk, id) {
        const { supabaseClient } = window.SupabaseModel;
        const attempts = [
            () => supabaseClient.from(table).select('*').eq(fk, id).order('created_at',  { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).order('recorded_at', { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).order('id',          { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).limit(1)
        ];

        for (const attempt of attempts) {
            const { data, error } = await attempt();
            if (!error && data && data.length > 0) return data[0];
        }
        return null;
    }

    /**
     * Merge data from well-known KPI-related tables into the machine object.
     * Silently skips tables that don't exist.
     * @param {object} machine - Base machine row from the machines table.
     * @returns {Promise<object>} Enriched, normalised machine object.
     */
    async function enrichMachineWithKpis(machine) {
        let merged = normalizeMachineRow({ ...machine });
        const id = merged.id ?? merged.machine_id;

        if (id === undefined || id === null) {
            console.warn('[MachineModel] No machine id — skipping KPI fetch');
            return merged;
        }

        const relatedTables = ['kpis', 'machine_kpis', 'kpi_metrics', 'metrics', 'machine_metrics', 'performance_data', 'machine_performance'];
        const foreignKeys   = ['machine_id', 'equipment_id', 'device_id'];

        for (const table of relatedTables) {
            for (const fk of foreignKeys) {
                const row = await _tryFetchRelatedKpiRow(table, fk, id);
                if (row) {
                    merged = { ...merged, ...normalizeMachineRow(row) };
                    console.log(`[MachineModel] Merged KPI data from "${table}" via "${fk}"`);
                    break; // FK found for this table — move to next table
                }
            }
        }

        return merged;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Fetch all machines from Supabase, trying embedded KPI selects first.
     * Populates internal state (_machinesData, _machinesMap).
     * @returns {Promise<{success: boolean, count: number, table: string, error: string|null}>}
     */
    async function loadAllMachines() {
        const { supabaseClient } = window.SupabaseModel;

        // 1. Try machines table with embedded KPI relations
        const embedSelects = ['*, machine_kpis(*)', '*, kpis(*)', '*, kpi_metrics(*)', '*'];
        let machines = null;

        for (const sel of embedSelects) {
            const { data, error } = await supabaseClient.from('machines').select(sel).limit(50);
            if (!error && data && data.length > 0) {
                machines = data;
                break;
            }
        }

        // 2. Fallback: try alternative table names
        const fallbackTables = ['assembly_machines', 'factory_machines', 'equipment', 'devices'];
        let activeTable = 'machines';

        if (!machines || machines.length === 0) {
            for (const tbl of fallbackTables) {
                const { data, error } = await supabaseClient.from(tbl).select('*').limit(50);
                if (!error && data && data.length > 0) {
                    machines    = data;
                    activeTable = tbl;
                    break;
                }
            }
        }

        if (!machines || machines.length === 0) {
            return { success: false, count: 0, table: activeTable, error: 'No machine data found in any table.' };
        }

        // 3. Normalise and index by QR code
        _machinesData = machines.map(normalizeMachineRow);
        _machinesMap.clear();

        _machinesData.forEach(machine => {
            const qrCode = machine.qr_code || machine.qrcode || machine.code || String(machine.id) || `MACHINE_${machine.id}`;
            _machinesMap.set(qrCode, machine);
        });

        console.log(`[MachineModel] Loaded ${_machinesData.length} machines from "${activeTable}"`);
        return { success: true, count: _machinesData.length, table: activeTable, error: null };
    }

    /**
     * Look up a machine by its QR code string.
     * Tries exact → case-insensitive → partial match (in that order).
     * @param {string} qrCode - Decoded QR string.
     * @returns {object|null} Machine object or null if not found.
     */
    function getMachineByQR(qrCode) {
        // Exact match
        if (_machinesMap.has(qrCode)) return _machinesMap.get(qrCode);

        // Case-insensitive match
        for (const [key, machine] of _machinesMap.entries()) {
            if (key.toLowerCase() === qrCode.toLowerCase()) return machine;
        }

        // Partial match (QR contains key, or key contains QR)
        for (const [key, machine] of _machinesMap.entries()) {
            if (key.includes(qrCode) || qrCode.includes(key)) return machine;
        }

        console.warn(`[MachineModel] No machine found for QR: "${qrCode}"`);
        return null;
    }

    /** @returns {string[]} All registered QR codes (for debug display). */
    function getRegisteredQRCodes() {
        return Array.from(_machinesMap.keys());
    }

    return {
        KPI_DEFINITIONS,
        normalizeMachineRow,
        pickKpiValue,
        enrichMachineWithKpis,
        loadAllMachines,
        getMachineByQR,
        getRegisteredQRCodes
    };

})();

window.MachineModel = MachineModel;
