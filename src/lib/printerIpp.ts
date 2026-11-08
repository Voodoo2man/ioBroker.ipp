import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as ipp from '@sealsystems/ipp';
import { isValidIppBasePath, isValidPrinterHost } from './printerEndpoint';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const PRINTER_UNAVAILABLE_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EPIPE',
]);
const DETAIL_ATTRIBUTES = [
    ['printer-info', 'Printer information'],
    ['printer-location', 'Printer location'],
    ['printer-more-info', 'More information URL'],
    ['printer-is-accepting-jobs', 'Accepting jobs'],
    ['queued-job-count', 'Queued jobs'],
    ['printer-up-time', 'Uptime'],
    ['printer-current-time', 'Printer time'],
    ['operations-supported', 'Supported operations'],
    ['document-format-supported', 'Supported document formats'],
    ['color-supported', 'Color printing supported'],
    ['pages-per-minute', 'Pages per minute'],
    ['pages-per-minute-color', 'Color pages per minute'],
    ['uri-authentication-supported', 'Supported URI authentication'],
    ['uri-security-supported', 'Supported URI security'],
] as const;
const EXCLUDED_ATTRIBUTES = new Set([
    'charset-configured',
    'charset-supported',
    'compression-supported',
    'copies-default',
    'copies-supported',
    'document-format-default',
    'document-format-details-default',
    'document-format-supported',
    'document-format-varying-attributes',
    'document-format-version-supported',
    'document-password-supported',
    'ecpl-version-supported',
    'finishings-col-database',
    'finishings-col-default',
    'finishings-col-ready',
    'finishings-col-supported',
    'finishings-default',
    'finishings-supported',
    'generated-natural-language-supported',
    'hp-image-enhancement-support',
    'hp-pc-version-major',
    'hp-pc-version-minor',
    'hp-print-quality-supported',
    'identify-actions-default',
    'identify-actions-supported',
    'ipp-features-supported',
    'ipp-versions-supported',
    'job-account-id-default',
    'job-account-id-supported',
    'job-accounting-user-id-default',
    'job-accounting-user-id-supported',
    'job-constraints-supported',
    'job-creation-attributes-supported',
    'job-ids-supported',
    'job-pages-per-set-supported',
    'job-resolvers-supported',
    'jpeg-features-supported',
    'jpeg-k-octets-supported',
    'jpeg-x-dimension-supported',
    'jpeg-y-dimension-supported',
    'landscape-orientation-requested-preferred',
    'limit-operations-supported',
    'media-bottom-margin-supported',
    'media-col-default',
    'media-col-supported',
    'media-default',
    'media-left-margin-supported',
    'media-right-margin-supported',
    'media-size-supported',
    'media-source-supported',
    'media-top-margin-supported',
    'media-type-supported',
    'multiple-document-handling-default',
    'multiple-document-handling-supported',
    'multiple-document-jobs-supported',
    'multiple-operation-time-out',
    'multiple-operation-time-out-action',
    'natural-language-configured',
    'number-up-default',
    'number-up-supported',
    'operations-supported',
    'orientation-requested-default',
    'orientation-requested-supported',
    'output-bin-default',
    'output-bin-supported',
    'output-mode-default',
    'output-mode-supported',
    'overrides-supported',
    'page-ranges-supported',
    'pclm-compression-method-preferred',
    'pclm-raster-back-side',
    'pclm-source-resolution-default',
    'pclm-source-resolution-supported',
    'pclm-strip-height-preferred',
    'pclm-strip-height-supported',
    'pdf-fit-to-page-default',
    'pdf-fit-to-page-supported',
    'pdf-k-octets-supported',
    'pdf-size-constraints',
    'pdf-versions-supported',
    'pdl-override-supported',
    'preferred-attributes-supported',
    'presentation-direction-number-up-default',
    'presentation-direction-number-up-supported',
    'print-color-mode-default',
    'print-color-mode-supported',
    'print-content-optimize-default',
    'print-content-optimize-supported',
    'print-quality-default',
    'print-quality-supported',
    'print-rendering-intent-default',
    'print-rendering-intent-supported',
    'print-scaling-default',
    'print-scaling-supported',
    'printer-config-change-date-time',
    'printer-config-change-time',
    'printer-finisher',
    'printer-finisher-description',
    'printer-get-attributes-supported',
    'printer-icons',
    'printer-strings-languages-supported',
    'reference-uri-schemes-supported',
    'sides-default',
    'sides-supported',
    'urf-supported',
    'uri-authentication-supported',
    'uri-security-supported',
    'which-jobs-supported',
]);
const EXCLUDED_ATTRIBUTE_FAMILIES = [
    /^(charset|compression|copies|document-format|finishings|identify-actions|ipp-features|ipp-versions|job-.*|jpeg-.*|landscape-orientation-requested|limit-operations|media-.*|multiple-document-.*|multiple-operation-.*|natural-language-configured|number-up|operations-supported|orientation-requested-.*|output-bin|output-mode|overrides-supported|page-ranges-supported|pclm-.*|pdf-.*|pdl-override-supported|preferred-attributes-supported|presentation-direction-number-up-.*|print-.*|printer-get-attributes-supported|printer-icons|printer-strings-languages-supported|reference-uri-schemes-supported|sides-.*|urf-supported|uri-authentication-supported|uri-security-supported|which-jobs-supported)$/,
    /-(supported)$/,
    /(^|-)(default|preferred)(-|$)/,
];
const DETAIL_NAMES = new Map<string, string>(DETAIL_ATTRIBUTES);
const RETAINED_ATTRIBUTE_OVERRIDES = new Set([
    'color-supported',
    'hp-default-duplex-standard',
    'manual-duplex-supported',
    'pages-completed',
    'impressions-completed',
    'media-sheets-completed',
]);
const DEDICATED_STATE_ATTRIBUTES = new Set([
    'printer-state',
    'printer-state-message',
    'printer-state-reasons',
    'printer-make-and-model',
    'pages-completed',
    'impressions-completed',
    'media-sheets-completed',
]);
const printerAttributes = ipp.attributes['Printer Description'];
const documentAttributes = ipp.attributes['Document Description'];
for (const name of ['pages-completed', 'impressions-completed', 'media-sheets-completed']) {
    if (!printerAttributes[name] && documentAttributes[name]) {
        printerAttributes[name] = documentAttributes[name];
    }
}
export interface PrinterEndpoint {
    host: string;
    port?: number | string;
    basePath?: string;
    ssl?: boolean;
    verifySsl?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface PrinterRequestTimer {
    setTimeout(callback: () => void, timeout: number): ioBroker.Timeout | undefined;
    clearTimeout(timeout: ioBroker.Timeout | undefined): void;
}

export interface PrinterSupply {
    description: string;
    level: number;
    maxLevel: number;
    unit: number;
    markerType: unknown;
    sourceIndex?: number;
}

export interface PrinterSnapshot {
    online: boolean;
    printerState: number | null;
    status: string | null;
    model: string | null;
    printerName: string | null;
    supplies: PrinterSupply[];
    counters: {
        pagesCompleted: number | null;
        impressionsCompleted: number | null;
        mediaSheetsCompleted: number | null;
    };
    details: Array<{ id: string; name: string; value: string | number | boolean }>;
}

export function isPrinterUnavailableError(error: unknown): boolean {
    return error instanceof Error && PRINTER_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '');
}

