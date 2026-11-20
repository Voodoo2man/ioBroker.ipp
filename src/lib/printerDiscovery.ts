import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { getPrinterHostKey } from './printerEndpoint';
import { getPrinterIdKey } from './printerConfig';

export const MAX_PRINTER_SCAN_ADDRESSES = 256;
export const MAX_PRINTER_SCAN_CONCURRENCY = 16;
export const MAX_CONFIGURED_PRINTER_HOSTNAMES = 64;
export const MAX_HOSTNAME_RESOLUTION_CONCURRENCY = 4;
export const DEFAULT_HOSTNAME_RESOLUTION_TIMEOUT_MS = 500;
export const MAX_HOSTNAME_RESOLUTION_TIMEOUT_MS = 2000;

const PRIVATE_IPV4_RANGES = [
    { first: '10.0.0.0', last: '10.255.255.255' },
    { first: '172.16.0.0', last: '172.31.255.255' },
    { first: '192.168.0.0', last: '192.168.255.255' },
    { first: '169.254.0.0', last: '169.254.255.255' },
].map(range => ({ first: ipv4ToNumber(range.first)!, last: ipv4ToNumber(range.last)! }));

interface AddressRange {
    first: number;
    last: number;
}

export interface PrinterScanTargets {
    addresses: string[];
    eligibleAddressCount: number;
    limited: boolean;
    configuredHostResolutionFailed?: boolean;
    configuredHostResolutionLimited?: boolean;
}

export interface PrinterScanCandidate {
    id: string;
    host: string;
    label: string;
    model?: string;
}

export interface PrinterScanProbeResult {
    model: string | null;
    printerName: string | null;
}

export interface PrinterScanResult {
    candidates: PrinterScanCandidate[];
    scanned: number;
}

export interface PrinterScanOptions {
    concurrency?: number;
    configuredIds?: Iterable<string>;
    onProgress?: (completed: number, total: number) => void | Promise<void>;
    signal?: AbortSignal;
}

export interface SerializedProgressUpdates {
    report(completed: number, total: number): Promise<void>;
    flush(): Promise<void>;
}

export interface DeferredPrinterScanRefresh {
    save<T>(operation: () => Promise<T>): Promise<T>;
    flush(): Promise<void>;
}

export function createDeferredPrinterScanRefresh(refresh: () => Promise<void>): DeferredPrinterScanRefresh {
    let pending = false;
    return {
        async save<T>(operation: () => Promise<T>): Promise<T> {
            const result = await operation();
            pending = true;
            return result;
        },
        async flush(): Promise<void> {
            if (!pending) {
                return;
            }
            pending = false;
            await refresh();
        },
    };
}

export async function flushDeferredPrinterScanRefresh(
    deferredRefresh: DeferredPrinterScanRefresh,
    signal: AbortSignal,
): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }
    try {
        await deferredRefresh.flush();
    } catch {
        // A refresh failure must not replace the original scan error.
    }
    return !signal.aborted;
}

export function createSerializedProgressUpdates(
    update: (completed: number, total: number) => Promise<void>,
    signal?: AbortSignal,
): SerializedProgressUpdates {
    let pending = Promise.resolve();
    const report = (completed: number, total: number): Promise<void> => {
        pending = pending
            .catch(() => undefined)
            .then(() => (signal?.aborted ? undefined : update(completed, total)))
            .catch(() => undefined);
        return pending;
    };
    return { report, flush: () => pending };
}

export interface GetPrinterScanTargetsOptions {
    maxAddresses?: number;
    configuredHosts?: Iterable<string>;
    resolveHostname?: (hostname: string) => Promise<readonly string[]>;
    hostnameResolutionTimeoutMs?: number;
    signal?: AbortSignal;
}

async function resolveHostnameIpv4(hostname: string): Promise<readonly string[]> {
    return (await lookup(hostname, { all: true, verbatim: true }))
        .filter(({ family }) => family === 4)
        .map(({ address }) => address);
}

