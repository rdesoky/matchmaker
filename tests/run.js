'use strict';

/**
 * Test runner for kobool.com static build.
 *
 *   node tests/run.js
 *
 * Covers: XML parser, string compiler, data compiler, shared strings binder
 * (language resolution), and the same-origin proxy allowlist. A final smoke
 * builds dist/ and runs validate.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

const { parseXml, parseXmlToObject, decodeEntities } = require(path.join(TOOLS, 'xml'));
const { compileSourceFile, flatten, listXmlSources, LANGS } = require(path.join(TOOLS, 'compile-strings'));
const { buildCountries, buildOptions } = require(path.join(TOOLS, 'compile-data'));
const { createProxy, DEFAULT_TARGET } = require(path.join(TOOLS, 'proxy'));
const { convert } = require(path.join(TOOLS, 'convert-pages'));
const { validate } = require(path.join(TOOLS, 'validate'));

test('XML parser: elements, attributes, entities, CDATA', () => {
    const src = '<?xml version="1.0"?>\n<root>\n  <a x="1&amp;2">Hello &lt;world&gt;</a>\n' +
        '  <b><![CDATA[raw <stuff> & here]]></b>\n  <c/>\n  <!-- comment -->\n</root>';
    const tree = parseXml(src);
    assert.strictEqual(tree.name, 'root');
    assert.strictEqual(tree.children.length, 3);

    const a = tree.children[0];
    assert.strictEqual(a.name, 'a');
    assert.deepStrictEqual(a.attrs, { x: '1&2' });
    assert.strictEqual(a.text, 'Hello <world>');

    const b = tree.children[1];
    assert.strictEqual(b.text, 'raw <stuff> & here');

    const c = tree.children[2];
    assert.strictEqual(c.name, 'c');
    assert.strictEqual(c.children.length, 0);
    assert.strictEqual(c.text, '');
});

test('XML parser: rejects malformed input', () => {
    assert.throws(() => parseXml('<root><a></root>'), /mismatched tag/);
    assert.throws(() => parseXml('<root><a></a>'), /unclosed element/);
    assert.throws(() => parseXml(''), /empty document/);
});

test('decodeEntities: named and numeric', () => {
    // &nbsp; is U+00A0, not a plain space.
    assert.strictEqual(decodeEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;'), '&<>"\'\u00a0');
    assert.strictEqual(decodeEntities('&#65;&#x42;'), 'AB');
    assert.strictEqual(decodeEntities('&unknown;'), '&unknown;');
});

test('decodeEntities: &nbsp; is U+00A0', () => {
    assert.strictEqual(decodeEntities('&nbsp;'), '\u00a0');
});

test('string compiler: flatten renames value-attr elements to v<value>', () => {
    const src = '<root><select_gender><option value="0">رجل</option>' +
        '<option value="1">امرأة</option></select_gender><pg_title.home>home</pg_title.home></root>';
    const tree = parseXml(src);
    const flat = {};
    flatten(tree, '', flat);
    assert.deepStrictEqual(flat, {
        'select_gender.v0': 'رجل',
        'select_gender.v1': 'امرأة',
        'pg_title.home': 'home'
    });
});

test('string compiler: compileSourceFile outputs deterministically sorted keys', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kobool-sort-'));
    const file = path.join(dir, 'str.xml');
    fs.writeFileSync(file, '<root><b>2</b><a>1</a><c>3</c></root>');
    const compiled = compileSourceFile(file);
    assert.deepStrictEqual(Object.keys(compiled), ['a', 'b', 'c']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('strings: the pics help group covers every album tooltip key', () => {
    // upd_pics.js shows these as help:pics.* tooltips; a missing key would
    // render as a raw [help:pics.x] placeholder.
    const expected = ['under_review', 'rejected', 'cant_be_main', 'move_top', 'delete', 'set_main', 'cancel_main'];
    for (const lang of ['en', 'ar']) {
        const compiled = compileSourceFile(path.join(ROOT, 'v3', 'text', lang, 'help.xml'));
        for (const key of expected) {
            const value = compiled['pics.' + key];
            assert.ok(
                typeof value === 'string' && value.trim().length > 0,
                `${lang} help:pics.${key} must be present`
            );
        }
    }
});

test('string compiler: listXmlSources lists only .xml files', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kobool-xml-'));
    fs.writeFileSync(path.join(dir, 'a.xml'), '<root/>');
    fs.writeFileSync(path.join(dir, 'b.xml'), '<root/>');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const sources = listXmlSources(dir);
    assert.deepStrictEqual(sources, ['a', 'b']);
    assert.deepStrictEqual(listXmlSources(path.join(dir, 'missing')), []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('data compiler: countries parse with preserveAttrs', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kobool-data-'));
    const langDir = path.join(dir, 'v3', 'text', 'ar');
    fs.mkdirSync(langDir, { recursive: true });
    fs.writeFileSync(
        path.join(langDir, 'countries.xml'),
        '<root><option value="1" name="مصر" code="EG"/><option value="0" name="X"/></root>'
    );
    const countries = buildCountries(dir, 'ar');
    assert.ok(Array.isArray(countries));
    assert.strictEqual(countries.length, 1);
    assert.deepStrictEqual(countries[0], { value: '1', label: 'مصر', code: 'EG' });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('data compiler: options groups parse', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kobool-data-'));
    const langDir = path.join(dir, 'v3', 'text', 'ar');
    fs.mkdirSync(langDir, { recursive: true });
    fs.writeFileSync(
        path.join(langDir, 'options.xml'),
        '<root><sfilters><f1><option value="1">One</option><option value="2">Two</option></f1>' +
        '<f2><option value="3">Three</option></f2></sfilters></root>'
    );
    const opts = buildOptions(dir, 'ar');
    assert.deepStrictEqual(Object.keys(opts.sfilters).sort(), ['f1', 'f2']);
    assert.deepStrictEqual(opts.sfilters.f1, [
        { value: '1', label: 'One' },
        { value: '2', label: 'Two' }
    ]);
    assert.deepStrictEqual(opts.sfilters.f2, [{ value: '3', label: 'Three' }]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('page converter: element content becomes data-string', () => {
    const { html } = convert('<div><span><?=S("a.logout")?></span></div>');
    assert.match(html, /<span data-string="str:a\.logout"><\/span>/);
});

test('page converter: attribute value becomes data-string-attr', () => {
    const { html } = convert('<input type="text" placeholder="<?=S("login.login_name")?>"/>');
    assert.match(html, /placeholder="" data-string="str:login\.login_name" data-string-attr="placeholder"/);
});

test('page converter: literal text around a string becomes a template', () => {
    const { html } = convert('<option value=""><?= "---" . S("any_status") . "---" ?></option>');
    assert.match(html, /data-string="str:any_status"/);
    assert.match(html, /data-string-template="---\{s\}---"/);
});

test('page converter: attribute template keeps the literal prefix', () => {
    const { html } = convert('<textarea placeholder="&gt;<?=S("feedback_link")?>"></textarea>');
    assert.match(html, /data-string-template="&gt;\{s\}"/);
});

test('page converter: explicit string source is preserved', () => {
    const { html } = convert('<div><?=S("home.msg","home")?></div>');
    assert.match(html, /data-string="home:home\.msg"/);
});

test('page converter: strips the PHP prologue and reports leftovers', () => {
    const { html, notes } = convert('<?php include("x.php"); ?>\n<div><?php echo 1; ?></div>');
    assert.ok(!html.includes('<?php'), 'PHP must not survive conversion');
    assert.ok(notes.some((n) => /unconverted PHP/.test(n)));
});

test('build: rewriteBase prefixes only real root-absolute URLs', () => {
    const os = require('os');
    const { rewriteBase } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-base-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, [
        '<link href="/v3/css/base.css"/>',
        '<script src="/shared/config.js"></script>',
        '<a href="#pg=home">x</a>',
        '<a href="//cdn.example.com/x.js">y</a>',
        '<a href="https://example.com/z">z</a>',
        '<meta content="/not-a-url"/>',
        '<style>body{background:url(/images/x.gif)}</style>'
    ].join('\n'));

    rewriteBase(dir, '/repo');
    const out = fs.readFileSync(file, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });

    assert.match(out, /href="\/repo\/v3\/css\/base\.css"/);
    assert.match(out, /src="\/repo\/shared\/config\.js"/);
    assert.match(out, /url\(\/repo\/images\/x\.gif\)/);
    assert.match(out, /href="#pg=home"/);
    assert.match(out, /href="\/\/cdn\.example\.com\/x\.js"/);
    assert.match(out, /href="https:\/\/example\.com\/z"/);
    assert.match(out, /content="\/not-a-url"/);
});

test('build: rewriteNotFoundRedirect prefixes the 404 target only when a base is set', () => {
    const os = require('os');
    const { rewriteNotFoundRedirect } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-404-base-'));
    const file = path.join(dir, '404.html');
    const html = [
        '<script>',
        "if (window.location.pathname !== '/index.html') window.location.replace('/index.html');",
        '</script>',
        '<a href="/index.html">Home</a>'
    ].join('\n');

    try {
        fs.writeFileSync(file, html);
        assert.strictEqual(rewriteNotFoundRedirect(dir, ''), 0);
        assert.deepStrictEqual(fs.readFileSync(file), Buffer.from(html));

        assert.strictEqual(rewriteNotFoundRedirect(dir, '/repo'), 1);
        const out = fs.readFileSync(file, 'utf8');
        // The guard must follow the redirect target so a missing home page cannot loop.
        assert.match(out, /pathname !== '\/repo\/index\.html'/);
        assert.match(out, /replace\('\/repo\/index\.html'\)/);
        assert.match(out, /href="\/repo\/index\.html"/);
        assert.doesNotMatch(out, /['"]\/index\.html['"]/);

        fs.unlinkSync(file);
        assert.strictEqual(rewriteNotFoundRedirect(dir, '/repo'), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('build: expandIncludes inlines shared fragments and strips the directive', () => {
    const os = require('os');
    const { expandIncludes } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-inc-'));
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pages', 'frag.html'),
        '<div id="Inner">x</div>\n<div data-fragment="./nested.html"></div>');
    fs.writeFileSync(path.join(dir, 'pages', 'nested.html'), '<span>nested</span>');
    fs.writeFileSync(path.join(dir, 'pages', 'page.html'),
        '<div class="wrap" data-fragment="/pages/frag.html"></div>');

    const changed = expandIncludes(dir);
    const out = fs.readFileSync(path.join(dir, 'pages', 'page.html'), 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });

    assert.strictEqual(changed, 2, 'the page and the nested fragment are both expanded');
    assert.match(out, /<div class="wrap"><div id="Inner">x<\/div>\n<div><span>nested<\/span><\/div><\/div>/);
    assert.ok(!/data-fragment/.test(out), 'the directive must not survive into dist');
});

test('build: expandIncludes fails on a missing or circular fragment', () => {
    const os = require('os');
    const { expandIncludes } = require(path.join(TOOLS, 'build'));

    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-inc-miss-'));
    fs.writeFileSync(path.join(missing, 'page.html'), '<div data-fragment="/pages/nope.html"></div>');
    assert.throws(() => expandIncludes(missing), /Include not found/);
    fs.rmSync(missing, { recursive: true, force: true });

    const cycle = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-inc-cycle-'));
    fs.writeFileSync(path.join(cycle, 'a.html'), '<div data-fragment="/b.html"></div>');
    fs.writeFileSync(path.join(cycle, 'b.html'), '<div data-fragment="/a.html"></div>');
    assert.throws(() => expandIncludes(cycle), /Circular include/);
    fs.rmSync(cycle, { recursive: true, force: true });
});

test('build: minify writes a source map next to every JS and CSS file', async () => {
    const os = require('os');
    const { minify } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-map-'));
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.js'), 'const answer = 42;\nconsole.log(answer);\n');
    fs.writeFileSync(path.join(dir, 'css', 'base.css'), '.a { color: red; }\n');

    await minify(dir);

    const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'css', 'base.css'), 'utf8');
    const jsMap = JSON.parse(fs.readFileSync(path.join(dir, 'app.js.map'), 'utf8'));
    const cssMap = JSON.parse(fs.readFileSync(path.join(dir, 'css', 'base.css.map'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });

    assert.match(js, /\/\/# sourceMappingURL=app\.js\.map\n$/);
    assert.match(css, /\/\*# sourceMappingURL=base\.css\.map \*\/\n$/);
    assert.ok(!/console\.log\(answer\)/.test(js), 'the JS must be minified');

    for (const map of [jsMap, cssMap]) {
        assert.strictEqual(map.version, 3);
        assert.strictEqual(map.sources.length, 1);
        assert.strictEqual(map.sourcesContent.length, 1, 'the original source must be embedded');
        assert.ok(map.mappings.length > 0, 'the map must carry mappings');
    }
    assert.strictEqual(jsMap.sources[0], path.join(dir, 'app.js'));
    assert.strictEqual(cssMap.sources[0], path.join(dir, 'css', 'base.css'));
    assert.ok(path.isAbsolute(jsMap.sources[0]), 'sources must be absolute paths');
    assert.ok(path.isAbsolute(cssMap.sources[0]), 'sources must be absolute paths');
});

test('build: compileStyles emits CSS and a map pointing at the Sass source', () => {
    // compileStyles() writes into the real dist/, so this asserts against the
    // build the smoke test produces rather than a temp tree.
    const { compileStyles } = require(path.join(TOOLS, 'build'));
    assert.strictEqual(typeof compileStyles, 'function', 'compileStyles must be exported');

    const written = compileStyles();
    assert.ok(written.length > 0, 'compileStyles must report the CSS it wrote');
    assert.ok(
        written.every((rel) => rel.endsWith('.css')),
        'compileStyles must report .css paths, not .scss'
    );
    assert.ok(
        written.includes('v3/css/base.css') && written.includes('shared/theme.css'),
        'compileStyles must cover the v3 and shared sheets'
    );

    for (const rel of written) {
        const css = fs.readFileSync(path.join(ROOT, 'dist', rel), 'utf8');
        assert.match(css, /\/\*# sourceMappingURL=[^ ]+\.map \*\/\n$/, `${rel} must link its map`);
        assert.ok(!/\n\s{2,}/.test(css), `${rel} must be compressed`);

        const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', rel + '.map'), 'utf8'));
        assert.strictEqual(map.version, 3, `${rel}.map must be a v3 map`);
        assert.strictEqual(map.sourceRoot, undefined, `${rel}.map must not carry a sourceRoot`);
        assert.strictEqual(
            map.sourcesContent.length,
            map.sources.length,
            `${rel}.map must embed every source`
        );
        // v2/css/who.scss is empty, so Sass emits a map with no sources.
        if (map.sources.length === 0) continue;
        assert.ok(
            map.sources.every((s) => path.isAbsolute(s) && s.endsWith('.scss')),
            `${rel}.map must point at absolute .scss paths, got ${map.sources.join(', ')}`
        );
    }
});

test('build: minify leaves Sass-compiled CSS alone', async () => {
    // compileStyles() already emits compressed CSS with its own source map, so
    // minify() must skip those files: re-minifying would replace the map that
    // points back at the .scss source with one pointing at the compiled .css.
    const os = require('os');
    const { minify } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-skip-'));
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'css', 'base.css'), '.a{color:red}\n/*# sourceMappingURL=base.css.map */\n');
    fs.writeFileSync(path.join(dir, 'css', 'base.css.map'), '{"version":3,"sources":["/src/base.scss"]}');
    fs.writeFileSync(path.join(dir, 'css', 'vendor.css'), '.b { color: blue; }\n');

    await minify(dir, ['css/base.css']);

    const compiled = fs.readFileSync(path.join(dir, 'css', 'base.css'), 'utf8');
    const compiledMap = JSON.parse(fs.readFileSync(path.join(dir, 'css', 'base.css.map'), 'utf8'));
    const vendor = fs.readFileSync(path.join(dir, 'css', 'vendor.css'), 'utf8');
    const vendorHasMap = fs.existsSync(path.join(dir, 'css', 'vendor.css.map'));
    fs.rmSync(dir, { recursive: true, force: true });

    assert.strictEqual(compiledMap.sources[0], '/src/base.scss', 'the Sass source map must survive');
    assert.match(compiled, /sourceMappingURL=base\.css\.map/, 'the Sass map reference must survive');
    assert.ok(!/color: blue/.test(vendor), 'vendor CSS must still be minified');
    assert.ok(vendorHasMap, 'vendor CSS must still get a map');
});

