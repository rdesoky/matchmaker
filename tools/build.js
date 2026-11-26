'use strict';

/**
 * Build dist/ from the static source tree.
 *
 *   node tools/build.js [--env=dev|staging|prod] [--source=<private repo root>]
 *                       [--base=/subpath] [--no-cname]
 *
 * Steps:
 *   1. clean dist/
 *   2. copy allowed static files (never PHP/Perl/Python/secrets)
 *   3. compile Sass (.scss) -> CSS
 *   4. compile string XML -> JSON
 *   5. write environment-specific config.js
 *   6. minify JS/HTML and write a source map next to every JS file
 *   7. write CNAME for the selected environment
 *
 * --base rewrites root-absolute URLs to a subpath so the build can be previewed
 * on a GitHub Pages project site (https://<user>.github.io/<repo>/). Production
 * and staging use the default empty base, because they are served from a domain
 * root.
 *
 * --no-cname skips the CNAME file. A GitHub Pages project site is served from
 * <user>.github.io/<repo>/ and must not claim a custom domain: a CNAME there
 * makes Pages try to provision a TLS certificate for a host that has no HTTPS,
 * which fails and leaves the site stuck on "certificate does not exist yet".
 */

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { compileStrings } = require('./compile-strings');
const { compileData } = require('./compile-data');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// dev uses the same-origin prefix, which tools/serve.js proxies to the API
// host. staging and prod call the API host directly.
//
// At runtime, shared/config.js overrides apiBase back to /cgi-bin/ when the
// page is served from localhost or 127.0.0.1, so a local preview of any
// environment build stays same-origin and goes through the serve proxy.
//
// The base is scheme-relative (//api.kobool.com) so it inherits the page's own
// scheme: http today, https once TLS is terminated in front of the API host.
const ENVIRONMENTS = {
    dev: { apiBase: '/cgi-bin/', cname: null },
    staging: { apiBase: '//api.kobool.com/cgi-bin/', cname: 'staging.kobool.com' },
    prod: { apiBase: '//api.kobool.com/cgi-bin/', cname: 'www.kobool.com' }
};

// Never copied into dist/, regardless of where they appear.
// .xml is excluded because string sources are compiled to JSON; shipping the
// raw XML would duplicate every string and leak unreferenced content.
// .scss is excluded because compileStyles() turns it into the .css the pages
// actually link; copying the source would ship dead weight and leak the
// partials.
const BLOCKED_EXTENSIONS = new Set([
    '.php', '.pl', '.pm', '.cgi', '.py', '.pyc', '.lnk', '.bat', '.ps1', '.sh',
    '.exe', '.dll', '.so', '.db', '.sql', '.log', '.env', '.pem', '.key', '.xml',
    '.scss'
]);

const BLOCKED_DIRS = new Set([
    'node_modules', 'dist', '.git', '.github', '.kilo', 'tests', 'tools',
    'cgi-bin', 'func', 'KRest', 'conf', 'data', 'database', 'logs', 'help',
    'kman', 'flask', 'unused', 'back', 'tmail', '.venv', '.history'
]);

const BLOCKED_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store', 'lib.php']);

function parseArgs(argv) {
    const args = { env: 'dev', source: null, base: '', cname: true, apiBase: null };
    for (const arg of argv.slice(2)) {
        if (arg.startsWith('--env=')) args.env = arg.slice(6);
        else if (arg.startsWith('--source=')) args.source = arg.slice(9);
        else if (arg.startsWith('--base=')) args.base = arg.slice(7);
        else if (arg.startsWith('--api-base=')) args.apiBase = arg.slice(11);
        else if (arg === '--no-cname') args.cname = false;
    }
    if (!ENVIRONMENTS[args.env]) {
        throw new Error(`Unknown environment "${args.env}". Use dev, staging or prod.`);
    }
    // Normalize to "" or "/sub/path" with no trailing slash.
    args.base = args.base.replace(/\/+$/, '');
    if (args.base && !args.base.startsWith('/')) args.base = '/' + args.base;
    if (args.apiBase && !args.apiBase.endsWith('/')) args.apiBase += '/';
    return args;
}

