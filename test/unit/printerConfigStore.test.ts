import { expect } from 'chai';
import { getPrinterIdKey, parsePrinterConfig } from '../../src/lib/printerConfig';
import { loadPrinterConfigurations, savePrinterConfigurations } from '../../src/lib/printerConfigStore';

function makeAdapter(): {
    namespace: string;
    objects: Map<string, unknown>;
    files: Map<string, string>;
    deletedObjects: string[];
    getObjectAsync: (id: string) => Promise<ioBroker.Object | null | undefined>;
    delObjectAsync: (id: string, options?: { recursive?: boolean }) => Promise<void>;
    fileExistsAsync: (adapter: string | null, path: string) => Promise<boolean>;
    readFileAsync: (adapter: string | null, path: string) => Promise<{ file: string }>;
    writeFileAsync: (adapter: string | null, path: string, data: string) => Promise<void>;
    unlinkAsync: (adapter: string | null, path: string) => Promise<void>;
} {
    const objects = new Map<string, unknown>();
    const files = new Map<string, string>();
    const deletedObjects: string[] = [];
    const fileId = (adapter: string | null, path: string): string => `${adapter}/${path}`;
    return {
        namespace: 'ipp.0',
        objects,
        files,
        deletedObjects,
        getObjectAsync: id => Promise.resolve((objects.get(id) as ioBroker.Object | undefined) ?? null),
        delObjectAsync: id => {
            deletedObjects.push(id);
            objects.delete(id);
            return Promise.resolve();
        },
        fileExistsAsync: (adapter, path) => Promise.resolve(files.has(fileId(adapter, path))),
        readFileAsync: (adapter, path) => Promise.resolve({ file: files.get(fileId(adapter, path))! }),
        writeFileAsync: (adapter, path, data) => {
            files.set(fileId(adapter, path), data);
            return Promise.resolve();
        },
        unlinkAsync: (adapter, path) => {
            files.delete(fileId(adapter, path));
            return Promise.resolve();
        },
    };
}

describe('printerConfigStore', () => {
    it('does not create a root object that conflicts with legacy printer ID casing', async () => {
        const adapter = makeAdapter();

        const printers = [{ id: 'INFO', host: 'legacy.local' }];
        expect(await loadPrinterConfigurations(adapter, printers)).to.deep.equal(printers);

        expect([...adapter.objects.keys()]).to.deep.equal([]);
        expect(adapter.files.get('null/printer-config.json')).to.equal(JSON.stringify(printers));

        const lowercase = parsePrinterConfig({ id: 'info', host: 'legacy.local' }, undefined, {
            allowLegacyInfoId: true,
        });
        const uppercase = parsePrinterConfig({ id: 'INFO', host: 'legacy.local' }, undefined, {
            allowLegacyInfoId: true,
        });
        expect(lowercase.errors).to.deep.equal([]);
        expect(uppercase.errors).to.deep.equal([]);
        expect(getPrinterIdKey(uppercase.config!.id)).to.equal(getPrinterIdKey(lowercase.config!.id));
    });

    it('migrates legacy file storage and preserves the printer root object', async () => {
        const adapter = makeAdapter();
        const legacyPrinters = [{ id: 'info', host: 'legacy.local' }];
        adapter.objects.set('info', { type: 'device', common: { name: 'Legacy printer' }, native: {} });
        adapter.objects.set('info.status', { type: 'channel', common: { name: 'Status' }, native: {} });
        adapter.objects.set('info.printerConfig', {
            type: 'meta',
            common: { name: 'Printer configuration storage', type: 'meta.user' },
            native: {},
        });
        adapter.files.set('ipp.0.info.printerConfig/printers.json', JSON.stringify(legacyPrinters));

        expect(await loadPrinterConfigurations(adapter, legacyPrinters)).to.deep.equal(legacyPrinters);
        expect(await loadPrinterConfigurations(adapter, [{ id: 'stale', host: 'stale.local' }])).to.deep.equal(
            legacyPrinters,
        );
        expect(adapter.files.get('null/printer-config.json')).to.equal(JSON.stringify(legacyPrinters));
        expect(adapter.files.has('ipp.0.info.printerConfig/printers.json')).to.equal(false);
        expect(adapter.objects.get('info')).to.deep.equal({
            type: 'device',
            common: { name: 'Legacy printer' },
            native: {},
        });
        expect(adapter.objects.has('info.status')).to.equal(true);
        expect(adapter.objects.has('info.printerConfig')).to.equal(false);
        expect(adapter.deletedObjects).to.deep.equal(['info.printerConfig']);
    });

    it('preserves the info root while migrating an INFO legacy printer', async () => {
        const adapter = makeAdapter();
        const printers = [{ id: 'INFO', host: 'legacy.local' }];
        adapter.objects.set('info', { type: 'device', common: { name: 'info' }, native: {} });
        adapter.objects.set('info.printerConfig', {
            type: 'meta',
            common: { name: 'Printer configuration storage', type: 'meta.user' },
            native: {},
        });
        adapter.files.set('ipp.0.info.printerConfig/printers.json', JSON.stringify(printers));

        expect(await loadPrinterConfigurations(adapter, [])).to.deep.equal(printers);

        expect(adapter.objects.has('info')).to.equal(true);
        expect(adapter.objects.has('info.printerConfig')).to.equal(false);
        expect(adapter.files.get('null/printer-config.json')).to.equal(JSON.stringify(printers));
        expect(adapter.deletedObjects).to.deep.equal(['info.printerConfig']);
    });

    it('persists an empty migration and ignores later stale native snapshots', async () => {
        const adapter = makeAdapter();

        expect(await loadPrinterConfigurations(adapter, [])).to.deep.equal([]);
        expect(await loadPrinterConfigurations(adapter, [{ id: 'stale', host: 'stale.local' }])).to.deep.equal([]);
    });

    it('persists changes independently of native configuration updates', async () => {
        const adapter = makeAdapter();
        await loadPrinterConfigurations(adapter, []);
        const printers = [{ id: 'office', host: 'printer.local' }];

        await savePrinterConfigurations(adapter, printers);

        expect(await loadPrinterConfigurations(adapter, [{ id: 'stale', host: 'stale.local' }])).to.deep.equal(
            printers,
        );
    });

    it('does not replace an unreadable stored configuration with legacy values', async () => {
        const adapter = makeAdapter();
        adapter.files.set('ipp.0.info.printerConfig/printers.json', '{invalid');
        adapter.objects.set('info.printerConfig', {
            type: 'meta',
            common: { name: 'Printer configuration storage', type: 'meta.user' },
            native: {},
        });

        let caught: unknown;
        try {
            await loadPrinterConfigurations(adapter, [{ id: 'legacy', host: 'legacy.local' }]);
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(SyntaxError);
    });

    it('does not read or remove a file belonging to an unrecognized legacy storage object', async () => {
        const adapter = makeAdapter();
        const nativePrinters = [{ id: 'native', host: 'native.local' }];
        const customFile = JSON.stringify([{ id: 'custom', host: 'custom.local' }]);
        adapter.objects.set('info.printerConfig', {
            type: 'meta',
            common: { name: 'User storage', type: 'meta.user' },
            native: {},
        });
        adapter.files.set('ipp.0.info.printerConfig/printers.json', customFile);

        expect(await loadPrinterConfigurations(adapter, nativePrinters)).to.deep.equal(nativePrinters);
        expect(adapter.objects.has('info.printerConfig')).to.equal(true);
        expect(adapter.files.get('ipp.0.info.printerConfig/printers.json')).to.equal(customFile);
        expect(adapter.deletedObjects).to.deep.equal([]);
    });
});
