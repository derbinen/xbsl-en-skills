// Packs the sources of an Element project into a plain ZIP, the way the IDE exports a project:
// the console builds an image of it itself and gives the build its next number.
//
// The repository is laid out as {repository}/{Vendor}/{Name}/Project.yaml. The archive holds the
// project and every library project of the same repository, under the same relative paths -
// the platform resolves the imports of the project from them. Node.js built-ins only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import zlib from 'node:zlib';

const PROJECT_FILE_NAMES = ['Project.yaml', 'Проект.yaml'];
// tooling and editor leftovers are not sources; hidden entries are skipped as well
const SKIPPED = new Set(['node_modules', '__pycache__', 'Thumbs.db']);

/**
 * @param {string} dir
 * @returns {string | undefined} the project file of the folder, in either language
 */
export function projectFileOf(dir) {
    return PROJECT_FILE_NAMES.map(name => join(dir, name)).find(existsSync);
}

/**
 * The few top-level settings of a project file that matter here.
 * @param {string} dir - the folder with Project.yaml
 * @returns {{ dir: string, name: string, vendor: string, isLibrary: boolean }}
 */
export function describeProject(dir) {
    const file = projectFileOf(dir);
    if (!file) throw new Error(`${dir} holds no Project.yaml`);
    const settings = new Map();
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([^\s#][^:]*):\s*(.*)$/);
        if (match) settings.set(match[1].trim(), match[2].trim().replace(/^['"]|['"]$/g, ''));
    }
    const pick = (...keys) => keys.map(key => settings.get(key)).find(Boolean) || '';
    return {
        dir,
        name: pick('Name', 'Имя') || basename(dir),
        vendor: pick('Vendor', 'Поставщик') || basename(dirname(dir)),
        isLibrary: ['Library', 'Библиотека'].includes(pick('ProjectKind', 'ВидПроекта')),
    };
}

// The library projects lying next to the project: {repository}/*/*/Project.yaml.
function libraryProjects(repository, projectDir) {
    const found = [];
    for (const vendor of readdirSync(repository, { withFileTypes: true })) {
        if (!vendor.isDirectory() || vendor.name.startsWith('.') || SKIPPED.has(vendor.name)) continue;
        for (const project of readdirSync(join(repository, vendor.name), { withFileTypes: true })) {
            const dir = join(repository, vendor.name, project.name);
            if (!project.isDirectory() || resolve(dir) === resolve(projectDir) || !projectFileOf(dir)) continue;
            if (describeProject(dir).isLibrary) found.push(dir);
        }
    }
    return found;
}

function* filesOf(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* filesOf(path);
        else if (entry.isFile()) yield path;
    }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function checksum(data) {
    if (zlib.crc32) return zlib.crc32(data);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// A minimal ZIP: one deflated entry per file, names in UTF-8 (general purpose flag bit 11).
function zipOf(entries) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const { path, data } of entries) {
        const name = Buffer.from(path, 'utf8');
        const packed = zlib.deflateRawSync(data, { level: 9 });
        const fields = { crc: checksum(data), packed: packed.length, size: data.length };
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt16LE(8, 8);
        header.writeUInt16LE(dosTime, 10);
        header.writeUInt16LE(dosDate, 12);
        header.writeUInt32LE(fields.crc, 14);
        header.writeUInt32LE(fields.packed, 18);
        header.writeUInt32LE(fields.size, 22);
        header.writeUInt16LE(name.length, 26);
        parts.push(header, name, packed);

        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0800, 8);
        record.writeUInt16LE(8, 10);
        record.writeUInt16LE(dosTime, 12);
        record.writeUInt16LE(dosDate, 14);
        record.writeUInt32LE(fields.crc, 16);
        record.writeUInt32LE(fields.packed, 20);
        record.writeUInt32LE(fields.size, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(offset, 42);
        directory.push(record, name);
        offset += header.length + name.length + packed.length;
    }
    const directorySize = directory.reduce((size, part) => size + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...directory, end]);
}

/**
 * Packs the project with the libraries of its repository.
 * @param {string} projectDir - the folder with the project's Project.yaml
 * @returns {{ project: ReturnType<typeof describeProject>, libraries: ReturnType<typeof describeProject>[],
 *     files: number, archive: Buffer }}
 */
export function packSources(projectDir) {
    const project = describeProject(resolve(projectDir));
    const repository = dirname(dirname(project.dir));
    const libraries = libraryProjects(repository, project.dir).map(describeProject);
    const entries = [];
    for (const dir of [project.dir, ...libraries.map(library => library.dir)]) {
        for (const file of filesOf(dir)) {
            entries.push({ path: relative(repository, file).split(sep).join('/'), data: readFileSync(file) });
        }
    }
    return { project, libraries, files: entries.length, archive: zipOf(entries) };
}
