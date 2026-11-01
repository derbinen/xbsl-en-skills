#!/usr/bin/env node
// Deploys the sources of an Element project to a cloud application through the management
// console API (v2.1):
//   1. pack the project and the libraries of its repository into a plain ZIP;
//   2. add it to the console project - the console builds it and numbers the build;
//   3. update the application to that build and follow the update task to its end;
//   4. make sure the application runs that build.
// A failed update is reported with the platform's own message and an exit code of 1.
//
//   node deploy.mjs --project-dir <folder with Project.yaml> [options]
//
//   --env <file>          settings file (default: .env of the current folder)
//   --app-id <id>         the application (default: ELEMENT_APP_ID)
//   --project-id <id>     the console project (default: ELEMENT_PROJECT_ID)
//   --message <text>      a comment kept with the build (default: the last git commit)
//   --dry-run             pack only; with --save, write the archive to that file
//   --save <file>         also keep the archive that was sent
//
// Settings: ELEMENT_BASE_URL, ELEMENT_CLIENT_ID, ELEMENT_CLIENT_SECRET, ELEMENT_APP_ID,
// ELEMENT_PROJECT_ID. Node.js 20.12+ (reads .env itself), no packages.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ConsoleClient } from './console.mjs';
import { packSources } from './sources.mjs';

// process.loadEnvFile came in 20.12; on an older Node the failure would not name the cause
const NODE_NEEDED = [20, 12];
const UPDATE_LIMIT_MS = 15 * 60_000;
const START_LIMIT_MS = 5 * 60_000;
const POLL_MS = 5_000;

class DeployError extends Error {
    name = 'DeployError';
}

/** The comment at the head of this file, without the shebang: the comments inside are not help. */
function usage() {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
    const head = lines.slice(0, lines.findIndex(line => !line.startsWith('//')));
    return head.map(line => line.replace(/^\/\/ ?/, '')).join('\n');
}

/**
 * Branch, commit, its subject and whether the working copy differs from it, for the build's
 * record; empty outside a git working copy.
 * @param {string} dir
 */
function gitOf(dir) {
    const git = args => {
        try {
            return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return '';
        }
    };
    const commit = git(['rev-parse', 'HEAD']);
    return {
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        commit,
        subject: git(['log', '-1', '--format=%s']),
        // the sources sent are those of the working copy: uncommitted changes make them another
        modified: Boolean(commit) && git(['status', '--porcelain', '--', '.']) !== '',
    };
}

/**
 * Follows the task the update started until it ends.
 * @param {ConsoleClient} client
 * @param {string | undefined} taskId - from the answer of the update; without it, the current task
 * @param {string} applicationId
 * @returns {Promise<string>} the error of a failed update, empty on success
 */
async function followTask(client, taskId, applicationId) {
    const deadline = Date.now() + UPDATE_LIMIT_MS;
    let shown = '';
    while (Date.now() < deadline) {
        const task = taskId ? await client.task(taskId) : (await client.status(applicationId))['current-task'];
        const state = task?.status || '';
        if (state && state !== shown) {
            console.log(`  update: ${state}`);
            shown = state;
        }
        if (state === 'Completed') return '';
        if (state === 'Failed') return task['error-message'] || 'the update failed without a message';
        // no task to follow: the build the application runs decides at the end
        if (!task && !taskId) return '';
        await pause(POLL_MS);
    }
    return `no result in ${UPDATE_LIMIT_MS / 60_000} minutes - see the tasks of the application in the console`;
}

/**
 * Starts the application when the update left it stopped, and waits for it to run.
 * @param {ConsoleClient} client
 * @param {string} applicationId
 */
async function ensureRunning(client, applicationId) {
    let { status } = await client.status(applicationId);
    if (status === 'Running') return;
    console.log(`> The application is ${status}: starting it...`);
    await client.start(applicationId);
    const deadline = Date.now() + START_LIMIT_MS;
    while (Date.now() < deadline) {
        await pause(POLL_MS);
        ({ status } = await client.status(applicationId));
        if (status === 'Running') return;
        if (status === 'Error') throw new DeployError('the application went into Error on start');
    }
    throw new DeployError(`the application did not start in ${START_LIMIT_MS / 60_000} minutes`);
}

async function main() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor < NODE_NEEDED[1])) {
        throw new DeployError(`Node.js ${NODE_NEEDED.join('.')} or newer is needed, this is ${process.versions.node}: update Node.js`);
    }
    const { values: options } = parseArgs({
        options: {
            'project-dir': { type: 'string' },
            env: { type: 'string' },
            'app-id': { type: 'string' },
            'project-id': { type: 'string' },
            message: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            save: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!options['project-dir']) throw new DeployError('--project-dir is required (see --help)');

    const envFile = resolve(options.env ?? '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    else if (options.env) throw new DeployError(`no settings file ${envFile}`);

    const pack = packSources(options['project-dir']);
    const extra = pack.libraries.length ? ` with ${pack.libraries.map(library => library.name).join(', ')}` : '';
    console.log(`> Packed ${pack.project.vendor}::${pack.project.name}${extra}: ${pack.files} files, ${Math.ceil(pack.archive.length / 1024)} KB`);
    if (pack.project.isLibrary) throw new DeployError('this is a library project: deploy the application that uses it');
    if (options.save) writeFileSync(resolve(options.save), pack.archive);
    if (options['dry-run']) {
        console.log('Dry run: nothing sent.');
        return;
    }

    const applicationId = options['app-id'] || process.env.ELEMENT_APP_ID;
    const projectId = options['project-id'] || process.env.ELEMENT_PROJECT_ID;
    if (!applicationId || !projectId) {
        throw new DeployError('the application and the project are needed: ELEMENT_APP_ID and ELEMENT_PROJECT_ID');
    }
    const client = new ConsoleClient({
        baseUrl: process.env.ELEMENT_BASE_URL,
        clientId: process.env.ELEMENT_CLIENT_ID,
        clientSecret: process.env.ELEMENT_CLIENT_SECRET,
    });

    const git = gitOf(pack.project.dir);
    const builds = await client.addBuild(projectId, pack.archive, {
        'branch-name': git.branch,
        'commit-id': git.commit,
        'commit-message': options.message ?? git.subject,
        modified: git.modified ? 'true' : '',
    });
    const build = (Array.isArray(builds) ? builds : [builds])
        .find(item => item['project-name'] === pack.project.name && item['vendor-name'] === pack.project.vendor);
    if (!build) throw new DeployError(`the console made no build of ${pack.project.name}: ${JSON.stringify(builds)}`);
    const version = build['assembly-version'];
    console.log(`> Build ${version} added to the project`);

    console.log('> Updating the application...');
    const answer = await client.update(applicationId, projectId, version);
    const failure = await followTask(client, answer?.['current-task']?.id, applicationId);
    if (failure) throw new DeployError(`the platform did not apply the build - the application keeps the previous one.\n${failure}`);

    await ensureRunning(client, applicationId);
    // the task is the platform's word; the build the application runs is the proof
    const application = await client.application(applicationId);
    const running = application['application-project']?.['assembly-version'];
    if (running !== version) throw new DeployError(`the application runs ${running || 'an unknown build'}, not ${version}`);
    console.log(`\nDeployed ${version}: ${application.uri || applicationId}`);
}

// the exit code is set, not forced: the output already written is flushed before the process ends
main().catch(error => {
    console.error(`\nNot deployed: ${error.message}`);
    process.exitCode = 1;
});
