const jsdiff = require('diff');
const { getProcedureDefinition } = require('../../migrations-support/get-procedure-definition');

const ALTER_PROCEDURE_REGEX = /^ALTER PROCEDURE ([\w._[\]]+)\s?/im;
const CREATE_PROCEDURE_REGEX = /^CREATE PROCEDURE ([\w._[\]]+)\s?/im;
const DROP_PROCEDURE_REGEX = /^DROP PROCEDURE ([\w._[\]]+)\s?/im;

function KnexCollector() {
    const collector = this;
    this.sql = [];
    async function trapSchemaRaw(sql) {
        collector.sql.push(sql);
        return collector;
    }
    const proxyTarget = () => {};
    Object.assign(proxyTarget, {
        getCollectedSQL() {
            return collector.sql.join('\n');
        },
        getProcedureAlterations() {
            return KnexCollector.matchProcedures(collector.sql, ALTER_PROCEDURE_REGEX);
        },
        getProcedureCreations() {
            return KnexCollector.matchProcedures(collector.sql, CREATE_PROCEDURE_REGEX);
        },
        getProcedureDrops() {
            return KnexCollector.matchProcedures(collector.sql, DROP_PROCEDURE_REGEX);
        },
    });

    const proxy = new Proxy(proxyTarget, {
        apply() {
            return proxy;
        },
        get(target, name) {
            if (name === 'schema') {
                // schema sql collection
                return new Proxy({}, {
                    get(subTarget, subName) {
                        if (subName === 'raw') {
                            return trapSchemaRaw;
                        }
                        return () => Promise.resolve(collector); // noop
                    },
                });
            }
            if (name === 'raw') {
                // resolve to a faux result set
                return () => Promise.resolve([]);
            }
            if (name === 'then') {
                // copy thenable signature resolving to faux result set
                return (cb) => cb([]);
            }
            if (name in target) {
                return target[name];
            }
            // for everything else, immediately pass back to the proxy
            return () => proxy;
        },
    });
    return proxy;
}
KnexCollector.matchProcedures = function matchProcedures(sql, pattern) {
    return sql.reduce((procMap, s) => {
        const match = s.match(pattern);
        if (match === null) {
            return procMap;
        }
        return Object.assign(procMap, {
            [match[1]]: s,
        });
    }, {});
};

/**
 * Run SQL collection on a migration's up and down functions
 * @param migrationModule
 */
async function collectSQL(migrationModule) {
    const { up, down } = migrationModule;
    const upCollector = new KnexCollector();
    const downCollector = new KnexCollector();
    await Promise.all([
        up(upCollector),
        down(downCollector),
    ]);
    return {
        upCollector,
        downCollector,
    };
}

/**
 * Normalise SP SQL
 * This is done by making sure the SP definition is contained in a single line
 * and whitespace is applied consistently so we can diff without formatting being evaluated
 *
 * @param {string} sql
 * @param {boolean} [normaliseCreate]
 * @param {boolean} [multiLine]
 * @returns {*}
 */
function normaliseSP(sql, normaliseCreate, multiLine) {
    let normalisedSQL = sql
        // remove comment lines
        .replace(/^--.*/gm, '');
    if (!multiLine) {
        normalisedSQL = normalisedSQL
            // new lines and multiple spaces to single space
            .replace(/\s+/g, ' ')
            // remove spaces after opening brackets
            .replace(/\(\s+/g, '(')
            // remove spaces before closing brackets
            .replace(/\s+\)/g, ')');
    }
    normalisedSQL = normalisedSQL
        // remove leading and trailing whitespace
        .trim();
    if (normaliseCreate) {
        // replace "CREATE PROCEDURE" with "ALTER PROCEDURE"
        normalisedSQL = normalisedSQL.replace(/^CREATE PROCEDURE/, 'ALTER PROCEDURE');
    }
    return normalisedSQL;
}

/**
 * For a given procedureName, check the down function restores the precise existing state of the SP
 * Depends on the DB being in the state immediately prior to the up function's application
 * @param {string} procedureName
 * @param downSQL
 * @returns {Promise.<null|string>} null for "success", string if a diff found (should error)
 */
async function compareDownAndExisting(procedureName, downSQL) {
    const oldProcedureSQL = (
        await getProcedureDefinition(procedureName)
    );

    // The SQL is stored with CREATE syntax it is also stored (and written) over multiple lines
    // we normalise the SQL to make sure we are comparing the "functional" SQL
    if (normaliseSP(oldProcedureSQL, true) === normaliseSP(downSQL)) {
        return null;
    }

    return jsdiff.createTwoFilesPatch(
        'Existing database definition',
        'Down migration definition',
        normaliseSP(oldProcedureSQL, true, true),
        normaliseSP(downSQL, false, true),
    );
}

function compareUpAndDown(procedureName, upSQL, downSQL) {
    return jsdiff.createTwoFilesPatch(
        procedureName + ' migration down',
        procedureName + ' migration up',
        downSQL,
        upSQL,
    );
}

/**
 * Display a diff of the entire SQL, then check more stringently for stored procedures.
 * @param {string} migrationName - the name of the migration file
 * @param {{up,down}} migrationModule - the required migration
 * @returns {Promise.<{diff_up_down, changed_sps: Array, errors: Array}>}
 */
async function getMigrationSQLDiffs(migrationName, migrationModule) {
    const { upCollector, downCollector } = await collectSQL(migrationModule);

    const upSQL = upCollector.getCollectedSQL();
    const downSQL = downCollector.getCollectedSQL();
    const upProcAlterations = upCollector.getProcedureAlterations();
    const downProcAlterations = downCollector.getProcedureAlterations();
    const upProcNames = Object.keys(upProcAlterations);
    const downProcNames = Object.keys(downProcAlterations);

    const integrityErrors = [];

    // Procedures should be altered, not dropped and created:
    const upCreates = Object.keys(upCollector.getProcedureCreations());
    const upDrops = Object.keys(upCollector.getProcedureDrops());
    const doesDropAndCreate = upCreates.some((sp) => upDrops.includes(sp));

    if (doesDropAndCreate) {
        integrityErrors.push({
            message: 'Stored procedures should be changed with ALTER, not DROP then CREATE',
            output: JSON.stringify({ upCreates, upDrops }, null, 4),
        });
    }

    // Procedure up:down alterations should match:
    const doProcAltersMatch = upProcNames.length === downProcNames.length
        && upProcNames.every((sp) => downProcNames.includes(sp));

    if (!doProcAltersMatch) {
        integrityErrors.push({
            message: 'Alteration statements do not match',
            output: JSON.stringify({ upProcNames, downProcNames }, null, 4),
        });
    }

    // For every procedure we detect has changed, compare the existing SP against the down portion:
    const procedureDiffChecks = await Promise.all(downProcNames.map((procedureName) => {
        const procDownSQL = downProcAlterations[procedureName];
        return compareDownAndExisting(procedureName, procDownSQL);
    }));

    // If we are left with an empty array because null (success) was returned, everything is good.
    const existingSPDiffs = procedureDiffChecks.filter((result) => result !== null);
    if (existingSPDiffs.length) {
        integrityErrors.push({
            message: 'The "down" portion of the migration does not exactly restore the previous state',
            output: existingSPDiffs.join('\n'),
        });
    }

    return {
        diff_up_down: compareUpAndDown(migrationName, upSQL, downSQL),
        changed_sps: upProcNames,
        errors: integrityErrors,
    };
}

module.exports = {
    getMigrationSQLDiffs,
};
