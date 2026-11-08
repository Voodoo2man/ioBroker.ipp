import { expect } from 'chai';
import {
    describePrinterConfig,
    getPrinterConfigErrors,
    getUniquePrinterConfigs,
    parsePrinterConfig,
} from '../../src/lib/printerConfig';

describe('printerConfig', () => {
    it('accepts the values shown in the reported Admin configuration', () => {
        const printer = {
            id: 'Buero',
            label: 'BüroDrucker',
            host: '192.168.0.89',
            port: 631,
            basePath: '/ipp/print',
            ssl: false,
            verifySsl: false,
        };

        expect(getPrinterConfigErrors(printer)).to.deep.equal([]);
        expect(describePrinterConfig(printer)).to.equal(
            'id=string, label=string, host=string, port=number, basePath=string, ssl=boolean, verifySsl=boolean',
        );
    });

    it('transliterates German umlauts in printer IDs', () => {
        const parsed = parsePrinterConfig({ id: 'Büro-Übersicht', host: 'printer.local' });

        expect(parsed.errors).to.deep.equal([]);
        expect(parsed.config?.id).to.equal('Buero-Uebersicht');

        const uppercase = parsePrinterConfig({ id: 'ÄÖÜ-ß', host: 'printer.local' });
        expect(uppercase.errors).to.deep.equal([]);
        expect(uppercase.config?.id).to.equal('AeOeUe-ss');
    });

    it('keeps only the first printer when configured IDs collide after normalization or case folding', () => {
        const printers = getUniquePrinterConfigs([
            { id: 'Buero', host: 'first.local' },
            { id: 'Büro', host: 'duplicate.local' },
            { id: 'Printer', host: 'uppercase.local' },
            { id: 'printer', host: 'lowercase.local' },
            { id: 'Other', host: 'other.local' },
        ]);

        expect(printers.map(printer => printer.id)).to.deep.equal(['Buero', 'Printer', 'Other']);
        expect(printers[0].host).to.equal('first.local');
        expect(printers[1].host).to.equal('uppercase.local');
    });

    it('rejects changing a printer ID while editing', () => {
        const parsed = parsePrinterConfig({ id: 'Other', host: 'printer.local' }, 'Original');

        expect(parsed.config).to.equal(undefined);
        expect(parsed.errors).to.deep.equal(['id cannot be changed after creation']);
        expect(parsePrinterConfig({ id: 'PRINTER', host: 'printer.local' }, 'Printer').config?.id).to.equal('Printer');
    });

    it('rejects the reserved info ID', () => {
        expect(parsePrinterConfig({ id: 'info', host: 'printer.local' }).errors).to.deep.equal([
            'id is reserved by the adapter',
        ]);
    });

    it('keeps existing printers with case-insensitive legacy info IDs loadable', () => {
        const config = { id: 'info', host: 'printer.local' };

        expect(parsePrinterConfig(config, undefined, { allowLegacyInfoId: true }).config?.id).to.equal('info');
        expect(getUniquePrinterConfigs([config], { allowLegacyInfoId: true }).map(printer => printer.id)).to.deep.equal(
            ['info'],
        );
        expect(parsePrinterConfig(config, 'info', { allowLegacyInfoId: true }).config?.id).to.equal('info');
        for (const id of ['INFO', 'Info']) {
            expect(parsePrinterConfig({ ...config, id }, undefined, { allowLegacyInfoId: true }).config?.id).to.equal(
                id,
            );
            expect(parsePrinterConfig({ ...config, id }).errors).to.deep.equal(['id is reserved by the adapter']);
        }
    });

    it('explains invalid fields without exposing configured values', () => {
        const printer = { id: 'bad.id', host: '', port: 'ipp', basePath: 'ipp/print', ssl: 'maybe' };

        expect(getPrinterConfigErrors(printer)).to.deep.equal([
            'id must contain 1-32 letters, digits, underscores, or hyphens',
            'host is missing or is not text',
            'port must be an integer from 1 to 65535',
            'basePath must be an absolute path without .., query, fragment, whitespace, or backslash',
            'ssl must be true/false, 1/0, or an unchecked checkbox',
        ]);
    });

    it('rejects hostnames and resource paths that runtime polling cannot use', () => {
        for (const host of [
            'printer/path',
            'printer?query',
            'printer name',
            'user@printer',
            'printer\\path',
            'printer:631',
        ]) {
            expect(getPrinterConfigErrors({ id: 'office', host })).to.include(
                'host must be a valid hostname or IP address',
            );
        }

        for (const basePath of ['/ipp/print?x', '/ipp/print#fragment', '/ipp print', '/ipp/../print']) {
            expect(getPrinterConfigErrors({ id: 'office', host: 'printer.local', basePath })).to.include(
                'basePath must be an absolute path without .., query, fragment, whitespace, or backslash',
            );
        }

        expect(getPrinterConfigErrors({ id: 'office', host: 'printer.local', basePath: '/ipp/print' })).to.deep.equal(
            [],
        );
        expect(getPrinterConfigErrors({ id: 'office', host: '[::1]' })).to.deep.equal([]);
    });

    it('normalizes Admin checkbox values from booleans, strings, and numeric flags', () => {
        const row = { id: 'Buero', host: '192.168.0.89', port: '631', ssl: 'false', verifySsl: 0 };
        const parsed = parsePrinterConfig(row);

        expect(parsed.errors).to.deep.equal([]);
        expect(parsed.config).to.include({ id: 'Buero', ssl: false, verifySsl: false });
        expect(parsePrinterConfig({ ...row, ssl: 'true', verifySsl: 1 }).config).to.include({
            ssl: true,
            verifySsl: true,
        });
    });

    it('defaults an empty or omitted port to the IPP default', () => {
        expect(parsePrinterConfig({ id: 'Buero', host: 'printer.local', port: '' }).config?.port).to.equal(631);
        expect(parsePrinterConfig({ id: 'Buero', host: 'printer.local' }).config?.port).to.equal(631);
    });
});
