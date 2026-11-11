import type {} from '@iobroker/adapter-core';

const PRINTER_CONFIG_FILE = 'printer-config.json';
const LEGACY_PRINTER_CONFIG_STORAGE_ID = 'info.printerConfig';
const LEGACY_PRINTER_CONFIG_FILE = 'printers.json';

interface PrinterConfigStoreAdapter {
    namespace: string;
    getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<unknown>;
    fileExistsAsync(adapter: string | null, path: string): Promise<boolean>;
    readFileAsync(adapter: string | null, path: string): ioBroker.ReadFilePromise;
    writeFileAsync(adapter: string | null, path: string, data: string): Promise<void>;
    unlinkAsync(adapter: string | null, path: string): Promise<void>;
}

function legacyStorageId(adapter: PrinterConfigStoreAdapter): string {
    return `${adapter.namespace}.${LEGACY_PRINTER_CONFIG_STORAGE_ID}`;
}

async function hasLegacyStorageObject(adapter: PrinterConfigStoreAdapter): Promise<boolean> {
    const storageObject = await adapter.getObjectAsync(LEGACY_PRINTER_CONFIG_STORAGE_ID);
    return (
        storageObject?.type === 'meta' &&
        storageObject.common.type === 'meta.user' &&
        storageObject.common.name === 'Printer configuration storage'
    );
}

async function readConfigurationFile(
    adapter: PrinterConfigStoreAdapter,
    storage: string | null,
    path: string,
): Promise<unknown[]> {
    const { file } = await adapter.readFileAsync(storage, path);
    const storedConfiguration = JSON.parse(typeof file === 'string' ? file : file.toString('utf8')) as unknown;
    if (!Array.isArray(storedConfiguration)) {
        throw new Error('Stored printer configuration must be an array');
    }
    return storedConfiguration;
}

async function removeLegacyStorage(adapter: PrinterConfigStoreAdapter): Promise<void> {
    if (!(await hasLegacyStorageObject(adapter))) {
        return;
    }
    const storageId = legacyStorageId(adapter);
    if (await adapter.fileExistsAsync(storageId, LEGACY_PRINTER_CONFIG_FILE)) {
        await adapter.unlinkAsync(storageId, LEGACY_PRINTER_CONFIG_FILE);
    }
    await adapter.delObjectAsync(LEGACY_PRINTER_CONFIG_STORAGE_ID);
}

export async function loadPrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    legacyConfiguration: unknown,
): Promise<unknown[]> {
    if (await adapter.fileExistsAsync(null, PRINTER_CONFIG_FILE)) {
        const printers = await readConfigurationFile(adapter, null, PRINTER_CONFIG_FILE);
        await removeLegacyStorage(adapter);
        return printers;
    }

    const oldStorageId = legacyStorageId(adapter);
    const printers =
        (await hasLegacyStorageObject(adapter)) &&
        (await adapter.fileExistsAsync(oldStorageId, LEGACY_PRINTER_CONFIG_FILE))
            ? await readConfigurationFile(adapter, oldStorageId, LEGACY_PRINTER_CONFIG_FILE)
            : Array.isArray(legacyConfiguration)
              ? legacyConfiguration
              : [];
    await adapter.writeFileAsync(null, PRINTER_CONFIG_FILE, JSON.stringify(printers));
    await removeLegacyStorage(adapter);
    return printers;
}

export async function savePrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    printers: unknown[],
): Promise<void> {
    await adapter.writeFileAsync(null, PRINTER_CONFIG_FILE, JSON.stringify(printers));
    await removeLegacyStorage(adapter);
}