test('strings: addQueryParam appends to bare and already-queried URLs', () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'shared', 'strings.js'), 'utf8');
    const sandbox = {
        window: {
            location: { pathname: '/', search: '' },
            APP_CONFIG: {},
            navigator: { language: 'en-US', languages: ['en-US'] }
        },
        document: {
            cookie: '',
            documentElement: {},
            addEventListener() {},
            querySelectorAll() { return []; }
        },
        Promise,
        RegExp,
        URLSearchParams,
        console
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    // Static PgLinks carry no "?v=" cache-buster, so a bare path must get "?"
    assert.strictEqual(
        sandbox.window.KStrings.addQueryParam('/v3/pages/templates.html', 'lang', 'en'),
        '/v3/pages/templates.html?lang=en'
    );
    // A legacy "?v=..." suffix must keep "&"
    assert.strictEqual(
        sandbox.window.KStrings.addQueryParam('/cgi-bin/geo.pl?v=1', 'lang', 'ar'),
        '/cgi-bin/geo.pl?v=1&lang=ar'
    );
});

test('strings binder: language resolution prefers cookie, falls back to default', () => {
    // detectLang() lives in shared/strings.js (IIFE); assert its static
    // expectations from source (config.js is a browser script, not loadable).
    const js = fs.readFileSync(path.join(ROOT, 'shared', 'strings.js'), 'utf8');
    assert.match(js, /supportedLangs/);
    assert.match(js, /defaultLang/);
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');
    assert.match(src, /defaultLang: 'ar'/);
    assert.match(src, /supportedLangs: \['ar', 'en'\]/);
});

