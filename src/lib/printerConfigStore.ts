import type {} from '@iobroker/adapter-core';

const PRINTER_CONFIG_STORAGE_ID = 'info.printerConfig';
const PRINTER_CONFIG_FILE = 'printers.json';

interface PrinterConfigStoreAdapter {
    namespace: string;
    setObjectNotExistsAsync(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    fileExistsAsync(adapter: string | null, path: string): Promise<boolean>;
    readFileAsync(adapter: string | null, path: string): ioBroker.ReadFilePromise;
    writeFileAsync(adapter: string | null, path: string, data: string): Promise<void>;
}

async function ensureStorage(adapter: PrinterConfigStoreAdapter): Promise<string> {
    await adapter.setObjectNotExistsAsync(PRINTER_CONFIG_STORAGE_ID, {
        type: 'meta',
        common: { name: 'Printer configuration storage', type: 'meta.user' },
        native: {},
    });
    return `${adapter.namespace}.${PRINTER_CONFIG_STORAGE_ID}`;
}

export async function loadPrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    legacyConfiguration: unknown,
): Promise<unknown[]> {
    const storageId = await ensureStorage(adapter);
    if (await adapter.fileExistsAsync(storageId, PRINTER_CONFIG_FILE)) {
        const { file } = await adapter.readFileAsync(storageId, PRINTER_CONFIG_FILE);
        const storedConfiguration = JSON.parse(typeof file === 'string' ? file : file.toString('utf8')) as unknown;
        if (!Array.isArray(storedConfiguration)) {
            throw new Error('Stored printer configuration must be an array');
        }
        return storedConfiguration;
    }

    const printers = Array.isArray(legacyConfiguration) ? legacyConfiguration : [];
    await adapter.writeFileAsync(storageId, PRINTER_CONFIG_FILE, JSON.stringify(printers));
    return printers;
}

export async function savePrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    printers: unknown[],
): Promise<void> {
    const storageId = await ensureStorage(adapter);
    await adapter.writeFileAsync(storageId, PRINTER_CONFIG_FILE, JSON.stringify(printers));
}
