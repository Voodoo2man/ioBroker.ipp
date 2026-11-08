import type { PrinterEndpoint } from './printerIpp';
import { isValidIppBasePath, isValidPrinterHost } from './printerEndpoint';

export interface PrinterConfig extends PrinterEndpoint {
    id: string;
    label?: string;
}

export interface PrinterConfigResult {
    config?: PrinterConfig;
    errors: string[];
}

export interface PrinterConfigParseOptions {
    allowLegacyInfoId?: boolean;
}

function normalizeCheckbox(value: unknown): boolean | undefined | null {
    if (value === undefined || value === null || value === '') {
        return false;
    }
    if (value === true || value === 1 || value === '1' || value === 'true') {
        return true;
    }
    if (value === false || value === 0 || value === '0' || value === 'false') {
        return false;
    }
    return null;
}

function normalizePrinterId(value: string): string {
    return value
        .replace(/[äÄ]/g, match => (match === 'Ä' ? 'Ae' : 'ae'))
        .replace(/[öÖ]/g, match => (match === 'Ö' ? 'Oe' : 'oe'))
        .replace(/[üÜ]/g, match => (match === 'Ü' ? 'Ue' : 'ue'))
        .replace(/ß/g, 'ss');
}

export function getPrinterIdKey(value: string): string {
    return normalizePrinterId(value).toLowerCase();
}

export function parsePrinterConfig(
    value: unknown,
    previousId?: string,
    options: PrinterConfigParseOptions = {},
): PrinterConfigResult {
    const errors = getPrinterConfigErrors(value, options.allowLegacyInfoId === true);
    if (!value || typeof value !== 'object' || Array.isArray(value) || errors.length > 0) {
        return { errors };
    }

    const printer = value as Record<string, unknown>;
    const ssl = normalizeCheckbox(printer.ssl);
    const verifySsl = normalizeCheckbox(printer.verifySsl);
    if (ssl === null || verifySsl === null) {
        if (ssl === null) {
            errors.push('ssl must be true/false, 1/0, or an unchecked checkbox');
        }
        if (verifySsl === null) {
            errors.push('verifySsl must be true/false, 1/0, or an unchecked checkbox');
        }
        return { errors };
    }

    const normalizedId = normalizePrinterId(printer.id as string);
    if (previousId && getPrinterIdKey(normalizedId) !== getPrinterIdKey(previousId)) {
        errors.push('id cannot be changed after creation');
        return { errors };
    }
    const id = previousId ?? normalizedId;

    return {
        config: {
            id,
            label: typeof printer.label === 'string' ? printer.label : undefined,
            host: printer.host as string,
            port: printer.port === '' ? 631 : ((printer.port as number | undefined) ?? 631),
            basePath: printer.basePath as string | undefined,
            ssl,
            verifySsl,
        },
        errors: [],
    };
}

export function getUniquePrinterConfigs(values: unknown[], options: PrinterConfigParseOptions = {}): PrinterConfig[] {
    const ids = new Set<string>();
    return values.flatMap(value => {
        const parsed = parsePrinterConfig(value, undefined, options);
        if (!parsed.config || ids.has(getPrinterIdKey(parsed.config.id))) {
            return [];
        }
        ids.add(getPrinterIdKey(parsed.config.id));
        return [parsed.config];
    });
}

export function getPrinterConfigErrors(value: unknown, allowLegacyInfoId = false): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ['row must be an object'];
    }

    const printer = value as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof printer.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(normalizePrinterId(printer.id))) {
        errors.push('id must contain 1-32 letters, digits, underscores, or hyphens');
    } else if (getPrinterIdKey(printer.id) === 'info' && !allowLegacyInfoId) {
        errors.push('id is reserved by the adapter');
    }
    if (typeof printer.host !== 'string' || printer.host.trim() === '') {
        errors.push('host is missing or is not text');
    } else if (!isValidPrinterHost(printer.host)) {
        errors.push('host must be a valid hostname or IP address');
    }
    if (
        printer.port !== undefined &&
        printer.port !== '' &&
        (!Number.isInteger(Number(printer.port)) || Number(printer.port) < 1 || Number(printer.port) > 65535)
    ) {
        errors.push('port must be an integer from 1 to 65535');
    }
    if (printer.basePath !== undefined && !isValidIppBasePath(printer.basePath)) {
        errors.push('basePath must be an absolute path without .., query, fragment, whitespace, or backslash');
    }
    for (const key of ['ssl', 'verifySsl']) {
        if (normalizeCheckbox(printer[key]) === null) {
            errors.push(`${key} must be true/false, 1/0, or an unchecked checkbox`);
        }
    }
    return errors;
}

export function describePrinterConfig(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `rowType=${Array.isArray(value) ? 'array' : typeof value}`;
    }

    const printer = value as Record<string, unknown>;
    const fields = ['id', 'label', 'host', 'port', 'basePath', 'ssl', 'verifySsl'];
    return fields.map(key => `${key}=${key in printer ? typeof printer[key] : 'missing'}`).join(', ');
}
