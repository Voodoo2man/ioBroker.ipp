import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import Bonjour, { type Service } from 'bonjour-service';
import multicastDns from 'multicast-dns';
import { createUniquePrinterId, parsePrinterConfig, type PrinterConfig } from './printerConfig';
import { isValidIppBasePath, isValidPrinterHost } from './printerEndpoint';

const DEFAULT_SCAN_TIMEOUT_MS = 5000;
const MIN_SCAN_TIMEOUT_MS = 100;
const MAX_SCAN_TIMEOUT_MS = 10000;
const MAX_IPV4_INTERFACES = 16;
const MAX_IPV6_INTERFACES = 16;
const MAX_SERVICE_ANNOUNCEMENTS = 512;
const MAX_SCAN_WARNINGS = 20;
const MAX_PRINTER_ADDRESSES = 32;
const MAX_PRINTER_RESULTS = 100;
const IPV4_MDNS_ADDRESS = '224.0.0.251';
const IPV6_MDNS_ADDRESS = 'ff02::fb';
const SERVICE_TYPES = ['ipp', 'ipps'] as const;

type ServiceType = (typeof SERVICE_TYPES)[number];
type NetworkAddress = { address: string; family: string | number; internal: boolean };
type NetworkAddressMap = Record<string, NetworkAddress[] | undefined>;
type MdnsOptions = {
    type: 'udp4' | 'udp6';
    ip: string;
    port: number;
    reuseAddr: boolean;
    interface?: string;
    bind?: string;
};

interface MdnsClient {
    on(event: 'error' | 'warning', listener: (error: unknown) => void): this;
    destroy(callback?: (error?: Error) => void): void;
}

interface ServiceBrowser {
    on(event: 'up', listener: (service: Service) => void): this;
    stop(): void;
}

export interface DiscoveredPrinter {
    key: string;
    name: string;
    manufacturer?: string;
    model?: string;
    host: string;
    addresses: string[];
    port: number;
    basePath: string;
    ssl: boolean;
}

export interface PrinterDiscoveryResult {
    printers: DiscoveredPrinter[];
    warnings: string[];
}

export interface PrinterDiscoveryOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    networkInterfaces?: () => NetworkAddressMap;
    createClient?: (options: MdnsOptions) => MdnsClient;
    createBrowser?: (client: MdnsClient, type: ServiceType) => ServiceBrowser;
}

interface ParsedService extends Omit<DiscoveredPrinter, 'key'> {
    identity?: string;
}

interface PrinterGroup {
    printer: ParsedService;
    services: ParsedService[];
}

function isIpv4Address(address: NetworkAddress): boolean {
    return !address.internal && (address.family === 'IPv4' || address.family === 4) && isIP(address.address) === 4;
}

function isIpv6Address(address: NetworkAddress): boolean {
    return (
        !address.internal &&
        (address.family === 'IPv6' || address.family === 6) &&
        isIP(address.address.split('%')[0]) === 6
    );
}

function getMdnsOptions(interfaces: NetworkAddressMap): MdnsOptions[] {
    const options: MdnsOptions[] = [];
    const addresses = Object.entries(interfaces);
    const ipv4Addresses = new Set<string>();
    for (const [, records] of addresses) {
        const address = records?.find(isIpv4Address);
        if (address && ipv4Addresses.size < MAX_IPV4_INTERFACES && !ipv4Addresses.has(address.address)) {
            ipv4Addresses.add(address.address);
            options.push({
                type: 'udp4',
                ip: IPV4_MDNS_ADDRESS,
                interface: address.address,
                bind: address.address,
                port: 5353,
                reuseAddr: true,
            });
        }
    }

    let ipv6InterfaceCount = 0;
    for (const [, records] of addresses) {
        const address = records?.find(isIpv6Address);
        if (address && ipv6InterfaceCount < MAX_IPV6_INTERFACES) {
            ipv6InterfaceCount++;
            options.push({
                type: 'udp6',
                ip: IPV6_MDNS_ADDRESS,
                interface: address.address.split('%')[0],
                bind: '::',
                port: 5353,
                reuseAddr: true,
            });
        }
    }
    return options;
}

function defaultCreateClient(options: MdnsOptions): MdnsClient {
    return multicastDns(options);
}

function defaultCreateBrowser(client: MdnsClient, type: ServiceType): ServiceBrowser {
    return new Bonjour.Browser(client, { type, protocol: 'tcp' });
}

