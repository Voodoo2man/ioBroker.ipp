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
