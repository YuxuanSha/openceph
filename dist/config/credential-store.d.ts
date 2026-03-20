export declare class CredentialStore {
    private baseDir;
    constructor(baseDir: string);
    /** Synchronously resolve a credential reference string */
    resolve(raw: string): string;
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string>;
    list(): Promise<string[]>;
    delete(key: string): Promise<void>;
    setKeychain(service: string, key: string, value: string): void;
    getKeychain(service: string, key: string): string;
    private walkDir;
}