function containsControlCharacters(value: string): boolean {
    return Array.from(value).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

function replaceControlCharacters(value: string): string {
    return Array.from(value, character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? ' ' : character;
    }).join('');
}

function cleanTxtText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim();
    if (!text || text.length > maxLength || containsControlCharacters(text)) {
        return undefined;
    }
    return text;
}

function findTxtValue(txt: unknown, names: string[], maxLength = 128): string | undefined {
    if (!txt || typeof txt !== 'object' || Array.isArray(txt)) {
        return undefined;
    }
    const values = txt as Record<string, unknown>;
    const keys = new Set(names.map(name => name.toLowerCase()));
    for (const key of Object.keys(values).slice(0, 128)) {
        if (keys.has(key.toLowerCase())) {
            const text = cleanTxtText(values[key], maxLength);
            if (text) {
                return text;
            }
        }
    }
    return undefined;
}

function normalizeHost(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const host = value.trim().replace(/\.$/, '');
    const normalized = isIP(host) === 6 && !host.startsWith('[') ? `[${host}]` : host;
    return isValidPrinterHost(normalized) ? normalized : undefined;
}

function normalizeAddresses(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const addresses = value.slice(0, MAX_PRINTER_ADDRESSES).flatMap(address => {
        if (typeof address !== 'string') {
            return [];
        }
        const unscopedAddress = address.trim().split('%')[0];
        return isIP(unscopedAddress) ? [unscopedAddress] : [];
    });
    return [...new Set(addresses)];
}