function resolveHostnameWithTimeout(
    hostname: string,
    resolver: (hostname: string) => Promise<readonly string[]>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<readonly string[] | undefined> {
    return new Promise(resolve => {
        let settled = false;
        if (signal?.aborted) {
            resolve(undefined);
            return;
        }
        const timeout = setTimeout(() => finish(), timeoutMs);
        const onAbort = (): void => finish();
        function finish(addresses?: readonly string[]): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            resolve(addresses);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        void Promise.resolve()
            .then(() => (signal?.aborted ? undefined : resolver(hostname)))
            .then(
                addresses => finish(addresses),
                () => finish(),
            );
    });
}

async function resolveConfiguredHostAddresses(
    hostnames: string[],
    resolver: (hostname: string) => Promise<readonly string[]>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ addresses: Set<number>; failed: boolean }> {
    const addresses = new Set<number>();
    let nextIndex = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
        while (!signal?.aborted && !failed && nextIndex < hostnames.length) {
            const hostname = hostnames[nextIndex++];
            const resolved = await resolveHostnameWithTimeout(hostname, resolver, timeoutMs, signal);
            if (resolved === undefined) {
                if (!signal?.aborted) {
                    failed = true;
                }
                return;
            }
            for (const address of resolved) {
                const parsed = ipv4ToNumber(address);
                if (parsed !== null) {
                    addresses.add(parsed);
                }
            }
        }
    };
    const workerCount = Math.min(MAX_HOSTNAME_RESOLUTION_CONCURRENCY, hostnames.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { addresses, failed };
}

function ipv4ToNumber(address: string): number | null {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) {
        return null;
    }
    const octets = parts.map(Number);
    if (octets.some(octet => octet < 0 || octet > 255)) {
        return null;
    }
    return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function numberToIpv4(address: number): string {
    return `${address >>> 24}.${(address >>> 16) & 255}.${(address >>> 8) & 255}.${address & 255}`;
}

function getPrivateRange(address: number): AddressRange | undefined {
    return PRIVATE_IPV4_RANGES.find(range => address >= range.first && address <= range.last);
}

function getInterfaceRange(info: NetworkInterfaceInfo): AddressRange | undefined {
    if (info.family !== 'IPv4') {
        return undefined;
    }
    const address = ipv4ToNumber(info.address);
    const mask = ipv4ToNumber(info.netmask);
    const privateRange = address === null ? undefined : getPrivateRange(address);
    if (address === null || mask === null || !privateRange) {
        return undefined;
    }

    const maskBits = mask.toString(2).padStart(32, '0');
    if (!/^1*0*$/.test(maskBits)) {
        return undefined;
    }
    const prefixLength = maskBits.indexOf('0') === -1 ? 32 : maskBits.indexOf('0');
    const subnetFirst = (address & mask) >>> 0;
    const subnetLast = (subnetFirst | (~mask >>> 0)) >>> 0;
    const firstHost = prefixLength <= 30 ? subnetFirst + 1 : subnetFirst;
    const lastHost = prefixLength <= 30 ? subnetLast - 1 : subnetLast;
    const first = Math.max(firstHost, privateRange.first);
    const last = Math.min(lastHost, privateRange.last);
    return first <= last ? { first, last } : undefined;
}

function mergeRanges(ranges: AddressRange[]): AddressRange[] {
    const sorted = [...ranges].sort((left, right) => left.first - right.first || left.last - right.last);
    const merged: AddressRange[] = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || range.first > previous.last + 1) {
            merged.push({ ...range });
        } else {
            previous.last = Math.max(previous.last, range.last);
        }
    }
    return merged;
}

function createPrinterId(host: string, usedIds: Set<string>): string {
    const base = `printer-${host.replace(/\./g, '-')}`;
    let suffix = 1;
    let id = base;
    while (usedIds.has(getPrinterIdKey(id))) {
        suffix++;
        const ending = `-${suffix}`;
        id = `${base.slice(0, 32 - ending.length)}${ending}`;
    }
    usedIds.add(getPrinterIdKey(id));
    return id;
}