// Top-level directories that are served from the site root. Restricting the
// rewrite to these keeps it from touching unrelated strings that happen to
// start with a slash.
const BASE_ROOTS = ['v2', 'v3', 'shared', 'images'];

/**
 * Rewrite root-absolute URLs to a subpath.
 *
 * Only real URL positions are rewritten: `href="/x"`, `src="/x"`,
 * `action="/x"`, `url(/x)`, and JS string literals that begin with one of the
 * known top-level directories. Protocol-relative (`//host`) and absolute URLs
 * are left alone. Used for GitHub Pages project-site previews.
 */
function rewriteBase(dir, base) {
    if (!base) return 0;
    const TEXT = new Set(['.html', '.js', '.css', '.json']);
    const roots = BASE_ROOTS.join('|');
    const patterns = [
        // href="/v3/..."  src='/v2/...'  action="/shared/..."
        new RegExp(`(\\b(?:href|src|action)=["'])/(?=(?:${roots})/)`, 'g'),
        // url(/images/...)
        new RegExp(`(url\\()/(?=(?:${roots})/)`, 'g'),
        // "/v3/..." inside JS string literals
        new RegExp(`(["'])/(?=(?:${roots})/)`, 'g')
    ];
    let changed = 0;

    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!TEXT.has(path.extname(entry.name).toLowerCase())) continue;

            const before = fs.readFileSync(full, 'utf8');
            let after = before;
            for (const pattern of patterns) {
                after = after.replace(pattern, (match, lead) => lead + base + '/');
            }
            if (after !== before) {
                fs.writeFileSync(full, after, 'utf8');
                changed++;
            }
        }
    };
    walk(dir);
    return changed;
}

/**
 * Point the 404 page's redirect at the build's base.
 *
 * The page sends a visitor to `/index.html`. rewriteBase() leaves that alone
 * because the target is a page at the site root, not a path under one of
 * BASE_ROOTS, but a `--base=/repo` build serves the home page from
 * `<base>/index.html`. Without this a missing URL on a project-site preview
 * bounces the visitor out of the site. Both places the target appears are
 * rewritten: the string in the redirect script and the manual link.
 */
function rewriteNotFoundRedirect(dir, base) {
    if (!base) return 0;
    const file = path.join(dir, '404.html');
    if (!fs.existsSync(file)) return 0;

    const before = fs.readFileSync(file, 'utf8');
    const after = before.split('/index.html').join(`${base}/index.html`);
    if (after === before) return 0;

    fs.writeFileSync(file, after, 'utf8');
    return 1;
}

/**
 * Point hardcoded `/cgi-bin/kpic.pl` URLs at the environment's API base.
 *
 * Page fragments carry literal `src="/cgi-bin/kpic.pl?..."` attributes, which
 * resolve against the site's own origin. That origin serves static files only,
 * so on staging and prod every profile picture 404s. Rewriting the prefix at
 * build time keeps the fragments readable while sending the requests to the
 * API host.
 *
 * Only kpic.pl is rewritten. The JS modules build their URLs from
 * APP_CONFIG.apiBase at runtime, and the upload form is left alone because its
 * iframe callback (window.parent.UpdatePics) cannot cross origins.
 *
 * A same-origin base (`/cgi-bin/`, used by dev) is a no-op.
 */
function rewriteApiBase(dir, apiBase) {
    if (!apiBase || apiBase === '/cgi-bin/') return 0;
    const pattern = /(\b(?:href|data-src|src|action)=["'])\/cgi-bin\/(kpic\.pl)/g;
    let changed = 0;

    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (path.extname(entry.name).toLowerCase() !== '.html') continue;

            const before = fs.readFileSync(full, 'utf8');
            const after = before.replace(pattern, (match, lead, script) => lead + apiBase + script);
            if (after !== before) {
                fs.writeFileSync(full, after, 'utf8');
                changed++;
            }
        }
    };
    walk(dir);
    return changed;
}

/**
 * Compile every authored Sass sheet into the CSS the pages link.
 *
 * The shells are plain static HTML, so each sheet is compiled on its own:
 * `v2/css/base.scss` becomes `dist/v2/css/base.css`, and so on. Vendor CSS
 * (font-awesome) is not Sass and is copied verbatim by copyTree(). Partials
 * (a leading underscore) are skipped: they are pulled in by @use and have no
 * CSS of their own.
 *
 * Output is compressed and carries an external source map whose `sources`
 * point at the .scss file in this repo, so DevTools opens the real source.
 * `sourcesContent` embeds it, so the map works without a second request.
 *
 * Returns the dist-relative paths of the CSS files it wrote, so minify() can
 * leave them alone and only minify the vendor CSS it did not produce.
 */
