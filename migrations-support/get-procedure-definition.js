const mssql = require('mssql');
const { getConnection } = require('./get-connection');

const logger = console;

/**
 * @param {string} procedureName
 * @returns {Promise<string>}
 */
async function getProcedureDefinition(procedureName) {
    if (!procedureName) {
        throw new Error('Please define a procedure name');
    }
    const conn = await getConnection({ logger });
    const request = new mssql.Request(conn);
    // returns the SP definition code as a staggered result set
    const result = await request.query(`EXEC sp_helptext '${procedureName}'`);
    if (!result.recordset.length) {
        throw new Error(`No procedure results for ${procedureName}`);
    }
    return result.recordset.map((set) => set.Text).join('');
}

module.exports = {
    getProcedureDefinition,
};
