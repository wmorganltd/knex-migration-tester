'use strict';

const logger = console;

const migrationTest = require('./test-migrations');
const spTest = require('./test-sp-definitions');
const { getFreshDatabase, purgeDatabase } = require('./support/db-utils');
const Knex = require('knex');
const KnexConfig = require('../knexfile').development;
const { resolve } = require('mssql/lib/connectionstring');
let knex;

async function beforeTests() {
    logger.info('Creating test DB');
    const dbConfig = await getFreshDatabase();
    logger.info('Test DB created: ' + dbConfig.name);
    knex = Knex({
        ...KnexConfig,
        connection: resolve(dbConfig.connectionString),
    });
    return knex.seed.run();
}

async function afterTests() {
    if (knex) {
        await purgeDatabase(knex.client.config.connection.database);
    }
}

async function runTests() {
    try {
        await beforeTests();
        await migrationTest(knex);
        await spTest(knex);
    } catch (err) {
        logger.error(err);
        process.exit(1);
    } finally {
        await afterTests();
    }
    process.exit(0);
}

runTests();
