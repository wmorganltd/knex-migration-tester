const knexMigrate = require('knex-migrate');
const { execSync } = require('child_process');
const { resolve } = require('path');
const { readdirSync } = require('fs');

const { getMigrationSQLDiffs } = require('./support/sql-diffs');

const logger = console;

/**
 * @returns {string[]} all JS files inside the migrations directory
 */
function getAllMigrations() {
    return readdirSync(resolve(__dirname, '../migrations'))
        .filter((f) => f.match(/\.js$/))
        .map((f) => f.replace(/.js$/, ''))
        .sort();
}

const ALL_MIGRATIONS = Object.freeze(getAllMigrations());

/**
 * @returns {string[]} list of migration files that have changed according to git
 */
function getChangedMigrations() {
    return execSync('git diff --name-only origin/develop --diff-filter=AM', {
        cwd: resolve(__dirname, '..'),
    }).toString()
        .split('\n')
        .filter((f) => f.match(/^migrations\//))
        .sort();
}

/**
 * @returns {string} given the target, return the preceding migration, if any
 */
function getPreviousMigration(target) {
    const currentIndex = ALL_MIGRATIONS.indexOf(target);
    if (currentIndex === -1) {
        throw new Error('No such migration: ' + target);
    }
    return ALL_MIGRATIONS[currentIndex - 1];
}

/**
 * @returns {string} name of migration (i.e. without any path or extension)
 */
function getMigrationName(file) {
    return file.replace(/.js$/, '').match(/^migrations\/(.*)$/)[1];
}

/**
 * vanity progress handler for migration run output
 */
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


/**
 * @param {string} migrationFile path
 * @throws Error when the SQL integrity check fails
 * @returns {Promise<Array|*>} any changed SPs for reference
 */
async function assertSQLDiffIntegrity(migrationFile) {
    const migrationModule = require(migrationFile); // eslint-disable-line global-require
    const compared = await getMigrationSQLDiffs(migrationFile, migrationModule);
    const {
        diff_up_down,
        changed_sps,
        errors,
    } = compared;
    if (!changed_sps.length && !errors.length) {
        return;
    }
    logger.info('Raw SQL difference\n', diff_up_down);
    logger.info('Changed SPs\n', changed_sps);
    if (errors.length) {
        errors.forEach((error) => {
            logger.error(error.message, '\n', error.output);
        });
        throw new Error('Asserting migration SQL integrity failed');
    }
    return changed_sps;
}

/**
 *
 * @param knex
 * @returns {Promise<*|undefined>}
 */
async function testMigrationSequence(knex) {
    // Test all the way up for any obvious SQL problems:
    logger.info('Initialising migrations with latest');

    // Trigger some internal magic to ensure the migrations table exists
    await knex.migrate.currentVersion();

    logger.info('Restoring initial database state');

    await knexMigrate('down', { to: 0, config: knex.client.config }, migrateProgress);

    // Obtain our changed migrations, run each atomically and test for SP diff integrity:
    const changedMigrations = getChangedMigrations();

    if (!changedMigrations.length) {
        logger.info('No changed migrations, proceeding to latest state');
        return knexMigrate('up', { config: knex.client.config }, migrateProgress);
    }
    logger.info('Testing changed migrations for SQL alterations:');

    /*
    In series, iterate through each migration that has changed:
    - compare up and down
    - output the SQL difference
    We need to migrate to the *prior* migration so that we can accurately test it.
    Provided asserting passes, then we run the up migration against it.
     */
    await changedMigrations.reduce(async (lastTest, migrationFile) => {
        await lastTest;
        const migrateTo = getPreviousMigration(getMigrationName(migrationFile));
        await knexMigrate('up', {
            to: migrateTo,
            config: knex.client.config,
        }, migrateProgress);
        logger.info('Asserting stored procedure integrity for', migrationFile);
        return assertSQLDiffIntegrity(resolve(__dirname, '..', migrationFile));
    }, Promise.resolve());

    return knexMigrate('up', { config: knex.client.config }, migrateProgress);
}

module.exports = testMigrationSequence;
