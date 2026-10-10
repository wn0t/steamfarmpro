'use strict';

// @AI-IMPROVEMENT (Etapa 1): login.json agora é gravado com AES-256-GCM.
// A chave fica no arquivo login.key (0600). Sem a chave, o vault é indecifrável.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'config');
const KEY_FILE = path.join(DATA_DIR, 'login.key');
const FILE = path.join(DATA_DIR, 'login.json');

const ALGO = 'aes-256-gcm';

function loadOrCreateKey() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(KEY_FILE)) {
        fs.writeFileSync(KEY_FILE, crypto.randomBytes(32));
        try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
    }
    return fs.readFileSync(KEY_FILE);
}

const KEY = loadOrCreateKey();

function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, KEY, iv);
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    // formato dos dados: [1 byte versão][12 bytes iv][16 bytes tag][ciphertext]
    const out = Buffer.concat([Buffer.from([1]), iv, tag, enc]);
    return out.toString('base64');
}

function decrypt(blob) {
    const raw = Buffer.from(blob, 'base64');
    const version = raw.readUInt8(0);
    if (version !== 1) throw new Error('Versão de vault incompatível');
    const iv = raw.subarray(1, 13);
    const tag = raw.slice(13, 29);
    const data = Buffer.from(raw.slice(29));
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

function save(data) {
    fs.writeFileSync(FILE, encrypt(data));
}

function load() {
    if (!fs.existsSync(FILE)) return {};
    const blob = fs.readFileSync(FILE, 'utf8');
    try {
        return decrypt(blob);
    } catch (e) {
        return {};
    }
}

module.exports = { save, load, _path: FILE };
