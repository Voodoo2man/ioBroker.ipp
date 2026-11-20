import type { NetworkInterfaceInfo } from 'node:os';
import { expect } from 'chai';
import { parsePrinterConfig } from '../../src/lib/printerConfig';
import {
    createDeferredPrinterScanRefresh,
    createSerializedProgressUpdates,
    flushDeferredPrinterScanRefresh,
    getPrinterScanTargets,
    MAX_CONFIGURED_PRINTER_HOSTNAMES,
    MAX_HOSTNAME_RESOLUTION_CONCURRENCY,
    MAX_PRINTER_SCAN_CONCURRENCY,
    scanForPrinters,
} from '../../src/lib/printerDiscovery';

function interfaceAddress(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
    return {
        address,
        netmask,
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal,
        cidr: `${address}/24`,
    };
}

describe('printerDiscovery', () => {
    it('defers scan refresh until confirmed saves are complete and refreshes only once', async () => {
        const events: string[] = [];
        const deferredRefresh = createDeferredPrinterScanRefresh(() => {
            events.push('refresh');
            return Promise.resolve();
        });

        await deferredRefresh.save(() => {
            events.push('save:1');
            return Promise.resolve();
        });
        await deferredRefresh.save(() => {
            events.push('save:2');
            return Promise.resolve();
        });
        expect(events).to.deep.equal(['save:1', 'save:2']);

        await deferredRefresh.flush();
        await deferredRefresh.flush();

        expect(events).to.deep.equal(['save:1', 'save:2', 'refresh']);
    });

    it('does not schedule a refresh when a scan save fails', async () => {
        let refreshes = 0;
        const deferredRefresh = createDeferredPrinterScanRefresh(() => {
            refreshes++;
            return Promise.resolve();
        });

        try {
            await deferredRefresh.save(() => Promise.reject(new Error('save failed')));
        } catch {
            // The scan handles per-printer save errors and continues.
        }
        await deferredRefresh.flush();

        expect(refreshes).to.equal(0);
    });

    it('keeps the original error available when flushing a pending scan refresh fails', async () => {
        let refreshes = 0;
        const deferredRefresh = createDeferredPrinterScanRefresh(() => {
            refreshes++;
            return Promise.reject(new Error('poll failed'));
        });
        await deferredRefresh.save(() => Promise.resolve());

        const scanError = new Error('form failed');
        let reportedError: unknown;
        try {
            throw scanError;
        } catch (error) {
            const shouldReportScanError = await flushDeferredPrinterScanRefresh(
                deferredRefresh,
                new AbortController().signal,
            );
            expect(shouldReportScanError).to.equal(true);
            reportedError = error;
        }

        expect(reportedError).to.equal(scanError);
        expect(refreshes).to.equal(1);
    });

    it('does not flush saved scan changes after cancellation', async () => {
        let refreshes = 0;
        const deferredRefresh = createDeferredPrinterScanRefresh(() => {
            refreshes++;
            return Promise.resolve();
        });
        await deferredRefresh.save(() => Promise.resolve());
        const controller = new AbortController();
        controller.abort();

        const shouldReportScanError = await flushDeferredPrinterScanRefresh(deferredRefresh, controller.signal);

        expect(shouldReportScanError).to.equal(false);
        expect(refreshes).to.equal(0);
    });

    it('scans only directly connected private/link-local hosts and skips own/configured addresses', async () => {
        const targets = await getPrinterScanTargets(
            {
                lan: [interfaceAddress('192.168.1.2', '255.255.255.248')],
                linkLocal: [interfaceAddress('169.254.10.2', '255.255.255.252')],
                public: [interfaceAddress('8.8.8.10', '255.255.255.0')],
                loopback: [interfaceAddress('127.0.0.1', '255.0.0.0', true)],
            },
            {
                configuredHosts: ['192.168.1.4'],
            },
        );

        expect(targets.addresses).to.deep.equal([
            '169.254.10.1',
            '192.168.1.1',
            '192.168.1.3',
            '192.168.1.5',
            '192.168.1.6',
        ]);
        expect(targets.limited).to.equal(false);
    });

    it('samples large local networks evenly within the scan cap', async () => {
        const targets = await getPrinterScanTargets(
            {
                lan: [interfaceAddress('10.1.0.1', '255.0.0.0')],
                office: [interfaceAddress('192.168.1.2', '255.255.255.0')],
            },
            { maxAddresses: 8, configuredHosts: ['10.128.0.0'] },
        );

        expect(targets.addresses).to.have.length(8);
        expect(targets.addresses.filter(address => address.startsWith('10.'))).to.have.length(4);
        expect(targets.addresses.filter(address => address.startsWith('192.168.1.'))).to.have.length(4);
        expect(targets.addresses).not.to.include.members(['10.1.0.1', '10.128.0.0', '192.168.1.2']);
        expect(targets.eligibleAddressCount).to.be.greaterThan(8);
        expect(targets.limited).to.equal(true);
    });

    it('excludes IPv4 addresses returned for configured printer hostnames', async () => {
        const resolved: string[] = [];
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts: ['Printer.Example', 'printer.example', '192.168.1.5'],
                resolveHostname: hostname => {
                    resolved.push(hostname);
                    return Promise.resolve(['192.168.1.4', '10.0.0.10']);
                },
            },
        );

        expect(resolved).to.deep.equal(['printer.example']);
        expect(targets.addresses).to.deep.equal(['192.168.1.1', '192.168.1.3', '192.168.1.6']);
    });

    it('does not resolve bracketed IPv6 configured hosts as hostnames or suppress IPv4 targets', async () => {
        const resolved: string[] = [];
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts: ['[::1]'],
                resolveHostname: hostname => {
                    resolved.push(hostname);
                    return Promise.reject(new Error('ENOTFOUND'));
                },
            },
        );

        expect(resolved).to.deep.equal([]);
        expect(targets.addresses).to.have.length(5);
        expect(targets.configuredHostResolutionFailed).to.equal(undefined);
    });

    it('resolves configured hostnames with bounded concurrency', async () => {
        let active = 0;
        let maximumActive = 0;
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts: Array.from({ length: 12 }, (_, index) => `printer-${index}.example`),
                resolveHostname: async () => {
                    active++;
                    maximumActive = Math.max(maximumActive, active);
                    await new Promise(resolve => setTimeout(resolve, 2));
                    active--;
                    return [];
                },
            },
        );

        expect(maximumActive).to.equal(MAX_HOSTNAME_RESOLUTION_CONCURRENCY);
        expect(targets.addresses).to.have.length.greaterThan(0);
    });

    it('skips target selection when configured hostname resolution fails', async () => {
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts: ['printer.example'],
                resolveHostname: () => Promise.reject(new Error('DNS failure')),
            },
        );

        expect(targets.addresses).to.deep.equal([]);
        expect(targets.configuredHostResolutionFailed).to.equal(true);
    });

    it('times out hostname resolution and skips target selection', async () => {
        let resolverStarted = false;
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts: ['printer.example'],
                hostnameResolutionTimeoutMs: 5,
                resolveHostname: () => {
                    resolverStarted = true;
                    return new Promise(() => undefined);
                },
            },
        );

        expect(resolverStarted).to.equal(true);
        expect(targets.addresses).to.deep.equal([]);
        expect(targets.configuredHostResolutionFailed).to.equal(true);
    });

    it('does not resolve or scan when too many configured hostnames are present', async () => {
        let resolverCalls = 0;
        const configuredHosts = Array.from(
            { length: MAX_CONFIGURED_PRINTER_HOSTNAMES + 1 },
            (_, index) => `printer-${index}.example`,
        );
        const targets = await getPrinterScanTargets(
            { lan: [interfaceAddress('192.168.1.2', '255.255.255.248')] },
            {
                configuredHosts,
                resolveHostname: () => {
                    resolverCalls++;
                    return Promise.resolve([]);
                },
            },
        );

        expect(resolverCalls).to.equal(0);
        expect(targets.addresses).to.deep.equal([]);
        expect(targets.configuredHostResolutionLimited).to.equal(true);
    });

    it('waits for serialized final progress before closing an empty scan', async () => {
        const addresses = Array.from({ length: 8 }, (_, index) => `192.168.20.${index + 1}`);
        const events: string[] = [];
        const updated: number[] = [];
        let activeUpdates = 0;
        let maximumActiveUpdates = 0;
        const progressDialog = {
            update: async (completed: number, total: number) => {
                activeUpdates++;
                maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
                events.push(`update:${completed}/${total}:start`);
                await new Promise(resolve => setTimeout(resolve, 1));
                updated.push(completed);
                events.push(`update:${completed}/${total}:end`);
                activeUpdates--;
            },
            close: () => {
                events.push('close');
                return Promise.resolve();
            },
        };
        const context = {
            showMessage: () => {
                events.push('no-results message');
                return Promise.resolve();
            },
        };
        const progress = createSerializedProgressUpdates(progressDialog.update);

        const result = await scanForPrinters(
            { addresses, eligibleAddressCount: addresses.length, limited: false },
            () => Promise.reject(new Error('No IPP printer')),
            { concurrency: 4, onProgress: progress.report },
        );
        await progress.flush();
        await progressDialog.close();
        await context.showMessage();

        expect(result).to.deep.equal({ candidates: [], scanned: addresses.length });
        expect(maximumActiveUpdates).to.equal(1);
        expect(updated).to.have.length(addresses.length);
        expect(updated[updated.length - 1]).to.equal(addresses.length);
        expect(events[events.indexOf('close') - 1]).to.equal(`update:${addresses.length}/${addresses.length}:end`);
        expect(events.indexOf('close')).to.be.lessThan(events.indexOf('no-results message'));
    });

    it('drops queued progress updates after cancellation', async () => {
        const controller = new AbortController();
        const updates: number[] = [];
        let signalUpdateStarted!: () => void;
        let releaseUpdate!: () => void;
        const updateStarted = new Promise<void>(resolve => {
            signalUpdateStarted = resolve;
        });
        const updateGate = new Promise<void>(resolve => {
            releaseUpdate = resolve;
        });
        const progress = createSerializedProgressUpdates(async completed => {
            updates.push(completed);
            if (completed === 1) {
                signalUpdateStarted();
                await updateGate;
            }
        }, controller.signal);

        const first = progress.report(1, 2);
        await updateStarted;
        const second = progress.report(2, 2);
        controller.abort();
        releaseUpdate();
        await Promise.all([first, second]);

        expect(updates).to.deep.equal([1]);
    });

    it('verifies candidates with bounded concurrency, keeps progress, and avoids duplicate IDs', async () => {
        const addresses = Array.from({ length: 20 }, (_, index) => `192.168.10.${index + 1}`);
        let active = 0;
        let maximumActive = 0;
        const progress: Array<[number, number]> = [];
        const result = await scanForPrinters(
            { addresses, eligibleAddressCount: addresses.length, limited: false },
            async host => {
                active++;
                maximumActive = Math.max(maximumActive, active);
                await new Promise(resolve => setTimeout(resolve, 2));
                active--;
                if (host.endsWith('.2')) {
                    throw new Error('not an IPP printer');
                }
                return { model: host.endsWith('.3') ? 'Office printer' : null, printerName: `Device ${host}` };
            },
            {
                concurrency: MAX_PRINTER_SCAN_CONCURRENCY + 20,
                configuredIds: ['printer-192-168-10-3'],
                onProgress: (completed, total) => {
                    progress.push([completed, total]);
                },
            },
        );

        expect(maximumActive).to.be.within(2, MAX_PRINTER_SCAN_CONCURRENCY);
        expect(result.scanned).to.equal(addresses.length);
        expect(progress).to.have.length(addresses.length);
        expect(progress[progress.length - 1]).to.deep.equal([addresses.length, addresses.length]);
        expect(result.candidates.find(candidate => candidate.host.endsWith('.3'))).to.include({
            id: 'printer-192-168-10-3-2',
            label: 'Office printer',
            model: 'Office printer',
        });
        expect(result.candidates.some(candidate => candidate.host.endsWith('.2'))).to.equal(false);
        expect(new Set(result.candidates.map(candidate => candidate.id)).size).to.equal(result.candidates.length);
        for (const candidate of result.candidates) {
            expect(
                parsePrinterConfig({
                    ...candidate,
                    port: 631,
                    basePath: '/ipp/print',
                    ssl: false,
                    verifySsl: false,
                }).errors,
            ).to.deep.equal([]);
        }
    });

    it('stops starting probes after the scan is cancelled', async () => {
        const controller = new AbortController();
        const addresses = Array.from({ length: 8 }, (_, index) => `192.168.30.${index + 1}`);
        const probed: string[] = [];
        const progress: number[] = [];
        await scanForPrinters(
            { addresses, eligibleAddressCount: addresses.length, limited: false },
            host => {
                probed.push(host);
                controller.abort();
                return Promise.resolve({ model: null, printerName: host });
            },
            {
                concurrency: 1,
                signal: controller.signal,
                onProgress: completed => {
                    progress.push(completed);
                },
            },
        );

        expect(probed).to.deep.equal([addresses[0]]);
        expect(progress).to.deep.equal([]);
    });
});
