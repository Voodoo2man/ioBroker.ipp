import { EventEmitter } from 'node:events';
import { expect } from 'chai';
import { parsePrinterConfig, type PrinterConfig } from '../../src/lib/printerConfig';
import {
    discoverPrinters,
    importDiscoveredPrinters,
    isPrinterAlreadyConfigured,
    type DiscoveredPrinter,
    type PrinterDiscoveryOptions,
} from '../../src/lib/printerDiscovery';

type TestInterfaces = Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;

const networkInterfaces = (): TestInterfaces => ({
    en0: [{ address: '192.0.2.10', family: 'IPv4', internal: false }],
});

const ippService = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'ipp',
    protocol: 'tcp',
    name: 'Office Printer',
    host: 'printer.local.',
    port: 8631,
    txt: { rp: 'printers/office', ty: 'Laser 9000', manufacturer: 'Acme' },
    addresses: ['192.0.2.44', '2001:db8::44'],
    ...overrides,
});

class FakeClient extends EventEmitter {
    public destroyed = false;

    public destroy(callback?: () => void): void {
        this.destroyed = true;
        callback?.();
    }
}

class FakeBrowser extends EventEmitter {
    public stopped = false;

    public constructor(services: unknown[]) {
        super();
        setImmediate(() => {
            for (const service of services) {
                this.emit('up', service);
            }
        });
    }

    public stop(): void {
        this.stopped = true;
    }
}

function scannerOptions(
    announcements: Partial<Record<'ipp' | 'ipps', unknown[]>>,
    overrides: Partial<PrinterDiscoveryOptions> = {},
): PrinterDiscoveryOptions & { clients: FakeClient[]; browsers: FakeBrowser[] } {
    const clients: FakeClient[] = [];
    const browsers: FakeBrowser[] = [];
    return {
        timeoutMs: 100,
        networkInterfaces,
        createClient: () => {
            const client = new FakeClient();
            clients.push(client);
            return client;
        },
        createBrowser: (_client, type) => {
            const browser = new FakeBrowser(announcements[type] ?? []);
            browsers.push(browser);
            return browser;
        },
        ...overrides,
        clients,
        browsers,
    };
}

function validPrinter(overrides: Partial<DiscoveredPrinter> = {}): DiscoveredPrinter {
    return {
        key: 'printer-1',
        name: 'Office Printer',
        host: 'printer.local',
        addresses: ['192.0.2.44'],
        port: 8631,
        basePath: '/printers/office',
        ssl: false,
        ...overrides,
    };
}