export async function getPrinterScanTargets(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
    options: GetPrinterScanTargetsOptions = {},
): Promise<PrinterScanTargets> {
    const maxAddresses = Number.isInteger(options.maxAddresses)
        ? Math.max(0, Math.min(MAX_PRINTER_SCAN_ADDRESSES, options.maxAddresses!))
        : MAX_PRINTER_SCAN_ADDRESSES;
    const configuredAddresses = new Set<number>();
    const configuredHostnames = new Set<string>();
    for (const host of options.configuredHosts ?? []) {
        const hostKey = getPrinterHostKey(host);
        const address = ipv4ToNumber(hostKey);
        if (address !== null) {
            configuredAddresses.add(address);
        } else if (hostKey && isIP(hostKey) === 0) {
            configuredHostnames.add(hostKey);
        }
    }
    if (configuredHostnames.size > MAX_CONFIGURED_PRINTER_HOSTNAMES) {
        return {
            addresses: [],
            eligibleAddressCount: 0,
            limited: false,
            configuredHostResolutionLimited: true,
        };
    }
    const resolutionTimeoutMs = Number.isInteger(options.hostnameResolutionTimeoutMs)
        ? Math.max(1, Math.min(MAX_HOSTNAME_RESOLUTION_TIMEOUT_MS, options.hostnameResolutionTimeoutMs!))
        : DEFAULT_HOSTNAME_RESOLUTION_TIMEOUT_MS;
    const resolvedHosts = await resolveConfiguredHostAddresses(
        [...configuredHostnames],
        options.resolveHostname ?? resolveHostnameIpv4,
        resolutionTimeoutMs,
        options.signal,
    );
    if (options.signal?.aborted) {
        return { addresses: [], eligibleAddressCount: 0, limited: false };
    }
    if (resolvedHosts.failed) {
        return {
            addresses: [],
            eligibleAddressCount: 0,
            limited: false,
            configuredHostResolutionFailed: true,
        };
    }
    for (const address of resolvedHosts.addresses) {
        configuredAddresses.add(address);
    }

    const ownAddresses = new Set<number>();
    const ranges: AddressRange[] = [];
    for (const entries of Object.values(interfaces)) {
        for (const info of entries ?? []) {
            if (info.family === 'IPv4') {
                const ownAddress = ipv4ToNumber(info.address);
                if (ownAddress !== null) {
                    ownAddresses.add(ownAddress);
                }
            }
            if (!info.internal) {
                const range = getInterfaceRange(info);
                if (range) {
                    ranges.push(range);
                }
            }
        }
    }

    const excludedAddresses = new Set([...ownAddresses, ...configuredAddresses]);

    const mergedRanges = mergeRanges(ranges);
    const excludedByRange = mergedRanges.map(range =>
        [...excludedAddresses].filter(address => address >= range.first && address <= range.last).sort((a, b) => a - b),
    );
    const eligibleCounts = mergedRanges.map(
        (range, index) => range.last - range.first + 1 - excludedByRange[index].length,
    );
    const eligibleAddressCount = eligibleCounts.reduce((total, count) => total + count, 0);
    const limited = eligibleAddressCount > maxAddresses;
    const targetCount = Math.min(eligibleAddressCount, maxAddresses);
    const rangeTargets = new Array(mergedRanges.length).fill(0) as number[];
    let unallocated = targetCount;
    while (unallocated > 0) {
        const activeRanges = eligibleCounts
            .map((count, index) => (rangeTargets[index] < count ? index : -1))
            .filter(index => index >= 0);
        if (activeRanges.length === 0) {
            break;
        }
        const share = Math.max(1, Math.floor(unallocated / activeRanges.length));
        for (const index of activeRanges) {
            const allocation = Math.min(share, eligibleCounts[index] - rangeTargets[index], unallocated);
            rangeTargets[index] += allocation;
            unallocated -= allocation;
            if (unallocated === 0) {
                break;
            }
        }
    }

    const addresses: string[] = [];
    for (let rangeIndex = 0; rangeIndex < mergedRanges.length; rangeIndex++) {
        const range = mergedRanges[rangeIndex];
        const targetCountForRange = rangeTargets[rangeIndex];
        for (let sample = 0; sample < targetCountForRange; sample++) {
            const eligibleIndex =
                limited && targetCountForRange < eligibleCounts[rangeIndex]
                    ? Math.floor(((sample + 0.5) * eligibleCounts[rangeIndex]) / targetCountForRange)
                    : sample;
            let address = range.first + eligibleIndex;
            for (const excluded of excludedByRange[rangeIndex]) {
                if (excluded > address) {
                    break;
                }
                address++;
            }
            addresses.push(numberToIpv4(address));
        }
    }

    return { addresses, eligibleAddressCount, limited };
}

export async function scanForPrinters(
    targets: PrinterScanTargets,
    probe: (host: string) => Promise<PrinterScanProbeResult>,
    options: PrinterScanOptions = {},
): Promise<PrinterScanResult> {
    const hosts = [...new Set(targets.addresses)];
    const concurrency = Number.isInteger(options.concurrency)
        ? Math.max(1, Math.min(MAX_PRINTER_SCAN_CONCURRENCY, options.concurrency!))
        : MAX_PRINTER_SCAN_CONCURRENCY;
    const found: Array<PrinterScanProbeResult | undefined> = new Array(hosts.length);
    let nextIndex = 0;
    let completed = 0;

    const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
        while (!options.signal?.aborted && nextIndex < hosts.length) {
            const index = nextIndex++;
            try {
                found[index] = await probe(hosts[index]);
            } catch {
                // A closed port, timeout, or non-IPP response simply means this address is not a candidate.
            } finally {
                completed++;
                if (!options.signal?.aborted) {
                    try {
                        await options.onProgress?.(completed, hosts.length);
                    } catch {
                        // A progress display failure must not abort the bounded network scan.
                    }
                }
            }
        }
    });
    await Promise.all(workers);

    const usedIds = new Set(Array.from(options.configuredIds ?? [], getPrinterIdKey));
    const candidates: PrinterScanCandidate[] = [];
    for (let index = 0; index < hosts.length; index++) {
        const result = found[index];
        if (!result) {
            continue;
        }
        const host = hosts[index];
        const model = result.model?.trim() || undefined;
        const label = model || result.printerName?.trim() || host;
        candidates.push({ id: createPrinterId(host, usedIds), host, label, model });
    }

    return { candidates, scanned: hosts.length };
}