test('v3 str-loader: data-string-attr targets are not written as values', () => {
    // k-template calls _HS on every [data-string] node, so a placeholder or a
    // button label declared with data-string-attr must land in that attribute,
    // not in the element's value.
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'v3', 'modules', 'str-loader.js'), 'utf8');
    const strings = { 'str:feedback_link': 'Write personal memo on this member' };

    function StubPromise() {}
    StubPromise.prototype.resolve = function () { return this; };
    StubPromise.all = function () { return new StubPromise(); };
    StubPromise.as = function () { return new StubPromise(); };

    let loader;
    const sandbox = {
        window: {
            KStrings: {
                loadBundle() { return { then(resolve) { resolve(true); } }; },
                getString(id) { return strings[id]; }
            }
        },
        define(deps, factory) { loader = factory(StubPromise, {}, {}, {}); },
        _E(el) { return el; },
        _H(el, html) { el.innerHTML = html; },
        _A(el, txt) { el.textContent = txt; return el; },
        Promise,
        console
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    function fakeEl(attrs, tagName) {
        return {
            tagName,
            value: '',
            innerHTML: '',
            attributes: Object.assign({}, attrs),
            getAttribute(name) {
                return this.attributes[name] === undefined ? null : this.attributes[name];
            },
            setAttribute(name, val) { this.attributes[name] = val; }
        };
    }

    const memo = fakeEl({
        'data-string': 'str:feedback_link',
        'data-string-attr': 'placeholder',
        'data-string-template': '>{s}'
    }, 'TEXTAREA');
    loader.setHTML(memo, 'str:feedback_link');
    assert.strictEqual(memo.value, '', 'the prompt must not become the textarea value');
    assert.strictEqual(memo.attributes.placeholder, '>Write personal memo on this member');

    const plain = fakeEl({}, 'TEXTAREA');
    loader.setHTML(plain, 'str:feedback_link');
    assert.strictEqual(plain.value, 'Write personal memo on this member');
});

