const knexDbConfig = {

};

// Accommodate larger result sets time to complete in migrations:
knexDbConfig.requestTimeout = 30000;

module.exports = {
    development: {
        client: 'mssql',
        connection: knexDbConfig,
        pool: {
            min: 0,
            max: 7,
        },
        debug: false,
        migrations: {
            tableName: 'migrations',
            directory: 'migrations',
            stub: './migrations-support/js.stub',
        },
    },
};