function asArray(value: unknown): unknown[] {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
    return null;
}

function normalizePrinterState(value: unknown): number | null {
    const numericState = finiteNumber(value);
    if (numericState !== null) {
        return numericState;
    }
    if (value === 'idle') {
        return 3;
    }
    if (value === 'processing') {
        return 4;
    }
    if (value === 'stopped') {
        return 5;
    }
    return null;
}

function responseAttributes(response: ipp.IppResponse): Record<string, unknown> {
    const attributes = response['printer-attributes-tag'] ?? response['unsupported-attributes-tag'];
    return attributes && typeof attributes === 'object' ? (attributes as Record<string, unknown>) : {};
}

function detailValue(value: unknown): string | number | boolean | null {
    if (typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }
    if (value === null || value === undefined) {
        return null;
    }
    try {
        return JSON.stringify(value) ?? null;
    } catch {
        return '[unserializable]';
    }
}

function detailId(attribute: string): string {
    return attribute
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

export function normalizeSnapshot(response: ipp.IppResponse): PrinterSnapshot {
    const attributes = responseAttributes(response);
    const reasons = asArray(attributes['printer-state-reasons']).filter(
        (value): value is string => typeof value === 'string',
    );
    const stateMessages = asArray(attributes['printer-state-message']).filter(
        (value): value is string => typeof value === 'string',
    );
    const markerNames = asArray(attributes['marker-names']);
    const markerLevels = asArray(attributes['marker-levels']);
    const markerTypes = asArray(attributes['marker-types']);
    const supplies = markerNames.flatMap((name, index): PrinterSupply[] => {
        const level = finiteNumber(markerLevels[index]);
        if (typeof name !== 'string' || name.trim() === '' || level === null || level < 0 || level > 100) {
            return [];
        }
        return [
            {
                description: name.trim(),
                level,
                maxLevel: 100,
                unit: 14,
                markerType: markerTypes[index] ?? null,
                sourceIndex: index,
            },
        ];
    });
    const detailIds = new Set<string>();
    const details = Object.entries(attributes)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .flatMap(([attribute, rawValue]) => {
            if (DEDICATED_STATE_ATTRIBUTES.has(attribute)) {
                return [];
            }
            if (
                !RETAINED_ATTRIBUTE_OVERRIDES.has(attribute) &&
                (EXCLUDED_ATTRIBUTES.has(attribute) ||
                    EXCLUDED_ATTRIBUTE_FAMILIES.some(pattern => pattern.test(attribute)) ||
                    /^marker-(colors|high-levels|levels|low-levels|names|types)$/.test(attribute))
            ) {
                return [];
            }
            const value = detailValue(rawValue);
            const baseId = detailId(attribute);
            if (!baseId || value === null) {
                return [];
            }

            let id = baseId;
            let suffix = 2;
            while (detailIds.has(id)) {
                id = `${baseId}_${suffix++}`;
            }
            detailIds.add(id);

            const name = DETAIL_NAMES.get(attribute) ?? attribute.replace(/-/g, ' ');
            return [{ id, name, value }];
        });

    return {
        online: true,
        printerState: normalizePrinterState(attributes['printer-state']),
        status: stateMessages[0] || reasons.join(', ') || null,
        model: typeof attributes['printer-make-and-model'] === 'string' ? attributes['printer-make-and-model'] : null,
        printerName: typeof attributes['printer-name'] === 'string' ? attributes['printer-name'] : null,
        supplies,
        counters: {
            pagesCompleted: finiteNumber(attributes['pages-completed']),
            impressionsCompleted: finiteNumber(attributes['impressions-completed']),
            mediaSheetsCompleted: finiteNumber(attributes['media-sheets-completed']),
        },
        details,
    };
}

function makeRequest(uri: string): Buffer {
    return ipp.serialize({
        version: '2.0',
        operation: 'Get-Printer-Attributes',
        id: 1,
        'operation-attributes-tag': {
            'attributes-charset': 'utf-8',
            'attributes-natural-language': 'en',
            'printer-uri': uri,
            'requested-attributes': ['all'],
        },
    });
}

function sendRequest(
    url: URL,
    uri: string,
    timeoutMs: number,
    verifySsl: boolean,
    timer: PrinterRequestTimer,
    signal?: AbortSignal,
): Promise<ipp.IppResponse> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const requestBody = makeRequest(uri);
        const agent = url.protocol === 'https:' ? new https.Agent({ rejectUnauthorized: verifySsl }) : undefined;
        let response: http.IncomingMessage | undefined;
        let parserWorker: Worker | undefined;
        let settled = false;
        const controls: {
            request?: http.ClientRequest;
            deadline?: ioBroker.Timeout;
            onAbort?: () => void;
        } = {};
        const finish = (error?: Error, parsed?: ipp.IppResponse): void => {
            if (settled) {
                return;
            }
            settled = true;
            timer.clearTimeout(controls.deadline);
            if (controls.onAbort) {
                signal?.removeEventListener('abort', controls.onAbort);
            }
            agent?.destroy();
            if (error) {
                response?.destroy();
                void parserWorker?.terminate();
                reject(error);
            } else {
                void parserWorker?.terminate();
                resolve(parsed!);
            }
        };
        const timeoutError = (): NodeJS.ErrnoException => {
            const error = new Error('Printer request timed out') as NodeJS.ErrnoException;
            error.code = 'ETIMEDOUT';
            return error;
        };
        const onAbort = (): void => {
            const error = new Error('Printer request was aborted') as NodeJS.ErrnoException;
            error.code = 'ABORT_ERR';
            controls.request?.destroy(error);
            finish(error);
        };
        const request = transport.request(
            url,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/ipp',
                    accept: 'application/ipp',
                    'content-length': requestBody.length,
                },
                agent,
            },
            incomingResponse => {
                response = incomingResponse;
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        const error = new Error('IPP response exceeded the size limit');
                        response?.destroy(error);
                        request.destroy(error);
                        finish(error);
                        return;
                    }
                    chunks.push(chunk);
                });
                response.once('aborted', () => finish(new Error('Printer sent an incomplete IPP response')));
                response.once('error', () => finish(new Error('Printer sent an incomplete IPP response')));
                response.on('end', () => {
                    const statusCode = incomingResponse.statusCode ?? 0;
                    if (statusCode < 200 || statusCode >= 300) {
                        finish(new Error(`IPP endpoint returned HTTP ${statusCode}`));
                        return;
                    }
                    parserWorker = new Worker(join(__dirname, 'ippParserWorker.js'), {
                        workerData: Buffer.concat(chunks),
                    });
                    parserWorker.once('message', (result: { response?: ipp.IppResponse; error?: string }) => {
                        if (!result.response) {
                            finish(new Error('Printer returned an invalid IPP response'));
                        } else if (
                            !result.response.statusCode ||
                            !String(result.response.statusCode).startsWith('successful-')
                        ) {
                            finish(new Error('Printer returned an unsuccessful IPP response'));
                        } else {
                            finish(undefined, result.response);
                        }
                    });
                    parserWorker.once('error', () => finish(new Error('Printer returned an invalid IPP response')));
                    parserWorker.once('exit', code => {
                        if (code !== 0) {
                            finish(new Error('Printer returned an invalid IPP response'));
                        }
                    });
                });
            },
        );
        controls.request = request;
        const deadline = timer.setTimeout(() => {
            const error = timeoutError();
            request.destroy(error);
            finish(error);
        }, timeoutMs);
        controls.deadline = deadline;
        controls.onAbort = onAbort;
        request.setTimeout(timeoutMs, () => request.destroy(timeoutError()));
        request.on('error', (error: NodeJS.ErrnoException) => {
            const wrappedError = new Error(
                error.code === 'ETIMEDOUT'
                    ? 'Printer request timed out'
                    : error.code === 'ABORT_ERR'
                      ? 'Printer request was aborted'
                      : 'Printer IPP request failed',
            );
            wrappedError.name = error.name;
            (wrappedError as NodeJS.ErrnoException).code = error.code;
            finish(wrappedError);
        });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        request.end(requestBody);
    });
}

export async function pollPrinter(
    {
        host,
        port = 631,
        basePath = '/ipp/print',
        ssl = false,
        verifySsl = false,
        timeoutMs = 5000,
        signal,
    }: PrinterEndpoint,
    timer: PrinterRequestTimer,
): Promise<PrinterSnapshot> {
    const numericPort = Number(port);
    if (!isValidPrinterHost(host)) {
        throw new TypeError('A valid printer host is required');
    }
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
        throw new TypeError('Printer port must be an integer between 1 and 65535');
    }
    if (!isValidIppBasePath(basePath)) {
        throw new TypeError(
            'IPP base path must be an absolute path without query, fragment, whitespace, backslash, or ..',
        );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
        throw new TypeError('timeoutMs must be an integer between 500 and 30000');
    }
    const endpoint = new URL(`${ssl ? 'https:' : 'http:'}//${host.trim()}:${numericPort}${basePath}`);
    const uri = `${ssl ? 'ipps:' : 'ipp:'}//${endpoint.host}${endpoint.pathname}`;
    return normalizeSnapshot(await sendRequest(endpoint, uri, timeoutMs, verifySsl, timer, signal));
}