test('proxy: DEFAULT_TARGET points at the current dev API host', () => {
    assert.strictEqual(DEFAULT_TARGET, 'http://dev.kobool.com');
});

test('validate: an http:// API base warns because the site is served over https', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-mixed-'));
    const distShared = path.join(dir, 'shared');
    fs.mkdirSync(distShared, { recursive: true });
    fs.writeFileSync(path.join(distShared, 'config.js'), 'window.APP_CONFIG={apiBase:"http://api.kobool.com/cgi-bin/"};');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');

    // staging.kobool.com redirects http -> https, so the page is https and an
    // http:// API base would be blocked as mixed active content.
    for (const env of ['staging', 'prod']) {
        const res = validate({ env, dist: dir });
        assert.ok(!res.errors.some((e) => /API base/.test(e)), `${env} must not error: ${res.errors}`);
        assert.ok(res.warnings.some((w) => /mixed active content/.test(w)), `${env} must warn: ${res.warnings}`);
    }

    // The dev build proxies /cgi-bin/ same-origin, so http:// is fine there.
    const dev = validate({ env: 'dev', dist: dir });
    assert.ok(!dev.warnings.some((w) => /API base/.test(w)), 'dev must not warn');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('validate: a scheme-relative API base is accepted without warnings', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-https-'));
    const distShared = path.join(dir, 'shared');
    fs.mkdirSync(distShared, { recursive: true });
    fs.writeFileSync(path.join(distShared, 'config.js'), 'window.APP_CONFIG={apiBase:"//api.kobool.com/cgi-bin/"};');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');

    for (const env of ['staging', 'prod']) {
        const res = validate({ env, dist: dir });
        assert.ok(!res.errors.some((e) => /API base/.test(e)), `${env} must not error: ${res.errors}`);
        assert.ok(!res.warnings.some((w) => /API base/.test(w)), `${env} must not warn: ${res.warnings}`);
    }

    fs.rmSync(dir, { recursive: true, force: true });
});

test('build: rewriteApiBase points hardcoded kpic.pl URLs at the API host', () => {
    const os = require('os');
    const { rewriteApiBase } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-api-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, [
        '<img src="/cgi-bin/kpic.pl?tn=1&amp;id=1&amp;g=1"/>',
        '<img src="/cgi-bin/kpic.pl?tn=1&amp;id=2&amp;g=0"/>',
        '<form action="/cgi-bin/upload_pic.pl"></form>',
        '<a href="/v3/pages/home.html">x</a>'
    ].join('\n'));

    const changed = rewriteApiBase(dir, '//api.kobool.com/cgi-bin/');
    const out = fs.readFileSync(file, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });

    assert.strictEqual(changed, 1);
    assert.match(out, /src="\/\/api\.kobool\.com\/cgi-bin\/kpic\.pl\?tn=1&amp;id=1&amp;g=1"/);
    assert.match(out, /src="\/\/api\.kobool\.com\/cgi-bin\/kpic\.pl\?tn=1&amp;id=2&amp;g=0"/);
    // Only kpic.pl URLs are rewritten; the uploader now posts via XHR from
    // APP_CONFIG.apiBase, so its form carries no static /cgi-bin/ action.
    assert.match(out, /action="\/cgi-bin\/upload_pic\.pl"/);
    assert.match(out, /href="\/v3\/pages\/home\.html"/);
});

