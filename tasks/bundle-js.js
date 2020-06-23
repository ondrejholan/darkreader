const fs = require('fs-extra');
const os = require('os');
const rollup = require('rollup');
const rollupPluginCommonjs = require('@rollup/plugin-commonjs');
const rollupPluginNodeResolve = require('@rollup/plugin-node-resolve').default;
const rollupPluginReplace = require('@rollup/plugin-replace');
const rollupPluginTypescript = require('@rollup/plugin-typescript');
const typescript = require('typescript');
const {getDestDir} = require('./paths');
const reload = require('./reload');
const {PORT} = reload;
const {createTask} = require('./task');

async function copyToFF({cwdPath, debug}) {
    const destPath = `${getDestDir({debug})}/${cwdPath}`;
    const ffDestPath = `${getDestDir({debug, firefox: true})}/${cwdPath}`;
    await fs.copy(destPath, ffDestPath);
}

function replace(str, find, replace) {
    return str.split(find).join(replace);
}

function patchFirefoxJS(/** @type {string} */code) {
    code = replace(code, 'chrome.fontSettings.getFontList', `chrome['font' + 'Settings']['get' + 'Font' + 'List']`);
    code = replace(code, 'chrome.fontSettings', `chrome['font' + 'Settings']`);
    return code;
}

/**
 * @typedef JSEntry
 * @property {string} src
 * @property {string} dest
 * @property {string} reloadType
 * @property {({debug}) => Promise<void>} postBuild
 * @property {string[]} watchFiles
 */

/** @type {JSEntry[]} */
const jsEntries = [
    {
        src: 'src/background/index.ts',
        dest: 'background/index.js',
        reloadType: reload.FULL,
        async postBuild({debug}) {
            const destPath = `${getDestDir({debug})}/${this.dest}`;
            const ffDestPath = `${getDestDir({debug, firefox: true})}/${this.dest}`;
            const code = await fs.readFile(destPath, 'utf8');
            await fs.outputFile(ffDestPath, patchFirefoxJS(code));
        },
        watchFiles: null,
    },
    {
        src: 'src/inject/index.ts',
        dest: 'inject/index.js',
        reloadType: reload.FULL,
        async postBuild({debug}) {
            await copyToFF({cwdPath: this.dest, debug});
        },
        watchFiles: null,
    },
    {
        src: 'src/ui/devtools/index.tsx',
        dest: 'ui/devtools/index.js',
        reloadType: reload.UI,
        async postBuild({debug}) {
            await copyToFF({cwdPath: this.dest, debug});
        },
        watchFiles: null,
    },
    {
        src: 'src/ui/popup/index.tsx',
        dest: 'ui/popup/index.js',
        reloadType: reload.UI,
        async postBuild({debug}) {
            await copyToFF({cwdPath: this.dest, debug});
        },
        watchFiles: null,
    },
    {
        src: 'src/ui/stylesheet-editor/index.tsx',
        dest: 'ui/stylesheet-editor/index.js',
        reloadType: reload.UI,
        async postBuild({debug}) {
            await copyToFF({cwdPath: this.dest, debug});
        },
        watchFiles: null,
    },
];

async function getCached(src) {
    try {
        const file = `cache/${src.toString().replace(/(.tsx|.ts)/g, '').replace(/\//g, '-')}.json`;
        console.log(await fs.readFile(file) === undefined ? await fs.readFile(file) : {});
        return await fs.readFile(file) === undefined ? await fs.readFile(file) : {};
    } catch (err) {
        return false;
    }
    
}

async function bundleJS(/** @type {JSEntry} */entry, {debug, watch}) {
    const {src, dest} = entry;
    const bundle = await rollup.rollup({
        input: src,
        plugins: [
            rollupPluginNodeResolve(),
            rollupPluginCommonjs(),
            rollupPluginTypescript({
                typescript,
                tsconfig: 'src/tsconfig.json',
                removeComments: debug ? false : true,
                sourceMap: debug ? true : false,
            }),
            rollupPluginReplace({
                '__DEBUG__': debug ? 'true' : 'false',
                '__PORT__': watch ? String(PORT) : '-1',
                '__WATCH__': watch ? 'true' : 'false',
            }),
        ].filter((x) => x),
        cache: debug ? await getCached(src) : false,
    });
    if (debug) {
        const file = `cache/${src.toString().replace(/(.tsx|.ts)/g, '').replace(/\//g, '-')}.json`;
        console.log(bundle.cache);
        await 
        fs.outputFile(file, JSON.stringify(bundle.cache));
    }
    entry.watchFiles = bundle.watchFiles;
    await bundle.write({
        file: `${getDestDir({debug})}/${dest}`,
        strict: true,
        format: 'iife',
        sourcemap: debug ? 'inline' : false,
    });
    await entry.postBuild({debug});
}

function getWatchFiles() {
    const watchFiles = new Set();
    jsEntries.forEach((entry) => {
        entry.watchFiles.forEach((file) => watchFiles.add(file));
    });
    return Array.from(watchFiles);
}

/** @type {string[]} */
let watchFiles;

module.exports = createTask(
    'bundle-js',
    async ({debug, watch}) => {
        await Promise.all(
            jsEntries.map((entry) => bundleJS(entry, {debug, watch}))
        )
        fs.w
    },
).addWatcher(
    () => {
        watchFiles = getWatchFiles();
        return watchFiles;
    },
    async (changedFiles, watcher) => {
        const entries = jsEntries.filter((entry) => {
            return changedFiles.some((changed) => {
                return entry.watchFiles.includes(changed);
            });
        });
        await Promise.all(
            entries.map((e) => bundleJS(e, {debug: true, watch: true}))
        );

        const newWatchFiles = getWatchFiles();
        watcher.unwatch(
            watchFiles.filter((oldFile) => !newWatchFiles.includes(oldFile))
        );
        watcher.add(
            newWatchFiles.filter((newFile) => watchFiles.includes(newFile))
        );

        const isUIOnly = entries.every((entry) => entry.reloadType === reload.UI);
        reload({
            type: isUIOnly ? reload.UI : reload.FULL,
        });
    },
);
