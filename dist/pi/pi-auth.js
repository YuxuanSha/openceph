/**
 * Inject API keys from config.auth.profiles into Pi's AuthStorage.
 * Runtime-only — not persisted to auth.json.
 */
export function injectApiKeys(authStorage, config) {
    const profiles = config.auth.profiles;
    for (const [profileId, profile] of Object.entries(profiles)) {
        if (profile.mode === "api_key" && profile.apiKey) {
            const provider = profileId.split(":")[0];
            authStorage.setRuntimeApiKey(provider, profile.apiKey);
        }
    }
}
