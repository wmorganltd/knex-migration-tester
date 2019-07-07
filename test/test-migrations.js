'use strict';

const knexMigrate = require('knex-migrate');

const { resolve, join } = require('path');
const { readdirSync } = require('fs');

const Mocha = require('mocha');
const logger = console;

function getAllMigrations() {
    return readdirSync(resolve(__dirname, '../migrations'))
        .filter((f) => f.match(/\.js$/))
        .map((f) => f.replace(/.js$/, ''))
        .sort();
}

const ALL_MIGRATIONS = Object.freeze(getAllMigrations());

function getMigrationName(file) {
    return file.match(/^migrations\/(.*)$/)[1];
}

function migrateProgress({ action, migration }) {
    let symbol = action;
    if (action === 'migrate') {
        symbol = '\u25b2';
    } else if (action === 'revert') {
        symbol = '\u25bc';
    }
    const [migDate, ...migDescription] = getMigrationName(migration).split(/_/);
    const y = migDate.slice(0, 4);
    const m = migDate.slice(4, 6);
    const d = migDate.slice(6, 8);
    logger.info(`   ${symbol} ${[y, m, d].join('-')}: ${migDescription.join('_')}`);
}

function runMochaSuite(direction, name, client) {
    const migrationPath = join(__dirname, '../migrations/', name + '.js');

    function loadTests() {
        // eslint-disable-next-line global-require
        const migrationExports = require(migrationPath);
        const testName = direction === 'up' ? 'testUp' : 'testDown';
        const tests = migrationExports[testName] || (() => {});
        if (direction === 'up' && migrationExports.seed) {
            before('seed migration test', (done) => {
                migrationExports.seed(client).then(() => done());
            });
        }
        tests(client);
    }

    // You can even specify a test reporter to publish test results to your CI system:
    const mochaOptions = {
        reporter: 'mocha-junit-reporter',
        reporterOptions: {
            mochaFile: resolve(__dirname, '../.build/test-results.xml'),
        },
    };

    const mocha = new Mocha(mochaOptions);
    mocha.suite.title = direction + ': ' + name;
    mocha.suite.slow(500); // "slowness" threshold is 500ms
    mocha.suite.emit('pre-require', global, name, mocha);
    mocha.suite.emit('require', loadTests(), name, mocha);
    mocha.suite.emit('post-require', global, name, mocha);
    return new Promise((resolver, reject) => {
        mocha.run((failures) => {
            if (failures) {
                reject(new Error('Test suite failure in suite ' + mocha.suite.title));
            } else {
                resolver();
            }
        });
    });
}

async function beforeMain(knex) {
    // Ensure the migration table exists:
    await knex.migrate.currentVersion();
    // make sure we are at the initial migration
    logger.log('Setting up initial state');
    await knexMigrate('down', { to: 0, config: knex.client.config });
}

async function afterMain() {
    // noop for now
}

async function main(knex) {
    try {
        await beforeMain(knex);

        logger.log('Testing up migrations');
        // test going up
        await ALL_MIGRATIONS.reduce(async (prevMigration, migration) => {
            await prevMigration;
            await knexMigrate('up', { to: migration, config: knex.client.config }, migrateProgress);
            return runMochaSuite('up', migration, knex);
        }, Promise.resolve());

        logger.log('Testing down migrations');
        // test going down
        await ALL_MIGRATIONS.slice(0).reverse().reduce(async (prevMigration, migration) => {
            await prevMigration;
            await knexMigrate('down', { to: migration, config: knex.client.config }, migrateProgress);
            return runMochaSuite('down', migration, knex);
        }, Promise.resolve());
    } finally {
        await afterMain(knex);
    }
}

module.exports = main;
