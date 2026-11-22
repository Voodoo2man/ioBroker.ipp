const INVALID_HOST_CHARACTERS = /[/?#@\\\s]/;
const INVALID_RESOURCE_PATH_CHARACTERS = /[?#\\\s]/;

export function getPrinterHostValidatorExpression(): string {
    const endpoint = "'http://' + data.host.trim() + ':631/'";
    return [
        "typeof data.host === 'string'",
        "data.host.trim() !== ''",
        `!${INVALID_HOST_CHARACTERS}.test(data.host.trim())`,
        `URL.canParse(${endpoint})`,
        `new URL(${endpoint}).hostname !== ''`,
        `new URL(${endpoint}).pathname === '/'`,
        `new URL(${endpoint}).username === ''`,
        `new URL(${endpoint}).password === ''`,
    ].join(' && ');
}

export function getIppBasePathValidatorExpression(): string {
    return [
        "typeof data.basePath === 'string'",
        "data.basePath.startsWith('/')",
        "!data.basePath.includes('..')",
        `!${INVALID_RESOURCE_PATH_CHARACTERS}.test(data.basePath)`,
    ].join(' && ');
}

export function isValidPrinterHost(host: unknown): host is string {
    if (typeof host !== 'string' || host.trim() === '' || /[/?#@\\\s]/.test(host.trim())) {
        return false;
    }
    try {
        const endpoint = new URL(`http://${host.trim()}:631/`);
        return (
            endpoint.hostname !== '' &&
            endpoint.pathname === '/' &&
            endpoint.username === '' &&
            endpoint.password === ''
        );
    } catch {
        return false;
    }
}

export function isValidIppBasePath(basePath: unknown): basePath is string {
    return (
        typeof basePath === 'string' &&
        basePath.startsWith('/') &&
        !basePath.includes('..') &&
        !/[?#\\\s]/.test(basePath)
    );
}
