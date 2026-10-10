'use strict';

// Empacota o motor Node.js no APK: copia app.js, src/, public/ e dependências
// (JS puro + protobufs pré-compilados) para mobile/nodejs-project/.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'nodejs-project');

const FILES = ['app.js', 'package.json'];
const DIRS = ['src', 'public'];
// Módulos JS puros que o nodejs-mobile suporta sem polyfill nativo
const MODULES = [
    'express', 'socket.io', 'socket.io-adapter', 'socket.io-parser', 'engine.io',
    'socket.io-client', 'engine.io-client',
    'steam-user', 'steam-session', 'steamcommunity', 'steam-totp', 'steamid',
    'cheerio', 'qrcode', 'folder-hash', '@doctormckay/stdlib', '@doctormckay/user-agents',
    'protobufjs', 'bytebuffer', 'long', 'websocket13', 'file-manager', 'steamcrypt',
    'steam-appticket', 'steam-totp', 'steamid', 'socks', 'hdkey', 'bitcoinjs-lib',
    'tiny-typed-emitter', 'zlib', 'global-agent', 'std-lib'
];

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(src)) copyRecursive(path.join(src, f), path.join(dest, f));
    } else {
        fs.copyFileSync(src, dest);
    }
}

// Resolve a árvore de dependências via require.resolve p/ achar paths nested
function copyModuleTree(name, dest) {
    try {
        const resolved = require.resolve(name + '/package.json', { paths: [ROOT] });
        const modRoot = path.dirname(resolved);
        copyRecursive(modRoot, path.join(dest, name));
        return true;
    } catch (e) {
        return false;
    }
}

// 1) Copiar arquivos do motor
if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(DEST, f));
}
for (const d of DIRS) copyRecursive(path.join(ROOT, d), path.join(DEST, d));

// 2) Copiar node_modules (árvore completa flat do npm workspace raiz)
const NM_DEST = path.join(DEST, 'node_modules');
fs.mkdirSync(NM_DEST, { recursive: true });
let count = 0, missing = [];
const nmRoot = path.join(ROOT, 'node_modules');
for (const mod of MODULES) {
    if (copyModuleTree(mod, NM_DEST)) count++;
    else missing.push(mod);
}
// Copia TUDO que estiver no node_modules raiz (garantia para deps scoped)
for (const dir of fs.readdirSync(nmRoot)) {
    if (dir.startsWith('.')) continue;
    const destDir = path.join(NM_DEST, dir);
    if (!fs.existsSync(destDir)) copyRecursive(path.join(nmRoot, dir), destDir);
}
// scoped (@xxx/yyy)
for (const scope of fs.readdirSync(nmRoot).filter(d => d.startsWith('@'))) {
    for (const sub of fs.readdirSync(path.join(nmRoot, scope))) {
        copyRecursive(path.join(nmRoot, scope, sub), path.join(NM_DEST, scope, sub));
    }
}

console.log(`✅ Motor empacotado em ${DEST}`);
console.log(`   ${count} módulos explícitos copiados; árvore node_modules espelhada.`);
if (missing.length) console.log(`   ⚠ Não encontrados: ${missing.join(', ')}`);
