import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { getIppBasePathValidatorExpression, getPrinterHostValidatorExpression } from '../../src/lib/printerEndpoint';

function evaluateValidator(expression: string, data: Record<string, unknown>): boolean {
    return runInNewContext(expression, { data, URL }) as boolean;
}

describe('printerEndpoint form validators', () => {
    it('uses expressions understood by the Admin JSON-form evaluator', () => {
        expect(getPrinterHostValidatorExpression()).not.to.include('return');
        expect(getIppBasePathValidatorExpression()).not.to.include('return');
    });

    it('accepts valid IPv4, hostname, IPv6, and IPP resource path values', () => {
        const hostValidator = getPrinterHostValidatorExpression();
        for (const host of ['192.168.0.89', 'printer.local', '[2001:db8::44]']) {
            expect(evaluateValidator(hostValidator, { host }), host).to.equal(true);
        }
        expect(evaluateValidator(getIppBasePathValidatorExpression(), { basePath: '/ipp/print' })).to.equal(true);
    });

    it('rejects schemes, paths, credentials, and invalid resource paths', () => {
        const hostValidator = getPrinterHostValidatorExpression();
        for (const host of ['http://printer.local', 'printer.local/ipp', 'user@printer.local', 'printer name']) {
            expect(evaluateValidator(hostValidator, { host }), host).to.equal(false);
        }
        const pathValidator = getIppBasePathValidatorExpression();
        for (const basePath of ['ipp/print', '/ipp/../admin', '/ipp/print?query', '/ipp/my printer']) {
            expect(evaluateValidator(pathValidator, { basePath }), basePath).to.equal(false);
        }
    });
});
