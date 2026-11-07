import { expect } from 'chai';
import { loadPrinterConfigurations, savePrinterConfigurations } from './printerConfigStore';

function makeAdapter(): {
    namespace: string;
    objects: Map<string, unknown>;
    files: Map<string, string>;
    setObjectNotExistsAsync: (id: string, object: unknown) => Promise<void>;
    fileExistsAsync: (adapter: string | null, path: string) => Promise<boolean>;
    readFileAsync: (adapter: string | null, path: string) => Promise<{ file: string }>;
    writeFileAsync: (adapter: string | null, path: string, data: string) => Promise<void>;
} {
    const objects = new Map<string, unknown>();
    const files = new Map<string, string>();
    const fileId = (adapter: string | null, path: string): string => `${adapter}/${path}`;
    return {
        namespace: 'ipp.0',
        objects,
        files,
        setObjectNotExistsAsync: (id, object) => {
            if (!objects.has(id)) {
                objects.set(id, object);
            }
            return Promise.resolve();
        },
        fileExistsAsync: (adapter, path) => Promise.resolve(files.has(fileId(adapter, path))),
        readFileAsync: (adapter, path) => Promise.resolve({ file: files.get(fileId(adapter, path))! }),
        writeFileAsync: (adapter, path, data) => {
            files.set(fileId(adapter, path), data);
            return Promise.resolve();
        },
    };
}

describe('printerConfigStore', () => {
    it('migrates native.printers once and ignores later stale native snapshots', async () => {
        const adapter = makeAdapter();
        const legacyPrinters = [{ id: 'info', host: 'legacy.local' }];

        expect(await loadPrinterConfigurations(adapter, legacyPrinters)).to.deep.equal(legacyPrinters);
        expect(await loadPrinterConfigurations(adapter, [{ id: 'stale', host: 'stale.local' }])).to.deep.equal(
            legacyPrinters,
        );
        expect([...adapter.objects.values()]).to.deep.equal([
            { type: 'meta', common: { name: 'Printer configuration storage', type: 'meta.user' }, native: {} },
        ]);
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

        let caught: unknown;
        try {
            await loadPrinterConfigurations(adapter, [{ id: 'legacy', host: 'legacy.local' }]);
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(SyntaxError);
    });
});
