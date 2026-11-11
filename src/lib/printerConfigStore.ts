import type {} from '@iobroker/adapter-core';

const PRINTER_CONFIG_FILE = 'printer-config.json';
const PRINTER_CONFIG_STORAGE_NAME = 'Printer configuration storage';
const LEGACY_PRINTER_CONFIG_STORAGE_ID = 'info.printerConfig';
const LEGACY_PRINTER_CONFIG_FILE = 'printers.json';

interface PrinterConfigStoreAdapter {
    namespace: string;
    getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    getObjectListAsync(params: { startkey: string; endkey: string }): Promise<{ rows: { id: string }[] }>;
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<unknown>;
    setForeignObjectNotExistsAsync(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    fileExistsAsync(adapter: string, path: string): Promise<boolean>;
    readFileAsync(adapter: string, path: string): ioBroker.ReadFilePromise;
    writeFileAsync(adapter: string, path: string, data: string): Promise<void>;
    unlinkAsync(adapter: string, path: string): Promise<void>;
}

function legacyStorageId(adapter: PrinterConfigStoreAdapter): string {
    return `${adapter.namespace}.${LEGACY_PRINTER_CONFIG_STORAGE_ID}`;
}

async function ensurePrinterConfigStorage(adapter: PrinterConfigStoreAdapter): Promise<void> {
    let storageObject = await adapter.getForeignObjectAsync(adapter.namespace);
    if (!storageObject) {
        await adapter.setForeignObjectNotExistsAsync(adapter.namespace, {
            type: 'meta',
            common: { name: PRINTER_CONFIG_STORAGE_NAME, type: 'meta.user' },
            native: {},
            from: `system.adapter.${adapter.namespace}`,
        });
        storageObject = await adapter.getForeignObjectAsync(adapter.namespace);
    }

    if (
        storageObject?.type !== 'meta' ||
        storageObject.common.type !== 'meta.user' ||
        storageObject.common.name !== PRINTER_CONFIG_STORAGE_NAME ||
        storageObject.from !== `system.adapter.${adapter.namespace}`
    ) {
        throw new Error(`Cannot use ${adapter.namespace} for printer configuration file storage`);
    }
}

async function hasLegacyStorageObject(adapter: PrinterConfigStoreAdapter): Promise<boolean> {
    const storageObject = await adapter.getObjectAsync(LEGACY_PRINTER_CONFIG_STORAGE_ID);
    return (
        storageObject?.type === 'meta' &&
        storageObject.common.type === 'meta.user' &&
        storageObject.common.name === 'Printer configuration storage' &&
        storageObject.from === `system.adapter.${adapter.namespace}`
    );
}

async function readConfigurationFile(
    adapter: PrinterConfigStoreAdapter,
    storage: string,
    path: string,
): Promise<unknown[]> {
    const { file } = await adapter.readFileAsync(storage, path);
    const storedConfiguration = JSON.parse(typeof file === 'string' ? file : file.toString('utf8')) as unknown;
    if (!Array.isArray(storedConfiguration)) {
        throw new Error('Stored printer configuration must be an array');
    }
    return storedConfiguration;
}

async function removeLegacyStorage(adapter: PrinterConfigStoreAdapter, printers: unknown[]): Promise<void> {
    if (await hasLegacyStorageObject(adapter)) {
        const storageId = legacyStorageId(adapter);
        if (await adapter.fileExistsAsync(storageId, LEGACY_PRINTER_CONFIG_FILE)) {
            await adapter.unlinkAsync(storageId, LEGACY_PRINTER_CONFIG_FILE);
        }
        await adapter.delObjectAsync(LEGACY_PRINTER_CONFIG_STORAGE_ID);
    }

    if (
        printers.some(
            printer => typeof printer === 'object' && printer !== null && 'id' in printer && printer.id === 'info',
        )
    ) {
        return;
    }

    const infoRoot = await adapter.getObjectAsync('info');
    if (infoRoot?.type !== 'device' || infoRoot.from !== `system.adapter.${adapter.namespace}`) {
        return;
    }

    const children = await adapter.getObjectListAsync({
        startkey: `${adapter.namespace}.info.`,
        endkey: `${adapter.namespace}.info.\u9999`,
    });
    if (children.rows.length === 0) {
        await adapter.delObjectAsync('info');
    }
}

export async function loadPrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    legacyConfiguration: unknown,
): Promise<unknown[]> {
    await ensurePrinterConfigStorage(adapter);
    if (await adapter.fileExistsAsync(adapter.namespace, PRINTER_CONFIG_FILE)) {
        const printers = await readConfigurationFile(adapter, adapter.namespace, PRINTER_CONFIG_FILE);
        await removeLegacyStorage(adapter, printers);
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
    await adapter.writeFileAsync(adapter.namespace, PRINTER_CONFIG_FILE, JSON.stringify(printers));
    await removeLegacyStorage(adapter, printers);
    return printers;
}

export async function savePrinterConfigurations(
    adapter: PrinterConfigStoreAdapter,
    printers: unknown[],
): Promise<void> {
    await ensurePrinterConfigStorage(adapter);
    await adapter.writeFileAsync(adapter.namespace, PRINTER_CONFIG_FILE, JSON.stringify(printers));
    await removeLegacyStorage(adapter, printers);
}
