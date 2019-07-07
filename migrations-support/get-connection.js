const mssql = require('mssql');

function getConnection({ logger }) {
    return new mssql.Connection();
}

module.exports = {
    getConnection,
};
