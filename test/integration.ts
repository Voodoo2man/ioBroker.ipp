import path from 'node:path';
import { expect } from 'chai';
import type { Context } from 'mocha';
import { tests } from '@iobroker/testing';

tests.integration(path.resolve(__dirname, '../..'), {
    controllerVersion: '7.2.2',
    defineAdditionalTests: ({ suite, it }) => {
        suite('Legacy printer configuration', getHarness => {
            it('migrates and polls a printer with the existing info ID', async function (this: Context) {
                this.timeout(30000);
                const harness = getHarness();
                const storageId = 'ipp.0.info.printerConfig';
                if (await harness.objects.fileExists(storageId, 'printers.json')) {
                    await harness.objects.unlinkAsync(storageId, 'printers.json');
                }
                await harness.objects.setObjectAsync('ipp.0.info', {
                    type: 'device',
                    common: { name: 'info' },
                    native: {},
                });
                await harness.objects.setObjectAsync(storageId, {
                    type: 'meta',
                    common: { name: 'Printer configuration storage', type: 'meta.user' },
                    native: {},
                });
                await new Promise<void>((resolve, reject) => {
                    harness.objects.writeFile(
                        storageId,
                        'printers.json',
                        JSON.stringify([
                            { id: 'info', label: 'Legacy printer', host: '127.0.0.1', port: 1 },
                            { id: 'Printer', host: '127.0.0.1', port: 1 },
                            { id: 'printer', host: '127.0.0.1', port: 1 },
                        ]),
                        (error: NodeJS.ErrnoException | null) => (error ? reject(error) : resolve()),
                    );
                });
                await harness.objects.setObjectAsync('ipp.0.printer', {
                    type: 'device',
                    common: { name: 'Stale duplicate printer' },
                    native: {},
                });
                await harness.objects.setObjectAsync('ipp.0.printer.status', {
                    type: 'channel',
                    common: { name: 'Stale duplicate status' },
                    native: {},
                });
                await harness.changeAdapterConfig('ipp', {
                    native: { printers: [] },
                });

                const printerOffline = new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Legacy printer was not polled')), 20000);
                    harness.on('stateChange', (id, state) => {
                        if (id === 'ipp.0.info.status.online' && state?.val === false) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    });
                });
                await harness.startAdapterAndWait();
                await printerOffline;
                expect(await harness.objects.getObject('ipp.0.printer')).to.not.exist;
                expect(await harness.objects.getObject('ipp.0.printer.status')).to.not.exist;
                expect((await harness.objects.getObject('ipp.0.info'))?.common.name).to.equal('Legacy printer');

                expect(await harness.objects.getObject(storageId)).to.not.exist;
                expect(await harness.objects.fileExists(storageId, 'printers.json')).to.equal(false);
                expect(await harness.objects.fileExists('ipp.0', 'printer-config.json')).to.equal(true);
                const storedConfig = await new Promise<string | Buffer>((resolve, reject) => {
                    harness.objects.readFile(
                        'ipp.0',
                        'printer-config.json',
                        (error: NodeJS.ErrnoException | null, data?: Buffer | string) => {
                            if (error) {
                                reject(error);
                            } else if (data === undefined) {
                                reject(new Error('Stored printer configuration was empty'));
                            } else {
                                resolve(data);
                            }
                        },
                    );
                });
                expect(JSON.parse(storedConfig.toString())).to.deep.equal([
                    { id: 'info', label: 'Legacy printer', host: '127.0.0.1', port: 1 },
                    { id: 'Printer', host: '127.0.0.1', port: 1 },
                ]);
            });
        });
    },
});