function normalizeResourcePath(value: unknown): string | undefined {
    const path = cleanTxtText(value, 512);
    if (!path) {
        return undefined;
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    let decoded: string;
    try {
        decoded = decodeURIComponent(normalized);
    } catch {
        return undefined;
    }
    if (
        containsControlCharacters(decoded) ||
        /[\s?#\\]/.test(decoded) ||
        decoded.split('/').some(segment => segment === '..') ||
        !isValidIppBasePath(normalized)
    ) {
        return undefined;
    }
    return normalized;
}

function normalizeIdentity(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const candidate = value.replace(/^urn:uuid:/i, '').toLowerCase();
    return /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(candidate) ? candidate : undefined;
}

function parseService(value: unknown, expectedType: ServiceType): ParsedService | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const service = value as Record<string, unknown>;
    if (service.type !== expectedType || service.protocol !== 'tcp') {
        return undefined;
    }
    const name = cleanTxtText(service.name, 128);
    const host = normalizeHost(service.host);
    const port = service.port;
    if (!name || !host || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return undefined;
    }

    const txt = service.txt;
    const rp = findTxtValue(txt, ['rp'], 512);
    const addresses = normalizeAddresses(service.addresses);
    const hostAddress = host.replace(/^\[|\]$/g, '');
    if (isIP(hostAddress) && !addresses.includes(hostAddress)) {
        addresses.unshift(hostAddress);
    }
    const manufacturer = findTxtValue(txt, ['manufacturer', 'mfg', 'usb_mfg'], 100);
    const model = findTxtValue(txt, ['ty', 'product', 'model', 'mdl', 'usb_mdl'], 128);
    const identity = normalizeIdentity(findTxtValue(txt, ['uuid', 'printer-uuid'], 64));

    return {
        name,
        manufacturer,
        model,
        host,
        addresses,
        port,
        basePath: normalizeResourcePath(rp) ?? '',
        ssl: expectedType === 'ipps',
        identity,
    };
}

function hostAlias(host: string): string {
    return host
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
}

function serviceAliases(service: ParsedService): Set<string> {
    return new Set([hostAlias(service.host), ...service.addresses.map(address => address.toLowerCase())]);
}

function sharesAlias(left: Set<string>, right: Set<string>): boolean {
    for (const alias of left) {
        if (right.has(alias)) {
            return true;
        }
    }
    return false;
}

function samePrinter(left: ParsedService, right: ParsedService): boolean {
    if (left.identity && right.identity && left.identity === right.identity) {
        return true;
    }
    const sameName = left.name.toLowerCase() === right.name.toLowerCase();
    if (sameName && sharesAlias(serviceAliases(left), serviceAliases(right))) {
        return true;
    }
    return (
        hostAlias(left.host) === hostAlias(right.host) &&
        left.port === right.port &&
        left.basePath === right.basePath &&
        left.ssl === right.ssl
    );
}

function servicePriority(service: ParsedService): number {
    return (service.ssl ? 100 : 0) + (service.basePath ? 10 : 0) + (service.addresses.length ? 1 : 0);
}

function addWarning(warnings: string[], message: string): void {
    if (warnings.length < MAX_SCAN_WARNINGS) {
        warnings.push(replaceControlCharacters(message).slice(0, 240));
    }
}

function errorDetail(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return replaceControlCharacters(detail).slice(0, 160);
}

function mergeServices(services: ParsedService[]): DiscoveredPrinter[] {
    const groups: PrinterGroup[] = [];
    for (const service of services) {
        const group = groups.find(candidate => candidate.services.some(existing => samePrinter(existing, service)));
        if (!group) {
            groups.push({ printer: service, services: [service] });
            continue;
        }
        group.services.push(service);
        const addresses = [...new Set([...group.printer.addresses, ...service.addresses])];
        const preferred = servicePriority(service) > servicePriority(group.printer) ? service : group.printer;
        group.printer = {
            ...preferred,
            manufacturer: preferred.manufacturer ?? group.printer.manufacturer ?? service.manufacturer,
            model: preferred.model ?? group.printer.model ?? service.model,
            addresses,
        };
    }
    return groups
        .map(group => {
            const printer = { ...group.printer };
            delete printer.identity;
            return printer;
        })
        .sort((left, right) => left.name.localeCompare(right.name) || left.host.localeCompare(right.host))
        .map((printer, index) => ({ key: `printer-${index + 1}`, ...printer }));
}

function abortError(): Error {
    const error = new Error('Printer discovery was aborted');
    error.name = 'AbortError';
    return error;
}

export function isPrinterAlreadyConfigured(
    candidate: Pick<DiscoveredPrinter, 'host' | 'addresses'> & {
        port?: number | string;
        basePath?: string;
        ssl?: boolean;
    },
    configuredPrinters: PrinterConfig[],
): boolean {
    if (!candidate.basePath) {
        return false;
    }
    const candidateHosts = new Set([candidate.host, ...candidate.addresses].map(hostAlias));
    return configuredPrinters.some(printer => {
        const path = printer.basePath || '/ipp/print';
        return (
            candidateHosts.has(hostAlias(printer.host)) &&
            Number(printer.port ?? 631) === Number(candidate.port ?? 631) &&
            path === candidate.basePath &&
            (printer.ssl === true) === (candidate.ssl === true)
        );
    });
}

export interface PrinterDiscoveryImportResult {
    added: number;
    skipped: number;
    cancelled: boolean;
    error?: unknown;
}

export interface PrinterDiscoveryImportHandlers {
    getConfiguredPrinters: () => PrinterConfig[];
    configurePrinter: (printer: DiscoveredPrinter, proposed: PrinterConfig) => Promise<unknown>;
    savePrinter: (printer: unknown) => Promise<void>;
    finishImport?: () => Promise<void>;
}

export async function importDiscoveredPrinters(
    printers: DiscoveredPrinter[],
    handlers: PrinterDiscoveryImportHandlers,
): Promise<PrinterDiscoveryImportResult> {
    const result: PrinterDiscoveryImportResult = { added: 0, skipped: 0, cancelled: false };
    for (const printer of printers) {
        if (isPrinterAlreadyConfigured(printer, handlers.getConfiguredPrinters())) {
            result.skipped++;
            continue;
        }
        const proposed: PrinterConfig = {
            id: createUniquePrinterId(
                printer.name,
                printer,
                handlers.getConfiguredPrinters().map(config => config.id),
            ),
            label: printer.name,
            host: printer.host,
            port: printer.port,
            basePath: printer.basePath,
            ssl: printer.ssl,
            verifySsl: false,
        };
        let confirmed: unknown;
        try {
            confirmed = await handlers.configurePrinter(printer, proposed);
        } catch (error) {
            result.error = error;
            break;
        }
        if (confirmed === undefined) {
            result.cancelled = true;
            break;
        }
        const parsed = parsePrinterConfig(confirmed);
        if (
            parsed.config &&
            isPrinterAlreadyConfigured(
                { ...parsed.config, addresses: printer.addresses },
                handlers.getConfiguredPrinters(),
            )
        ) {
            result.skipped++;
            continue;
        }
        try {
            await handlers.savePrinter(confirmed);
            result.added++;
        } catch (error) {
            result.error = error;
            break;
        }
    }
    if (result.added > 0 && handlers.finishImport) {
        try {
            await handlers.finishImport();
        } catch (error) {
            result.error ??= error;
        }
    }
    return result;
}

export async function discoverPrinters(options: PrinterDiscoveryOptions = {}): Promise<PrinterDiscoveryResult> {
    const timeoutMs = Math.min(
        MAX_SCAN_TIMEOUT_MS,
        Math.max(MIN_SCAN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS),
    );
    const interfaces = options.networkInterfaces ?? networkInterfaces;
    const clientFactory = options.createClient ?? defaultCreateClient;
    const browserFactory = options.createBrowser ?? defaultCreateBrowser;
    const signal = options.signal;
    if (signal?.aborted) {
        throw abortError();
    }
    const clientOptions = getMdnsOptions(interfaces());
    if (clientOptions.length === 0) {
        throw new Error('No multicast-capable network interfaces are available');
    }

    const services: ParsedService[] = [];
    const warnings: string[] = [];
    const clients: Array<{ client: MdnsClient; failed: boolean }> = [];
    const browsers: ServiceBrowser[] = [];

    return new Promise<PrinterDiscoveryResult>((resolve, reject) => {
        let settled = false;
        let initializing = true;
        let abortRequested = false;
        let receivedAnnouncements = 0;
        let timeout: NodeJS.Timeout | undefined;
        async function cleanup(): Promise<void> {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal?.removeEventListener('abort', onAbort);
            for (const browser of browsers) {
                try {
                    browser.stop();
                } catch {
                    addWarning(warnings, 'A DNS-SD browser could not be stopped cleanly');
                }
            }
            await Promise.all(
                clients.map(
                    ({ client }) =>
                        new Promise<void>(done => {
                            try {
                                client.destroy(() => done());
                            } catch {
                                addWarning(warnings, 'An mDNS socket could not be closed cleanly');
                                done();
                            }
                        }),
                ),
            );
        }
        async function finish(error?: Error): Promise<void> {
            if (settled) {
                return;
            }
            settled = true;
            await cleanup();
            if (error) {
                reject(error);
            } else {
                const printers = mergeServices(services);
                if (printers.length > MAX_PRINTER_RESULTS) {
                    addWarning(warnings, `Only the first ${MAX_PRINTER_RESULTS} discovered printers are shown`);
                }
                resolve({ printers: printers.slice(0, MAX_PRINTER_RESULTS), warnings });
            }
        }
        function onAbort(): void {
            if (initializing) {
                abortRequested = true;
            } else {
                void finish(abortError());
            }
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            for (const clientOption of clientOptions) {
                let client: MdnsClient;
                try {
                    client = clientFactory(clientOption);
                } catch (error) {
                    addWarning(warnings, `Could not start ${clientOption.type} mDNS discovery: ${errorDetail(error)}`);
                    continue;
                }
                const clientState = { client, failed: false };
                clients.push(clientState);
                client.on('error', error => {
                    clientState.failed = true;
                    addWarning(warnings, `A ${clientOption.type} mDNS socket failed: ${errorDetail(error)}`);
                    if (!initializing && clients.every(candidate => candidate.failed)) {
                        void finish(new Error('All mDNS discovery sockets failed'));
                    }
                });
                client.on('warning', error => {
                    addWarning(warnings, `An mDNS response could not be processed: ${errorDetail(error)}`);
                });
                for (const type of SERVICE_TYPES) {
                    const browser = browserFactory(client, type);
                    browsers.push(browser);
                    browser.on('up', service => {
                        if (receivedAnnouncements >= MAX_SERVICE_ANNOUNCEMENTS) {
                            addWarning(warnings, 'The mDNS announcement limit was reached');
                            return;
                        }
                        receivedAnnouncements++;
                        const parsed = parseService(service, type);
                        if (parsed) {
                            services.push(parsed);
                        }
                    });
                }
            }
        } catch (error) {
            initializing = false;
            void finish(error instanceof Error ? error : new Error(errorDetail(error)));
            return;
        }

        initializing = false;
        if (abortRequested || signal?.aborted) {
            void finish(abortError());
            return;
        }
        if (clients.length === 0) {
            void finish(new Error(warnings.join('; ') || 'Could not start mDNS discovery'));
            return;
        }
        if (clients.every(client => client.failed)) {
            void finish(new Error('All mDNS discovery sockets failed'));
            return;
        }
        timeout = setTimeout(() => {
            if (clients.every(client => client.failed)) {
                void finish(new Error('All mDNS discovery sockets failed'));
            } else {
                void finish();
            }
        }, timeoutMs);
    });
}