function compileStyles() {
    let sass;
    try {
        sass = require('sass');
    } catch (err) {
        throw new Error('sass is not installed; run npm ci before building');
    }

    const sheets = [];
    const written = [];
    const collect = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) collect(full);
            // A leading underscore marks a partial: it is pulled in by @use and
            // has no CSS of its own, so compiling it would emit a stray file.
            else if (entry.isFile() && entry.name.endsWith('.scss') && !entry.name.startsWith('_')) {
                sheets.push(full);
            }
        }
    };
    for (const dir of ['v2/css', 'v3/css', 'shared']) {
        collect(path.join(ROOT, dir));
    }

    for (const source of sheets) {
        const rel = path.relative(ROOT, source).split(path.sep).join('/');
        const target = path.join(DIST, rel.replace(/\.scss$/, '.css'));
        const result = sass.compile(source, {
            style: 'compressed',
            sourceMap: true,
            sourceMapIncludeSources: true
        });

        // Sass reports `sources` as file:// URLs; the rest of the build (and
        // the tests) use absolute filesystem paths.
        const map = result.sourceMap;
        map.sources = map.sources.map((url) => (
            url.startsWith('file://') ? fileURLToPath(url) : url
        ).split(path.sep).join('/'));
        delete map.sourceRoot;

        fs.mkdirSync(path.dirname(target), { recursive: true });
        const body = result.css.endsWith('\n') ? result.css : result.css + '\n';
        fs.writeFileSync(target, body + `/*# sourceMappingURL=${path.basename(target)}.map */\n`, 'utf8');
        fs.writeFileSync(target + '.map', JSON.stringify(map), 'utf8');
        written.push(path.relative(DIST, target).split(path.sep).join('/'));
    }

    return written;
}

function cleanDist() {
    // Windows can still hold handles on files just written by a previous
    // build, which surfaces as ENOTEMPTY/EPERM. Retry briefly before failing.
    for (let attempt = 0; ; attempt++) {
        try {
            fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            break;
        } catch (err) {
            if (attempt >= 5) throw err;
            const until = Date.now() + 200;
            while (Date.now() < until) { /* brief backoff */ }
        }
    }
    fs.mkdirSync(DIST, { recursive: true });
}

function isBlocked(relPath, name) {
    if (BLOCKED_NAMES.has(name)) return true;
    const ext = path.extname(name).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) return true;
    // Compiled legacy string files, e.g. home.xml.js
    if (/\.xml\.js$/i.test(name)) return true;
    const parts = relPath.split(/[\\/]/);
    return parts.some((part) => BLOCKED_DIRS.has(part));
}

function copyTree(srcDir, destDir, relBase) {
    if (!fs.existsSync(srcDir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (isBlocked(rel, entry.name)) continue;

        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            count += copyTree(src, dest, rel);
        } else if (entry.isFile()) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            count++;
        }
    }
    return count;
}

/**
 * Expand shared page fragments declared with `data-fragment`.
 *
 * A fragment is a partial page under `v2/pages/` (for example the registration
 * form used by both home and register). Pages reference it with an empty
 * element:
 *
 *   <div class="indent" data-fragment="/v2/pages/reg_form.html"></div>
 *
 * The build replaces the element's content with the fragment, leaves the
 * wrapper (and its other attributes) in place, and removes the directive so
 * the published HTML is self-contained. Includes can nest; a missing file or
 * a cycle fails the build instead of shipping a hole.
 *
 * Only leaf elements (empty or whitespace-only content) are supported, which
 * is all a fragment wrapper needs.
 */