test('build: rewriteApiBase is a no-op for the same-origin dev base', () => {
    const os = require('os');
    const { rewriteApiBase } = require(path.join(TOOLS, 'build'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-api-dev-'));
    const file = path.join(dir, 'page.html');
    const html = '<img src="/cgi-bin/kpic.pl?tn=1"/>';
    fs.writeFileSync(file, html);

    assert.strictEqual(rewriteApiBase(dir, '/cgi-bin/'), 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), html);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('validate: a root-absolute /cgi-bin/ URL in a page fragment is an error', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-cgibin-'));
    fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'shared', 'config.js'),
        'window.APP_CONFIG={apiBase:"//api.kobool.com/cgi-bin/"};'
    );
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');
    fs.writeFileSync(path.join(dir, 'page.html'), '<img src="/cgi-bin/kpic.pl?tn=1"/>');

    const res = validate({ env: 'staging', dist: dir });
    assert.ok(
        res.errors.some((e) => /Root-absolute API URL/.test(e)),
        `must error on a root-absolute API URL: ${res.errors}`
    );

    // The dev build proxies /cgi-bin/ same-origin, so it is valid there.
    const dev = validate({ env: 'dev', dist: dir });
    assert.ok(!dev.errors.some((e) => /Root-absolute API URL/.test(e)), 'dev may use /cgi-bin/');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('build: --no-cname omits CNAME, default writes it', () => {
    const { parseArgs } = require(path.join(TOOLS, 'build'));

    assert.strictEqual(parseArgs(['node', 'build.js', '--env=staging']).cname, true);
    assert.strictEqual(parseArgs(['node', 'build.js', '--env=staging', '--no-cname']).cname, false);
});

test('build: --api-base overrides the environment API base', () => {
    const { parseArgs } = require(path.join(TOOLS, 'build'));

    assert.strictEqual(parseArgs(['node', 'build.js']).apiBase, null);
    // A trailing slash is normalized so callers can concatenate script names.
    assert.strictEqual(
        parseArgs(['node', 'build.js', '--api-base=https://api.kobool.com/cgi-bin']).apiBase,
        'https://api.kobool.com/cgi-bin/'
    );
});

test('validate: a CNAME in a subpath build is an error', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-cname-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');

    // A GitHub Pages project site is served from /<repo>/ over https and must
    // not claim a custom domain: the CNAME makes Pages try to provision a
    // certificate for a host without HTTPS, which fails and blocks the HTTPS
    // setting.
    fs.writeFileSync(path.join(dir, 'CNAME'), 'staging.kobool.com\n');
    const withCname = validate({ env: 'staging', dist: dir, base: '/kobool.com' });
    assert.ok(
        withCname.errors.some((e) => /CNAME/.test(e)),
        `subpath build with CNAME must error: ${withCname.errors}`
    );

    // The same artifact is fine for a domain-root deployment.
    const rootBuild = validate({ env: 'staging', dist: dir });
    assert.ok(!rootBuild.errors.some((e) => /CNAME/.test(e)), 'root build may keep its CNAME');

    fs.rmSync(path.join(dir, 'CNAME'));
    const noCname = validate({ env: 'staging', dist: dir, base: '/kobool.com' });
    assert.ok(!noCname.errors.some((e) => /CNAME/.test(e)), 'subpath build without CNAME is valid');

    fs.rmSync(dir, { recursive: true, force: true });
});

function evalConfigForHost(host) {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');
    // Simulate the build baking a cross-origin API base into the dist config.
    const built = src.replace(/apiBase:\s*'[^']*'/, "apiBase: '//api.kobool.com/cgi-bin/'");
    const window = {
        location: { hostname: host },
        document: {
            createElement() { return { setAttribute() {}, appendChild() {} }; },
            head: {}
        }
    };
    const sandbox = { window };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(built, sandbox);
    return window.APP_CONFIG.apiBase;
}

test('config: localhost and 127.0.0.1 force the same-origin API base', () => {
    assert.strictEqual(evalConfigForHost('localhost'), '/cgi-bin/');
    assert.strictEqual(evalConfigForHost('127.0.0.1'), '/cgi-bin/');
});

test('config: other hosts keep the baked API base', () => {
    assert.strictEqual(
        evalConfigForHost('staging.kobool.com'),
        '//api.kobool.com/cgi-bin/'
    );
});

test('validate: shared/config.js host detection is exempt from the localhost rule', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-hostcfg-'));
    const distShared = path.join(dir, 'shared');
    fs.mkdirSync(distShared, { recursive: true });
    fs.writeFileSync(path.join(distShared, 'config.js'), [
        'window.APP_CONFIG={apiBase:"//api.kobool.com/cgi-bin/"};',
        '(function(g){var h=g.location&&g.location.hostname;if(h==="localhost"||h==="127.0.0.1"){g.APP_CONFIG.apiBase="/cgi-bin/";}})(window);'
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');

    for (const env of ['staging', 'prod']) {
        const res = validate({ env, dist: dir });
        assert.ok(
            !res.errors.some((e) => /Localhost reference/.test(e)),
            `${env} must not flag config.js host detection: ${res.errors}`
        );
    }

    // The rule still applies everywhere else.
    fs.writeFileSync(path.join(dir, 'page.html'), '<a href="http://localhost:8080/x">x</a>');
    const flagged = validate({ env: 'staging', dist: dir });
    assert.ok(
        flagged.errors.some((e) => /Localhost reference/.test(e)),
        'a localhost literal outside config.js must still error'
    );

    fs.rmSync(dir, { recursive: true, force: true });
});

function mockReqRes(url, headers) {
    const req = {
        url,
        method: 'GET',
        headers: Object.assign({ host: 'localhost', accept: '*/*' }, headers),
        pipe: () => {}
    };
    const res = {
        _status: 0,
        _headers: {},
        _body: '',
        writeHead(status, headers) {
            this._status = status;
            Object.assign(this._headers, headers);
        },
        end(body) {
            this._body = body || '';
        }
    };
    return { req, res };
}

test('proxy: allowlist rejects non-allowed paths', () => {
    const proxy = createProxy({ target: 'http://127.0.0.1:1', allowlist: ['/cgi-bin/login.pl'] });
    const { req, res } = mockReqRes('/cgi-bin/query.pl', {});
    proxy(req, res);
    assert.strictEqual(res._status, 403);
});

test('proxy: non-proxied path returns 404', () => {
    const proxy = createProxy({ target: 'http://127.0.0.1:1' });
    const { req, res } = mockReqRes('/index.html', {});
    proxy(req, res);
    assert.strictEqual(res._status, 404);
});

test('serve: --spa falls back to index.html for unknown routes only', async () => {
    const os = require('os');
    const http = require('http');
    const { createServer, parseArgs } = require(path.join(TOOLS, 'serve'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobool-spa-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>shell</body></html>');
    fs.writeFileSync(path.join(dir, '404.html'), '<html><body>missing</body></html>');

    const get = (server, urlPath, accept) => new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: { accept } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
    });

    const spa = createServer({ root: dir, spa: true });
    const plain = createServer({ root: dir });
    await new Promise((resolve) => spa.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));

    try {
        const route = await get(spa, '/some/deep/link', 'text/html');
        assert.strictEqual(route.status, 200);
        assert.match(route.body, /shell/);

        // Missing assets must still 404 so broken URLs stay visible.
        const asset = await get(spa, '/missing.js', '*/*');
        assert.strictEqual(asset.status, 404);
        assert.match(asset.body, /missing/);

        // Non-navigation requests (e.g. fetch) keep the 404 page.
        const api = await get(spa, '/some/deep/link', 'application/json');
        assert.strictEqual(api.status, 404);

        // Without --spa the dev server keeps production behavior.
        const off = await get(plain, '/some/deep/link', 'text/html');
        assert.strictEqual(off.status, 404);
        assert.match(off.body, /missing/);
    } finally {
        spa.close();
        plain.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.strictEqual(parseArgs(['node', 'serve.js', '--spa']).spa, true);
    assert.strictEqual(parseArgs(['node', 'serve.js']).spa, false);
});

test('favicon: the original site icon ships at the site root', () => {
    // Copied verbatim from the original repo (v1/html.min/favicon.ico) and
    // served from /favicon.ico, which is where browsers look by default.
    const icon = path.join(ROOT, 'favicon.ico');
    assert.ok(fs.existsSync(icon), 'favicon.ico must exist at the repo root');

    const bytes = fs.readFileSync(icon);
    assert.strictEqual(bytes.length, 1718, 'favicon.ico must be the original file');
    // ICO header: reserved=0, type=1 (icon), 2 images.
    assert.strictEqual(bytes.readUInt16LE(0), 0);
    assert.strictEqual(bytes.readUInt16LE(2), 1);
    assert.strictEqual(bytes.readUInt16LE(4), 2);

    // Both shells must reference it explicitly.
    for (const shell of ['index.html', path.join('v2', 'index.html')]) {
        const html = fs.readFileSync(path.join(ROOT, shell), 'utf8');
        assert.match(html, /<link rel="icon" href="\/favicon\.ico"/, `${shell} must link the icon`);
    }
});

function loadTheme(options) {
    const vm = require('vm');
    const opts = options || {};
    const code = fs.readFileSync(path.join(ROOT, 'shared', 'theme.js'), 'utf8');
    const attrs = {};
    const root = {
        lang: opts.lang || 'en',
        style: {},
        getAttribute(name) {
            if (name === 'lang') return this.lang;
            return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
        },
        setAttribute(name, value) { attrs[name] = String(value); }
    };
    const controls = [];
    const docListeners = {};
    const document = {
        documentElement: root,
        readyState: 'complete',
        querySelectorAll(selector) {
            return selector === '[data-theme-toggle]' ? controls : [];
        },
        querySelector() { return null; },
        addEventListener(type, fn) {
            (docListeners[type] = docListeners[type] || []).push(fn);
        }
    };
    const localStorage = {
        value: Object.prototype.hasOwnProperty.call(opts, 'stored') ? opts.stored : null,
        getItem() { return this.value; },
        setItem(key, value) { this.value = value; }
    };
    const mql = {
        matches: !!opts.systemDark,
        addEventListener() {},
        addListener() {}
    };
    const window = {
        document,
        localStorage,
        CustomEvent: function CustomEvent(type, init) {
            this.type = type;
            this.detail = init && init.detail;
        },
        matchMedia() { return mql; },
        addEventListener() {},
        dispatchEvent() {}
    };
    const sandbox = { window, document, localStorage, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { window, root, attrs, controls, localStorage, docListeners };
}

test('theme: saved and system preferences resolve to a data-theme attribute', () => {
    const dark = loadTheme({ stored: 'dark', systemDark: false });
    assert.strictEqual(dark.attrs['data-theme'], 'dark');
    assert.strictEqual(dark.attrs['data-theme-mode'], 'dark');
    assert.strictEqual(dark.window.KTheme.getMode(), 'dark');

    const light = loadTheme({ stored: 'light', systemDark: true });
    assert.strictEqual(light.attrs['data-theme'], 'light');
    assert.strictEqual(light.window.KTheme.getMode(), 'light');

    const systemDark = loadTheme({ systemDark: true });
    assert.strictEqual(systemDark.window.KTheme.getMode(), 'system');
    assert.strictEqual(systemDark.attrs['data-theme'], 'dark');

    const systemLight = loadTheme({ systemDark: false });
    assert.strictEqual(systemLight.attrs['data-theme'], 'light');

    // An unknown stored value falls back to following the OS.
    const invalid = loadTheme({ stored: 'nonsense', systemDark: true });
    assert.strictEqual(invalid.window.KTheme.getMode(), 'system');
    assert.strictEqual(invalid.attrs['data-theme'], 'dark');
});

test('theme: toggling persists an explicit theme and updates the control label', () => {
    const sandbox = loadTheme({ systemDark: true });
    const control = {
        textContent: '',
        attrs: {},
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
        },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
    };
    sandbox.controls.push(control);

    // System is dark, so the first click selects light explicitly.
    assert.strictEqual(sandbox.window.KTheme.toggle(), 'light');
    assert.strictEqual(sandbox.attrs['data-theme'], 'light');
    assert.strictEqual(sandbox.attrs['data-theme-mode'], 'light');
    assert.strictEqual(sandbox.localStorage.value, 'light');
    assert.strictEqual(control.textContent, 'Dark mode');
    assert.strictEqual(control.attrs['aria-pressed'], 'false');

    sandbox.window.KTheme.setMode('dark');
    assert.strictEqual(control.textContent, 'Light mode');
    assert.strictEqual(control.attrs['aria-pressed'], 'true');

    // The label follows the document language.
    const arabic = loadTheme({ stored: 'light', systemDark: false, lang: 'ar' });
    const arabicControl = {
        textContent: '',
        attrs: {},
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
        },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
    };
    arabic.controls.push(arabicControl);
    arabic.window.KTheme.refresh();
    assert.strictEqual(arabicControl.textContent, 'الوضع الداكن');
});

test('theme: both shells load the theme assets before their base CSS', () => {
    const shells = [
        { file: 'index.html', base: '/v3/css/base.css' },
        { file: path.join('v2', 'index.html'), base: '/v2/css/base.css' }
    ];
    for (const shell of shells) {
        const html = fs.readFileSync(path.join(ROOT, shell.file), 'utf8');
        const jsAt = html.indexOf('/shared/theme.js');
        const cssAt = html.indexOf('/shared/theme.css');
        const baseAt = html.indexOf(shell.base);

        assert.ok(jsAt !== -1, `${shell.file} must load shared/theme.js`);
        assert.ok(cssAt !== -1, `${shell.file} must load shared/theme.css`);
        assert.ok(baseAt !== -1, `${shell.file} must load its base stylesheet`);
        assert.ok(jsAt < baseAt, `${shell.file} must apply the theme before base CSS`);
        assert.ok(jsAt < cssAt, `${shell.file} must apply the theme before the override CSS`);
        assert.match(html, /data-theme-toggle/, `${shell.file} must expose a theme toggle`);
        assert.match(html, /name="theme-color"/, `${shell.file} must declare a theme-color`);
    }
});

test('layout: both shells provide the featured members side panel mounts', () => {
    // Both featured-panel modules (v2/kmain.js and v3/modules/featured.js)
    // toggle #RightSide and append into #RightSideContents. Without those
    // nodes the panel never renders and the DOM helpers silently no-op.
    const shells = ['index.html', path.join('v2', 'index.html')];
    for (const file of shells) {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(html, /id="RightSide"/, `${file} must contain the #RightSide container`);
        assert.match(html, /id="RightSideContents"/, `${file} must contain the #RightSideContents panel`);
    }
});

test('smoke: dist builds and validates cleanly', { timeout: 120000 }, () => {
    execFileSync(process.execPath, [path.join(TOOLS, 'build.js'), '--env=prod'], {
        cwd: ROOT,
        stdio: 'pipe'
    });

    // dist must contain the config pointing at the CORS-enabled API host
    // (currently api.kobool.com, scheme-relative).
    const distConfig = fs.readFileSync(path.join(ROOT, 'dist', 'shared', 'config.js'), 'utf8');
    assert.match(distConfig, /\/\/api\.kobool\.com\/cgi-bin\//);

    // Page fragments must not keep root-absolute /cgi-bin/ URLs: the site
    // origin serves static files only, so those requests 404.
    const templates = fs.readFileSync(path.join(ROOT, 'dist', 'v3', 'pages', 'templates.html'), 'utf8');
    assert.ok(
        !/["']\/cgi-bin\/kpic\.pl/.test(templates),
        'templates.html must not reference /cgi-bin/kpic.pl on the site origin'
    );
    assert.match(templates, /\/\/api\.kobool\.com\/cgi-bin\/kpic\.pl/);

    // The picture uploader must post via XHR to APP_CONFIG.apiBase: a
    // root-absolute form action would hit the static site origin (405), and
    // the old hidden-iframe target cannot receive a cross-origin callback.
    const updPics = fs.readFileSync(path.join(ROOT, 'dist', 'v3', 'pages', 'upd_pics.html'), 'utf8');
    assert.ok(
        !/action="\/cgi-bin\/upload_pic\.pl"/.test(updPics),
        'upd_pics.html must not carry a root-absolute upload action'
    );
    assert.ok(!/upload_target/.test(updPics), 'upd_pics.html must not create an upload iframe');

    // Every minified JS/CSS file must ship a sibling source map that the
    // browser can load from the sourceMappingURL comment, and the map must
    // point at the absolute path of the original source. Stylesheets are
    // authored in .scss, so their map names the .scss file that is edited.
    for (const rel of [path.join('shared', 'theme.js'), path.join('v3', 'css', 'base.css')]) {
        const file = path.join(ROOT, 'dist', rel);
        const code = fs.readFileSync(file, 'utf8');
        assert.match(code, /sourceMappingURL=/, `${rel} must reference its source map`);
        const map = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
        assert.strictEqual(map.version, 3, `${rel}.map must be a v3 source map`);
        assert.ok(map.sourcesContent && map.sourcesContent.length, `${rel}.map must embed the source`);
        const expected = rel.endsWith('.css') ? rel.replace(/\.css$/, '.scss') : rel;
        assert.strictEqual(map.sources[0], path.join(ROOT, expected), `${rel}.map must use the absolute source path`);
    }

    // Stylesheets are authored in .scss and compiled to .css. The map must
    // point at the .scss source, not at the compiled .css, so DevTools opens
    // the file that is actually edited.
    for (const rel of [path.join('v3', 'css', 'base.scss'), path.join('shared', 'theme.scss')]) {
        const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', rel.replace(/\.scss$/, '.css.map')), 'utf8'));
        assert.strictEqual(map.sources[0], path.join(ROOT, rel), `${rel} must be the mapped source`);
        assert.ok(map.sourcesContent[0].length > 0, `${rel} must be embedded in its map`);
    }

    // No Sass source may reach dist/: the pages link .css, so a .scss there is
    // dead weight that also leaks the partials.
    const sassLeaks = [];
    const findSass = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findSass(full);
            else if (/\.s[ac]ss$/.test(entry.name)) sassLeaks.push(path.relative(ROOT, full));
        }
    };
    findSass(path.join(ROOT, 'dist'));
    assert.deepStrictEqual(sassLeaks, [], 'dist/ must not contain Sass sources');

    // The dark theme is authored as nested `html[data-theme="dark"]` blocks in
    // shared/theme.scss; the compiled sheet must still scope every override to
    // that attribute, or the toggle silently stops working.
    const themeCss = fs.readFileSync(path.join(ROOT, 'dist', 'shared', 'theme.css'), 'utf8');
    assert.match(themeCss, /html\[data-theme=dark\]/, 'theme.css must scope dark overrides to the attribute');
    // Token *declarations* may only live in the :root (light) block or the
    // html[data-theme=dark] block. A top-level rule may still *use* a token
    // (that is how light-mode rules are written), so only flag declaration
    // bodies that escaped both theme blocks.
    const unscoped = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rule;
    while ((rule = ruleRe.exec(themeCss)) !== null) {
        const selector = rule[1].trim();
        const declaresToken = /--kb-[a-z0-9-]+\s*:/.test(rule[2]);
        const inTheme = selector === ':root' || /^html\[data-theme=dark\]/.test(selector) || / html\[data-theme=dark\]/.test(selector);
        if (declaresToken && !inTheme) {
            unscoped.push(selector);
        }
    }
    assert.deepStrictEqual(unscoped, [], 'dark theme tokens must stay scoped to html[data-theme=dark]');

    // Validation must pass.
    let out;
    try {
        out = execFileSync(process.execPath, [path.join(TOOLS, 'validate.js')], {
            cwd: ROOT,
            stdio: 'pipe'
        }).toString();
    } catch (err) {
        assert.fail('validate.js failed:\n' + err.stdout.toString() + err.stderr.toString());
    }
    assert.match(out, /Validation passed/);

    // No PHP/Perl/Python or secrets may survive into dist.
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                assert.ok(
                    !['.php', '.pl', '.pm', '.cgi', '.py'].includes(ext),
                    `blocked extension in dist: ${path.relative(ROOT, full)}`
                );
                if (['.js', '.html', '.json'].includes(ext)) {
                    const text = fs.readFileSync(full, 'utf8');
                    assert.ok(!/(kobool_2004|amazonaws|BEGIN PRIVATE|rds\.amazonaws|mysql\s*[:=]\s*['"])/i.test(text),
                        `possible secret in dist: ${path.relative(ROOT, full)}`);
                    assert.ok(!/sharethis|st_share|paypal\.com|PayPalForm|SubmitPayPal/i.test(text),
                        `deprecated integration marker in dist: ${path.relative(ROOT, full)}`);
                }
            }
        }
    };
    walk(path.join(ROOT, 'dist'));
});

test('LANGS exports both supported languages', () => {
    assert.deepStrictEqual(LANGS, ['ar', 'en']);
});

test('mem-ui: guest menu renders without a successful logout round-trip', () => {
    // The side menu used to be revealed only by the logout response, so an
    // unreachable API (offline, CORS, mixed content on https) left both menus
    // hidden. The guest UI must be reachable locally.
    const src = fs.readFileSync(path.join(ROOT, 'v3', 'modules', 'mem-ui.js'), 'utf8');

    const refresh = src.slice(src.indexOf('refreshHeader:'), src.indexOf('renderLogin:'));
    assert.match(refresh, /this\.renderLogin\(\)/, 'refreshHeader must render the guest menu locally');
    assert.ok(!/this\.logout\(\)/.test(refresh), 'refreshHeader must not depend on the logout request');

    const logout = src.slice(src.indexOf('logout:'), src.indexOf('login:function'));
    assert.match(logout, /onerror\s*:\s*endSession/, 'logout must clear the session when the request fails');

    const renderBox = src.slice(src.indexOf('renderBox:'), src.indexOf('logout:'));
    assert.match(renderBox, /_SH\("GuestMenu"\)/, 'renderBox must reveal the guest menu for anonymous users');
});