describe('printerDiscovery', () => {
    it('discovers an IPP printer and reads the SRV port and normalized TXT resource path', async () => {
        const options = scannerOptions({ ipp: [ippService()] });
        const result = await discoverPrinters(options);

        expect(result.warnings).to.deep.equal([]);
        expect(result.printers).to.have.length(1);
        expect(result.printers[0]).to.include({
            name: 'Office Printer',
            host: 'printer.local',
            port: 8631,
            basePath: '/printers/office',
            ssl: false,
            manufacturer: 'Acme',
            model: 'Laser 9000',
        });
        expect(result.printers[0].addresses).to.include('2001:db8::44');
    });

    it('recognizes IPPS and prefers it when the same printer also advertises IPP', async () => {
        const options = scannerOptions({
            ipp: [ippService({ txt: { rp: 'ipp/print', UUID: 'urn:uuid:12345678-1234-1234-1234-123456789abc' } })],
            ipps: [
                ippService({
                    type: 'ipps',
                    port: 443,
                    txt: { rp: '/secure/print', UUID: '12345678-1234-1234-1234-123456789abc' },
                }),
            ],
        });
        const result = await discoverPrinters(options);

        expect(result.printers).to.have.length(1);
        expect(result.printers[0]).to.include({ ssl: true, port: 443, basePath: '/secure/print' });
    });

    it('keeps two different printers independent', async () => {
        const options = scannerOptions({
            ipp: [
                ippService(),
                ippService({
                    name: 'Warehouse Printer',
                    host: 'warehouse.local',
                    port: 631,
                    addresses: ['192.0.2.45'],
                }),
            ],
        });
        const result = await discoverPrinters(options);

        expect(result.printers.map(printer => printer.name)).to.deep.equal(['Office Printer', 'Warehouse Printer']);
    });

    it('ignores malformed SRV and unrelated service records and leaves unknown paths empty', async () => {
        const options = scannerOptions({
            ipp: [
                ippService({ txt: { rp: '../secret', password: 'not-forwarded' } }),
                ippService({ port: 0 }),
                ippService({ host: 'http://example.invalid/ipp' }),
                ippService({ type: 'http' }),
                ippService({ protocol: 'udp' }),
                ippService({
                    name: 'Overlong Path Printer',
                    host: 'another-printer.local.',
                    txt: { rp: 'x'.repeat(513) },
                }),
            ],
        });
        const result = await discoverPrinters(options);

        expect(result.printers).to.have.length(2);
        expect(result.printers.every(printer => printer.basePath === '')).to.equal(true);
        expect(JSON.stringify(result.printers)).not.to.include('not-forwarded');
    });

    it('scans every available IPv4 interface and available IPv6 interfaces', async () => {
        const options = scannerOptions(
            {},
            {
                networkInterfaces: () => ({
                    en0: [
                        { address: '192.0.2.10', family: 'IPv4', internal: false },
                        { address: 'fe80::10', family: 'IPv6', internal: false },
                    ],
                    en1: [{ address: '198.51.100.10', family: 'IPv4', internal: false }],
                    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
                }),
            },
        );
        const createClient = options.createClient!;
        const clientOptions: Array<{ type: string; interface?: string }> = [];
        options.createClient = clientOption => {
            clientOptions.push(clientOption);
            return createClient(clientOption);
        };
        const result = await discoverPrinters(options);

        expect(result.printers).to.deep.equal([]);
        expect(clientOptions.filter(option => option.type === 'udp4').map(option => option.interface)).to.deep.equal([
            '192.0.2.10',
            '198.51.100.10',
        ]);
        expect(clientOptions.filter(option => option.type === 'udp6')).to.have.length(1);
        expect(options.clients).to.have.length(3);
        expect(options.browsers).to.have.length(6);
    });

    it('returns a valid empty result after a successful scan with no printer announcements', async () => {
        const result = await discoverPrinters(scannerOptions({}));

        expect(result).to.deep.equal({ printers: [], warnings: [] });
    });

    it('rejects when mDNS sockets fail instead of reporting no printers', async () => {
        const options = scannerOptions(
            {},
            {
                createClient: () => {
                    const client = new FakeClient();
                    setImmediate(() => client.emit('error', new Error('multicast unavailable')));
                    return client;
                },
            },
        );

        let failure: unknown;
        try {
            await discoverPrinters(options);
        } catch (error) {
            failure = error;
        }
        expect(failure).to.be.instanceOf(Error);
        expect((failure as Error).message).to.equal('All mDNS discovery sockets failed');
    });

    it('closes every browser and socket when a scan is aborted', async () => {
        const controller = new AbortController();
        const options = scannerOptions({ ipp: [ippService()] }, { signal: controller.signal });
        const scan = discoverPrinters(options);
        controller.abort();

        let failure: unknown;
        try {
            await scan;
        } catch (error) {
            failure = error;
        }
        expect((failure as Error).name).to.equal('AbortError');
        expect(options.clients.every(client => client.destroyed)).to.equal(true);
        expect(options.browsers.every(browser => browser.stopped)).to.equal(true);
    });

    it('does not wait beyond the bounded timeout and releases resources on timeout', async () => {
        const options = scannerOptions({}, { timeoutMs: 100 });
        const started = Date.now();
        const result = await discoverPrinters(options);

        expect(Date.now() - started).to.be.lessThan(1000);
        expect(result.printers).to.deep.equal([]);
        expect(options.clients.every(client => client.destroyed)).to.equal(true);
    });

    it('matches configured endpoints without duplicating an existing printer', () => {
        const configured = parsePrinterConfig({
            id: 'office',
            host: 'PRINTER.local',
            port: 8631,
            basePath: '/printers/office',
        }).config!;

        expect(isPrinterAlreadyConfigured(validPrinter(), [configured])).to.equal(true);
        expect(isPrinterAlreadyConfigured(validPrinter({ ssl: true }), [configured])).to.equal(false);
        expect(isPrinterAlreadyConfigured(validPrinter({ basePath: '' }), [configured])).to.equal(false);
    });

    it('does not save a selection cancelled by the user', async () => {
        const existing = parsePrinterConfig({ id: 'existing', host: 'existing.local' }).config!;
        const configured: PrinterConfig[] = [existing];
        let saveCalls = 0;
        const result = await importDiscoveredPrinters([validPrinter()], {
            getConfiguredPrinters: () => configured,
            configurePrinter: () => Promise.resolve(undefined),
            savePrinter: () => {
                saveCalls++;
                return Promise.resolve();
            },
        });

        expect(result).to.include({ added: 0, cancelled: true });
        expect(saveCalls).to.equal(0);
        expect(configured).to.deep.equal([existing]);
    });

    it('skips configured printers and creates only explicitly confirmed additions', async () => {
        const configuredPrinter = parsePrinterConfig({
            id: 'configured',
            host: 'printer.local',
            port: 8631,
            basePath: '/printers/office',
        }).config!;
        const configured: PrinterConfig[] = [configuredPrinter];
        let saved = 0;
        const result = await importDiscoveredPrinters([validPrinter()], {
            getConfiguredPrinters: () => configured,
            configurePrinter: () => Promise.reject(new Error('A duplicate endpoint must not open a form')),
            savePrinter: () => {
                saved++;
                return Promise.resolve();
            },
        });

        expect(result).to.include({ added: 0, skipped: 1 });
        expect(saved).to.equal(0);
    });

    it('does not mutate configured printers when saving a confirmed printer fails', async () => {
        const existing = parsePrinterConfig({ id: 'existing', host: 'existing.local' }).config!;
        const configured: PrinterConfig[] = [existing];
        const result = await importDiscoveredPrinters([validPrinter()], {
            getConfiguredPrinters: () => configured,
            configurePrinter: (_printer, proposed) => Promise.resolve(proposed),
            savePrinter: () => Promise.reject(new Error('storage unavailable')),
        });

        expect(result.error).to.be.instanceOf(Error);
        expect(configured).to.deep.equal([existing]);
        expect(result.added).to.equal(0);
    });

    it('saves multiple confirmed printers and finalizes the import once', async () => {
        const configured: PrinterConfig[] = [];
        const saved: unknown[] = [];
        let finishCalls = 0;
        const result = await importDiscoveredPrinters(
            [validPrinter(), validPrinter({ name: 'Warehouse', host: 'warehouse.local', port: 631 })],
            {
                getConfiguredPrinters: () => configured,
                configurePrinter: (_printer, proposed) => Promise.resolve(proposed),
                savePrinter: printer => {
                    saved.push(printer);
                    const parsed = parsePrinterConfig(printer);
                    if (parsed.config) {
                        configured.push(parsed.config);
                    }
                    return Promise.resolve();
                },
                finishImport: () => {
                    finishCalls++;
                    return Promise.resolve();
                },
            },
        );

        expect(result.added).to.equal(2);
        expect(saved).to.have.length(2);
        expect((saved[0] as PrinterConfig).verifySsl).to.equal(false);
        expect((saved[1] as PrinterConfig).host).to.equal('warehouse.local');
        expect(finishCalls).to.equal(1);
    });

    it('finalizes once after a later printer configuration is cancelled', async () => {
        const configured: PrinterConfig[] = [];
        let configureCalls = 0;
        let saved = 0;
        let finishCalls = 0;
        const result = await importDiscoveredPrinters(
            [validPrinter(), validPrinter({ name: 'Warehouse', host: 'warehouse.local' })],
            {
                getConfiguredPrinters: () => configured,
                configurePrinter: (_printer, proposed) => {
                    configureCalls++;
                    return Promise.resolve(configureCalls === 1 ? proposed : undefined);
                },
                savePrinter: printer => {
                    saved++;
                    const parsed = parsePrinterConfig(printer);
                    if (parsed.config) {
                        configured.push(parsed.config);
                    }
                    return Promise.resolve();
                },
                finishImport: () => {
                    finishCalls++;
                    return Promise.resolve();
                },
            },
        );

        expect(result).to.include({ added: 1, cancelled: true });
        expect(saved).to.equal(1);
        expect(finishCalls).to.equal(1);
    });

    it('finalizes once after a later printer save fails', async () => {
        const configured: PrinterConfig[] = [];
        let saveCalls = 0;
        let finishCalls = 0;
        const result = await importDiscoveredPrinters(
            [validPrinter(), validPrinter({ name: 'Warehouse', host: 'warehouse.local' })],
            {
                getConfiguredPrinters: () => configured,
                configurePrinter: (_printer, proposed) => Promise.resolve(proposed),
                savePrinter: printer => {
                    saveCalls++;
                    if (saveCalls === 2) {
                        return Promise.reject(new Error('storage unavailable'));
                    }
                    const parsed = parsePrinterConfig(printer);
                    if (parsed.config) {
                        configured.push(parsed.config);
                    }
                    return Promise.resolve();
                },
                finishImport: () => {
                    finishCalls++;
                    return Promise.resolve();
                },
            },
        );

        expect(result.added).to.equal(1);
        expect(result.error).to.be.instanceOf(Error);
        expect((result.error as Error).message).to.equal('storage unavailable');
        expect(finishCalls).to.equal(1);
    });
});
