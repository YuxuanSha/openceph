import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";
import { execSync } from "child_process";
export class CredentialStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    /** Synchronously resolve a credential reference string */
    resolve(raw) {
        if (raw.startsWith("from:credentials/")) {
            const key = raw.slice("from:credentials/".length);
            const filePath = path.join(this.baseDir, key);
            try {
                return readFileSync(filePath, "utf-8").trim();
            }
            catch {
                throw new Error(`Credential not found: ${filePath}`);
            }
        }
        if (raw.startsWith("env:")) {
            const envName = raw.slice("env:".length);
            const value = process.env[envName];
            if (value === undefined) {
                throw new Error(`Environment variable not set: ${envName}`);
            }
            return value;
        }
        if (raw.startsWith("keychain:")) {
            const parts = raw.slice("keychain:".length).split(":");
            if (parts.length < 2) {
                throw new Error(`Invalid keychain reference: ${raw}. Expected "keychain:service:key"`);
            }
            return this.getKeychain(parts[0], parts[1]);
        }
        return raw;
    }
    async set(key, value) {
        const filePath = path.join(this.baseDir, key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, value, { mode: 0o600 });
    }
    async get(key) {
        const filePath = path.join(this.baseDir, key);
        try {
            return (await fs.readFile(filePath, "utf-8")).trim();
        }
        catch {
            throw new Error(`Credential not found: ${key}`);
        }
    }
    async list() {
        const results = [];
        await this.walkDir(this.baseDir, "", results);
        return results.sort();
    }
    async delete(key) {
        const filePath = path.join(this.baseDir, key);
        try {
            await fs.unlink(filePath);
        }
        catch {
            throw new Error(`Credential not found: ${key}`);
        }
    }
    setKeychain(service, key, value) {
        if (process.platform === "darwin") {
            execSync(`security add-generic-password -U -s "${service}" -a "${key}" -w "${value}"`);
        }
        else {
            execSync(`echo "${value}" | secret-tool store --label="${service}/${key}" service "${service}" key "${key}"`);
        }
    }
    getKeychain(service, key) {
        try {
            if (process.platform === "darwin") {
                return execSync(`security find-generic-password -s "${service}" -a "${key}" -w`, { encoding: "utf-8" }).trim();
            }
            else {
                return execSync(`secret-tool lookup service "${service}" key "${key}"`, { encoding: "utf-8" }).trim();
            }
        }
        catch {
            throw new Error(`Keychain entry not found: ${service}/${key}`);
        }
    }
    async walkDir(dir, prefix, results) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await this.walkDir(path.join(dir, entry.name), relative, results);
            }
            else {
                results.push(relative);
            }
        }
    }
}