function expandIncludes(distDir) {
    const INCLUDE = /<([a-zA-Z][\w-]*)([^>]*\sdata-fragment="([^"]+)"[^>]*)>\s*<\/\1>/g;

    const expand = (html, file, stack) => html.replace(INCLUDE, (match, tag, attrs, ref) => {
        const target = ref.startsWith('/')
            ? path.join(distDir, ref.replace(/^\/+/, ''))
            : path.resolve(path.dirname(file), ref);
        const shown = path.relative(distDir, file).split(path.sep).join('/');

        if (!fs.existsSync(target)) {
            throw new Error(`Include not found: "${ref}" referenced from ${shown}`);
        }
        if (stack.indexOf(target) !== -1) {
            throw new Error(`Circular include: "${ref}" referenced from ${shown}`);
        }

        const inner = expand(fs.readFileSync(target, 'utf8'), target, stack.concat(target));
        const wrapper = attrs.replace(/\sdata-fragment="[^"]*"/, '');
        return `<${tag}${wrapper}>${inner}</${tag}>`;
    });

    const walk = (dir) => {
        let changed = 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                changed += walk(full);
                continue;
            }
            if (path.extname(entry.name).toLowerCase() !== '.html') continue;

            const before = fs.readFileSync(full, 'utf8');
            if (before.indexOf('data-fragment=') === -1) continue;

            const after = expand(before, full, [full]);
            if (after !== before) {
                fs.writeFileSync(full, after, 'utf8');
                changed++;
            }
        }
        return changed;
    };

    return walk(distDir);
}

function writeConfig(env, apiBaseOverride) {
    const settings = ENVIRONMENTS[env];
    const apiBase = apiBaseOverride || settings.apiBase;
    const source = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');
    const replaced = source.replace(
        /apiBase:\s*'[^']*'/,
        `apiBase: '${apiBase}'`
    );
    fs.mkdirSync(path.join(DIST, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(DIST, 'shared', 'config.js'), replaced, 'utf8');
}

function writeCname(env, enabled) {
    const settings = ENVIRONMENTS[env];
    if (enabled !== false && settings.cname) {
        fs.writeFileSync(path.join(DIST, 'CNAME'), settings.cname + '\n', 'utf8');
    }
}

/**
 * Minify every JS file under `dir` (default: dist/) and write a sibling
 * `<name>.map`, plus any CSS that compileStyles() did not produce.
 *
 * Sass output is skipped: compileStyles() already emits compressed CSS with a
 * source map that points at the .scss source, and re-minifying it would replace
 * that map with one pointing at the generated CSS. Vendor CSS (font-awesome) is
 * not Sass, so it is minified here like any other static asset.
 *
 * The minified file ends with a sourceMappingURL comment, so a browser loads
 * the map on demand. `sources` holds the absolute path of the original file in
 * this repo (falling back to the absolute path of the built file when there is
 * no repo counterpart), and `sourcesContent` embeds the code, so DevTools
 * shows the readable source without a second request.
 */
async function minify(dir, skipCss) {
    const root = dir || DIST;
    const skip = new Set(skipCss || []);
    let esbuild;
    try {
        esbuild = require('esbuild');
    } catch (err) {
        console.warn('esbuild not installed; skipping JS/CSS minification');
        return;
    }

    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== '.js' && ext !== '.css') continue;

            const rel = path.relative(root, full).split(path.sep).join('/');
            if (ext === '.css' && skip.has(rel)) continue;

            // Point `sources` at the original file in this repo so a debugger
            // opens the real source rather than a path relative to the map.
            // Files generated straight into dist/ have no repo counterpart, so
            // they fall back to their own absolute path. Forward slashes keep
            // the map portable across platforms.
            const original = root === DIST ? path.join(ROOT, rel) : null;
            const sourcefile = (original && fs.existsSync(original) ? original : full)
                .split(path.sep).join('/');

            const code = fs.readFileSync(full, 'utf8');
            try {
                const out = esbuild.transformSync(code, {
                    loader: ext === '.js' ? 'js' : 'css',
                    minify: true,
                    sourcemap: 'external',
                    sourcefile
                });
                const link = ext === '.js'
                    ? `//# sourceMappingURL=${entry.name}.map\n`
                    : `/*# sourceMappingURL=${entry.name}.map */\n`;
                const body = out.code.endsWith('\n') ? out.code : out.code + '\n';
                fs.writeFileSync(full, body + link, 'utf8');
                fs.writeFileSync(full + '.map', out.map, 'utf8');
            } catch (err) {
                // Leave the file unminified; validate.js reports the syntax error.
                console.warn(`Skipped minify (parse error): ${path.relative(root, full)}`);
            }
        }
    };
    walk(root);
}

