import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { expect } from 'chai';
import * as ipp from '@sealsystems/ipp';
import { isPrinterUnavailableError, normalizeSnapshot, pollPrinter } from '../../src/lib/printerIpp';

const requestTimer = {
    setTimeout: (callback: () => void, timeout: number): ioBroker.Timeout | undefined =>
        setTimeout(callback, timeout) as unknown as ioBroker.Timeout,
    clearTimeout: (timer: ioBroker.Timeout | undefined): void => clearTimeout(timer as unknown as NodeJS.Timeout),
};

function pollPrinterWithNodeTimer(endpoint: Parameters<typeof pollPrinter>[0]): ReturnType<typeof pollPrinter> {
    return pollPrinter(endpoint, requestTimer);
}

function ippResponse(attributes: Record<string, unknown>): Buffer {
    return ipp.serialize({ version: '2.0', statusCode: 'successful-ok', id: 1, 'printer-attributes-tag': attributes });
}

async function expectRejection(
    promise: Promise<unknown>,
    expectedError: new (...args: never[]) => Error,
): Promise<void> {
    let error: unknown;
    try {
        await promise;
    } catch (caught) {
        error = caught;
    }
    expect(error).to.be.instanceOf(expectedError);
}

describe('printerIpp', () => {
    it('classifies normal network outages as printer unavailable', () => {
        const connectionRefused = new Error('Printer IPP request failed') as NodeJS.ErrnoException;
        connectionRefused.code = 'ECONNREFUSED';
        const dnsNotFound = new Error('Printer IPP request failed') as NodeJS.ErrnoException;
        dnsNotFound.code = 'ENOTFOUND';
        const temporaryDnsFailure = new Error('Printer IPP request failed') as NodeJS.ErrnoException;
        temporaryDnsFailure.code = 'EAI_AGAIN';
        const certificateError = new Error('certificate has expired') as NodeJS.ErrnoException;
        certificateError.code = 'CERT_HAS_EXPIRED';

        expect(isPrinterUnavailableError(connectionRefused)).to.equal(true);
        expect(isPrinterUnavailableError(dnsNotFound)).to.equal(true);
        expect(isPrinterUnavailableError(temporaryDnsFailure)).to.equal(true);
        expect(isPrinterUnavailableError(certificateError)).to.equal(false);
        expect(isPrinterUnavailableError(new Error('Printer returned an unsuccessful IPP response'))).to.equal(false);
    });

    it('normalizes printer state, percentage markers, and available counters', () => {
        const snapshot = normalizeSnapshot({
            statusCode: 'successful-ok',
            'printer-attributes-tag': {
                'printer-state': 'processing',
                'printer-state-message': 'Printing',
                'printer-make-and-model': 'HP LaserJet Pro MFP M479fdn',
                'marker-names': ['Black toner'],
                'marker-levels': [1],
                'marker-high-levels': [3],
                'marker-low-levels': [0],
                'marker-types': ['toner'],
                'pages-completed': 120,
                'impressions-completed': 125,
                'media-sheets-completed': 118,
                'printer-location': 'Office',
                'printer-is-accepting-jobs': true,
                'queued-job-count': 2,
                'document-format-supported': ['application/pdf', 'image/pwg-raster'],
            },
        });

        expect(snapshot).to.include({
            online: true,
            printerState: 4,
            status: 'Printing',
            model: 'HP LaserJet Pro MFP M479fdn',
        });
        expect(snapshot.supplies).to.deep.equal([
            { description: 'Black toner', level: 1, maxLevel: 100, unit: 14, markerType: 'toner', sourceIndex: 0 },
        ]);
        expect(snapshot.counters).to.deep.equal({
            pagesCompleted: 120,
            impressionsCompleted: 125,
            mediaSheetsCompleted: 118,
        });
        expect(snapshot.details).to.deep.include.members([
            { id: 'printer_location', name: 'Printer location', value: 'Office' },
            { id: 'printer_is_accepting_jobs', name: 'Accepting jobs', value: true },
            { id: 'queued_job_count', name: 'Queued jobs', value: 2 },
        ]);
        expect(snapshot.details.map(detail => detail.id)).not.to.include.members([
            'printer_state',
            'printer_state_message',
            'printer_make_and_model',
            'pages_completed',
            'impressions_completed',
            'media_sheets_completed',
        ]);
        expect(snapshot.details.some(detail => detail.id === 'document_format_supported')).to.equal(false);
    });

    it('publishes unknown returned attributes but omits excluded capabilities', () => {
        const snapshot = normalizeSnapshot({
            statusCode: 'successful-ok',
            'printer-attributes-tag': {
                'printer-state': 'idle',
                'printer-alert': ['toner-low', 'cover-open'],
                'color-supported': true,
                'marker-levels': [70, 45],
                'pages-per-minute': 25,
                'hp-default-duplex-standard': true,
                'manual-duplex-supported': true,
                'printer-get-attributes-supported': ['printer-name', 'printer-state'],
                'document-format-supported': ['application/pdf'],
                'finishings-supported': ['staple'],
                'custom-vendor-metric': { value: 7 },
            },
        });

        expect(snapshot.details).to.deep.include.members([
            { id: 'printer_alert', name: 'printer alert', value: '["toner-low","cover-open"]' },
            { id: 'pages_per_minute', name: 'Pages per minute', value: 25 },
            { id: 'color_supported', name: 'Color printing supported', value: true },
            { id: 'hp_default_duplex_standard', name: 'hp default duplex standard', value: true },
            { id: 'manual_duplex_supported', name: 'manual duplex supported', value: true },
            { id: 'custom_vendor_metric', name: 'custom vendor metric', value: '{"value":7}' },
        ]);
        expect(snapshot.details.some(detail => detail.id === 'marker_levels')).to.equal(false);
        expect(snapshot.details.some(detail => detail.id === 'printer_get_attributes_supported')).to.equal(false);
        expect(snapshot.details.some(detail => detail.id === 'document_format_supported')).to.equal(false);
        expect(snapshot.details.some(detail => detail.id === 'finishings_supported')).to.equal(false);
    });

    it('assigns distinct detail IDs when different attributes normalize to the same ID', () => {
        const snapshot = normalizeSnapshot({
            statusCode: 'successful-ok',
            'printer-attributes-tag': {
                vendor_a_2: 'existing suffix',
                vendor_a: 'underscored',
                'vendor-a': 'hyphenated',
            },
        });

        expect(snapshot.details).to.deep.equal([
            { id: 'vendor_a', name: 'vendor a', value: 'hyphenated' },
            { id: 'vendor_a_2', name: 'vendor_a', value: 'underscored' },
            { id: 'vendor_a_2_2', name: 'vendor_a_2', value: 'existing suffix' },
        ]);
        expect(new Set(snapshot.details.map(detail => detail.id)).size).to.equal(snapshot.details.length);
    });

    it('preserves zero values and represents unsupported values as null', () => {
        const snapshot = normalizeSnapshot({
            statusCode: 'successful-ok',
            'printer-attributes-tag': {
                'printer-state': 'idle',
                'marker-names': ['Black toner', 'Cyan toner'],
                'marker-levels': [0, 20],
                'marker-high-levels': [80, 100],
                'marker-low-levels': [20, 0],
                'pages-completed': 0,
            },
        });
        expect(snapshot.supplies[0].level).to.equal(0);
        expect(snapshot.counters).to.deep.equal({
            pagesCompleted: 0,
            impressionsCompleted: null,
            mediaSheetsCompleted: null,
        });
        expect(snapshot.status).to.equal(null);
    });

    it('preserves marker positions when preceding supply data is invalid', () => {
        const snapshot = normalizeSnapshot({
            statusCode: 'successful-ok',
            'printer-attributes-tag': {
                'marker-names': ['Invalid', 'Cyan toner'],
                'marker-levels': [null, 45],
                'marker-low-levels': [0, 20],
                'marker-high-levels': [100, 80],
            },
        });

        expect(snapshot.supplies).to.deep.equal([
            { description: 'Cyan toner', level: 45, maxLevel: 100, unit: 14, markerType: null, sourceIndex: 1 },
        ]);
    });

    it('sends a read-only Get-Printer-Attributes request to the configured resource', async () => {
        let resolveRequest!: (value: ipp.IppResponse) => void;
        const requestReceived = new Promise<ipp.IppResponse>(resolve => {
            resolveRequest = resolve;
        });
        let deadlineScheduled = false;
        let deadlineCleared = false;
        const trackedTimer = {
            setTimeout: (callback: () => void, timeout: number) => {
                deadlineScheduled = true;
                return requestTimer.setTimeout(callback, timeout);
            },
            clearTimeout: (timer: ioBroker.Timeout | undefined) => {
                deadlineCleared = true;
                requestTimer.clearTimeout(timer);
            },
        };
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                resolveRequest(ipp.parse(Buffer.concat(chunks)));
                response.writeHead(200, { 'content-type': 'application/ipp' });
                response.end(
                    ippResponse({
                        'printer-state': 'idle',
                        'printer-state-message': 'Idle',
                        'pages-completed': 52,
                        'impressions-completed': 60,
                        'media-sheets-completed': 49,
                        'printer-location': 'Office',
                    }),
                );
            });
        });
        await new Promise<void>(resolve => server.listen(0, resolve));

        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            const result = await pollPrinter(
                {
                    host: '127.0.0.1',
                    port: address.port,
                    basePath: '/ipp/print',
                    timeoutMs: 2000,
                },
                trackedTimer,
            );
            const receivedRequest = await requestReceived;
            expect(deadlineScheduled).to.equal(true);
            expect(deadlineCleared).to.equal(true);
            expect(receivedRequest.operation).to.equal('Get-Printer-Attributes');
            expect(
                (receivedRequest['operation-attributes-tag'] as Record<string, unknown>)['requested-attributes'],
            ).to.equal('all');
            expect((receivedRequest['operation-attributes-tag'] as Record<string, unknown>)['printer-uri']).to.equal(
                `ipp://127.0.0.1:${address.port}/ipp/print`,
            );
            expect(result).to.include({ online: true, printerState: 3, status: 'Idle' });
            expect(result.counters).to.deep.equal({
                pagesCompleted: 52,
                impressionsCompleted: 60,
                mediaSheetsCompleted: 49,
            });
            expect(result.details).to.deep.include.members([
                { id: 'printer_location', name: 'Printer location', value: 'Office' },
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('rejects an unsuccessful IPP response and invalid endpoint configuration', async () => {
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'content-type': 'application/ipp' });
                response.end(ipp.serialize({ version: '2.0', statusCode: 'client-error-not-found', id: 1 }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            await expectRejection(
                pollPrinterWithNodeTimer({ host: '127.0.0.1', port: address.port, timeoutMs: 2000 }),
                Error,
            );
            await expectRejection(pollPrinterWithNodeTimer({ host: 'printer/path', port: address.port }), TypeError);
            await expectRejection(
                pollPrinterWithNodeTimer({ host: '127.0.0.1', port: address.port, basePath: '/ipp/print?x' }),
                TypeError,
            );
            await expectRejection(
                pollPrinterWithNodeTimer({ host: '127.0.0.1', port: address.port, basePath: '/ipp print' }),
                TypeError,
            );
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('isolates malformed parser input so a negative attribute length cannot block the adapter', () => {
        const parserInput = [2, 0, 0, 0, 0, 0, 0, 1, 4, 0x41, 0xff, 0xff, 0, 0, 0, 0, 3];
        const script = `const ipp = require('@sealsystems/ipp'); ipp.parse(Buffer.from(${JSON.stringify(parserInput)}));`;
        const result = spawnSync(process.execPath, ['-e', script], { timeout: 1000 });

        expect(result.error).to.have.property('code', 'ETIMEDOUT');
        expect(result.signal).to.equal('SIGTERM');
    });

    it('rejects a malformed response without blocking the main process', async () => {
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'content-type': 'application/ipp' });
                response.end(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 4, 0x41, 0xff, 0xff, 0, 0, 0, 0, 3]));
            });
        });
        await new Promise<void>(resolve => server.listen(0, resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            await expectRejection(
                pollPrinterWithNodeTimer({ host: '127.0.0.1', port: address.port, timeoutMs: 500 }),
                Error,
            );
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('applies a hard request deadline when response data keeps arriving', async () => {
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'content-type': 'application/ipp' });
                const interval = setInterval(() => response.write(Buffer.from([0])), 75);
                response.on('close', () => clearInterval(interval));
            });
        });
        await new Promise<void>(resolve => server.listen(0, resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            const started = Date.now();
            await expectRejection(
                pollPrinterWithNodeTimer({ host: '127.0.0.1', port: address.port, timeoutMs: 500 }),
                Error,
            );
            expect(Date.now() - started).to.be.lessThan(900);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('aborts an in-flight request when its signal is cancelled', async () => {
        let resolveRequestStarted!: () => void;
        const requestStarted = new Promise<void>(resolve => {
            resolveRequestStarted = resolve;
        });
        let resolveResponseClosed!: () => void;
        const responseClosed = new Promise<void>(resolve => {
            resolveResponseClosed = resolve;
        });
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                resolveRequestStarted();
                response.writeHead(200, { 'content-type': 'application/ipp' });
                response.flushHeaders();
                response.once('close', resolveResponseClosed);
            });
        });
        await new Promise<void>(resolve => server.listen(0, resolve));
        const controller = new AbortController();
        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            const poll = pollPrinterWithNodeTimer({
                host: '127.0.0.1',
                port: address.port,
                timeoutMs: 2000,
                signal: controller.signal,
            });
            await requestStarted;
            controller.abort();
            await expectRejection(poll, Error);
            await responseClosed;
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });
});
