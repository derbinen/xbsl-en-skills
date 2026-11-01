// A client of the management console API (v2.1) of 1C:Enterprise.Element, as documented in
// "API commands" of the console help: a token by the client id and secret, valid for an hour,
// and Bearer calls. Node.js built-ins only.

// a console that does not answer must not hold the deploy for ever; an archive takes longer
const CALL_TIMEOUT_MS = 2 * 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export class ConsoleError extends Error {
    name = 'ConsoleError';
}

/**
 * @typedef {object} ConsoleTask
 * @property {string} id
 * @property {string} status - `InProgress`, `Completed`, `Failed`
 * @property {string} [error-message]
 */

export class ConsoleClient {
    #baseUrl;
    #clientId;
    #clientSecret;
    #token = '';

    /**
     * @param {{ baseUrl?: string, clientId?: string, clientSecret?: string }} settings
     */
    constructor({ baseUrl, clientId, clientSecret }) {
        if (!baseUrl || !clientId || !clientSecret) {
            throw new ConsoleError('ELEMENT_BASE_URL, ELEMENT_CLIENT_ID and ELEMENT_CLIENT_SECRET are required');
        }
        this.#baseUrl = baseUrl.replace(/\/+$/, '');
        this.#clientId = clientId;
        this.#clientSecret = clientSecret;
    }

    async #signIn() {
        const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
        const response = await fetch(`${this.#baseUrl}/console/sys/token`, {
            method: 'POST',
            headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const answer = await response.json().catch(() => ({}));
        // the answer also carries an access_token of "Not implemented": the token is id_token
        if (!response.ok || !answer.id_token) {
            throw new ConsoleError(`sign-in refused (HTTP ${response.status}): check the client id and secret`);
        }
        this.#token = answer.id_token;
    }

    /**
     * One call of the API; an expired token (401) is renewed once and the call repeated.
     * @param {string} method
     * @param {string} path - after `/console/api/v2.1`
     * @param {{ json?: unknown, file?: Buffer, query?: Record<string, string | undefined> }} [request]
     * @returns {Promise<any>} the parsed answer, its text when it is not JSON, or null when empty
     */
    async call(method, path, { json, file, query } = {}) {
        if (!this.#token) await this.#signIn();
        const search = query ? new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString() : '';
        const url = `${this.#baseUrl}/console/api/v2.1${path}${search ? `?${search}` : ''}`;
        for (let attempt = 1; ; attempt++) {
            const headers = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
            let body;
            if (json !== undefined) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(json);
            } else if (file !== undefined) {
                headers['Content-Type'] = 'application/octet-stream';
                body = file;
            }
            const signal = AbortSignal.timeout(file ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS);
            const response = await fetch(url, { method, headers, body, signal });
            if (response.status === 401 && attempt === 1) {
                await this.#signIn();
                continue;
            }
            const text = await response.text();
            let answer = text;
            try {
                answer = text ? JSON.parse(text) : null;
            } catch {
                // a plain-text answer is kept as it came
            }
            if (!response.ok) {
                const detail = typeof answer === 'string' ? answer : JSON.stringify(answer);
                throw new ConsoleError(`${method} ${path}: HTTP ${response.status} ${detail}`);
            }
            return answer;
        }
    }

    /** @param {string} id */
    application(id) {
        return this.call('GET', `/applications/${id}`);
    }

    /** @param {string} id */
    status(id) {
        return this.call('GET', `/applications/${id}/status`);
    }

    /** @param {string} id */
    start(id) {
        return this.call('POST', `/applications/${id}/status/start`);
    }

    /**
     * Adds a file of a build or a plain archive of the sources to a project: the platform builds
     * and numbers it.
     * @param {string} projectId
     * @param {Buffer} file
     * @param {Record<string, string | undefined>} [metadata] - branch-name, commit-id, commit-message, modified
     * @returns {Promise<Array<Record<string, any>>>} the builds made - the application's and its extensions'
     */
    addBuild(projectId, file, metadata = {}) {
        return this.call('POST', `/projects/${projectId}/assemblies`, { file, query: metadata });
    }

    /**
     * Updates an application to a build of its project; the answer carries the `current-task`.
     * @param {string} applicationId
     * @param {string} projectId
     * @param {string} assemblyVersion
     */
    update(applicationId, projectId, assemblyVersion) {
        return this.call('POST', `/applications/${applicationId}/project/update`, {
            json: { sources: [{ 'project-id': projectId, 'assembly-version': assemblyVersion }] },
        });
    }

    /**
     * @param {string} id
     * @returns {Promise<ConsoleTask>}
     */
    task(id) {
        return this.call('GET', `/tasks/application-tasks/${id}`);
    }
}