async function minifyHtml() {
    let minifier;
    try {
        minifier = require('html-minifier-terser');
    } catch (err) {
        console.warn('html-minifier-terser not installed; skipping HTML minification');
        return;
    }

    const walk = async (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.html')) {
                const html = fs.readFileSync(full, 'utf8');
                const out = await minifier.minify(html, {
                    collapseWhitespace: true,
                    conservativeCollapse: true,
                    removeComments: true,
                    minifyCSS: false,
                    minifyJS: false,
                    keepClosingSlash: true
                });
                fs.writeFileSync(full, out, 'utf8');
            }
        }
    };
    await walk(DIST);
}

async function build(options) {
    const env = options.env || 'dev';
    const sourceRoot = options.source || path.join(ROOT, '..', 'kobool');

    console.log(`Building dist/ for env=${env}`);
    cleanDist();

    // Copy the static source tree (v2/, v3/, shared/, images/).
    let copied = 0;
    for (const dir of ['v2', 'v3', 'shared', 'images']) {
        copied += copyTree(path.join(ROOT, dir), path.join(DIST, dir), dir);
    }
    // Root-level entry points and static files.
    for (const name of ['index.html', '404.html', 'robots.txt', 'favicon.ico']) {
        const src = path.join(ROOT, name);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(DIST, name));
            copied++;
        }
    }
    console.log(`Copied ${copied} static files`);

    // Compile the authored Sass sheets into the CSS the pages link. This runs
    // before the URL rewrites so the generated CSS is rewritten like any other
    // stylesheet.
    const compiled = compileStyles();
    console.log(`Compiled ${compiled.length} Sass sheets`);

    // Shared fragments are expanded after the copy so every page in dist/ is
    // self-contained before URLs are rewritten and the HTML is minified.
    const expanded = expandIncludes(DIST);
    if (expanded) {
        console.log(`Expanded shared fragments in ${expanded} page file(s)`);
    }

    // Compile string bundles. The XML sources live in this repo (v2/text,
    // v3/text) so the published strings are reviewable and editable here;
    // --source only supplies the shared option/country data.
    const stringRoot = fs.existsSync(path.join(ROOT, 'v3', 'text'))
        ? ROOT
        : sourceRoot;
    if (fs.existsSync(path.join(stringRoot, 'v3', 'text'))) {
        const report = compileStrings({ sourceRoot: stringRoot, outRoot: DIST });
        console.log(`Compiled ${report.length} string bundles`);
    } else {
        console.warn(`String sources not found under ${stringRoot}; skipping compile`);
    }

    // Compile shared option/country data straight into dist/.
    try {
        const dataReport = compileData({
            source: stringRoot,
            outDir: path.join(DIST, 'shared', 'data')
        });
        console.log(`Compiled ${dataReport.length} data files`);
    } catch (err) {
        console.warn(`Data compile skipped: ${err.message}`);
    }

    writeConfig(env, options.apiBase);
    writeCname(env, options.cname);

    // Rewrite before minifying so the minifier sees the final URLs.
    const apiBase = options.apiBase || ENVIRONMENTS[env].apiBase;
    const apiRewritten = rewriteApiBase(DIST, apiBase);
    if (apiRewritten) {
        console.log(`Rewrote /cgi-bin/ URLs to "${apiBase}" in ${apiRewritten} files`);
    }

    const rewritten = rewriteBase(DIST, options.base || '');
    if (rewritten) {
        console.log(`Rewrote root-absolute URLs to base "${options.base}" in ${rewritten} files`);
    }

    if (rewriteNotFoundRedirect(DIST, options.base || '')) {
        console.log(`Pointed the 404 redirect at base "${options.base}/index.html"`);
    }

    await minify(DIST, compiled);
    await minifyHtml();

    console.log('Build complete');
}

if (require.main === module) {
    build(parseArgs(process.argv)).catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = {
    build, parseArgs, rewriteBase, rewriteApiBase, rewriteNotFoundRedirect,
    expandIncludes, compileStyles, minify, ENVIRONMENTS, isBlocked
};
