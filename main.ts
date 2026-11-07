import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import {
    DeviceManagement,
    type ActionContext,
    type DeviceDetails,
    type DeviceLoadContext,
    type InstanceDetails,
    type JsonFormSchema,
} from '@iobroker/dm-utils';
import {
    describePrinterConfig,
    getUniquePrinterConfigs,
    parsePrinterConfig,
    type PrinterConfig,
} from './lib/printerConfig';
import { loadPrinterConfigurations, savePrinterConfigurations } from './lib/printerConfigStore';
import { SerialQueue } from './lib/serialQueue';
import { isPrinterUnavailableError, pollPrinter } from './lib/printerIpp';
import { markOffline, publishSnapshot } from './lib/printerState';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 86400;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30000;
const printerIcon =
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22%3E%3Cpath fill=%22%23ffffff%22 d=%22M14 4h20v10H14zM10 14h28a4 4 0 0 1 4 4v14h-8v12H14V32H6V18a4 4 0 0 1 4-4m8 20v6h12v-6zm16-14a2 2 0 1 0 0 4 2 2 0 0 0 0-4%22/%3E%3C/svg%3E';

function getPrinterFormSchema(idReadOnly = false): JsonFormSchema {
    const reservedIdValidator = idReadOnly ? 'true' : "data.id.toLowerCase() !== 'info'";
    return {
        type: 'panel',
        items: {
            id: {
                type: 'text',
                label: 'ID',
                readOnly: idReadOnly,
                validator: `!!data.id && ${reservedIdValidator} && /^[A-Za-z0-9_-]{1,32}$/.test(data.id.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'))`,
            },
            label: { type: 'text', label: 'Label' },
            host: { type: 'text', label: 'Host', validator: '!!data.host' },
            port: { type: 'number', label: 'Port', min: 1, max: 65535, default: 631 },
            basePath: { type: 'text', label: 'IPP resource path', default: '/ipp/print' },
            ssl: { type: 'checkbox', label: 'Use TLS' },
            verifySsl: { type: 'checkbox', label: 'Verify TLS certificate', default: false },
        },
    };
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

class Ipp extends Adapter {
    private readonly deviceManagement: IppDeviceManagement;
    private pollTimer: ioBroker.Interval | null = null;
    private activePoll: Promise<void> | null = null;
    private unloading = false;
    private printers: PrinterConfig[] = [];
    private configuredPrinterSettings: unknown[] = [];
    private readonly configUpdates = new SerialQueue();
    private readonly activeRequests = new Set<AbortController>();
    private readonly configReady: Promise<void>;
    private resolveConfigReady!: () => void;
    private rejectConfigReady!: (error: unknown) => void;
    private configRevision = 0;
    private timeoutMs = DEFAULT_TIMEOUT_MS;

    constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'ipp' });
        this.configReady = new Promise<void>((resolve, reject) => {
            this.resolveConfigReady = resolve;
            this.rejectConfigReady = reject;
        });
        void this.configReady.catch(() => undefined);
        this.deviceManagement = new IppDeviceManagement(this);
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            const configuredPrinters: unknown = this.config.printers;
            if (!Array.isArray(configuredPrinters)) {
                this.log.warn(`Printer configuration must be a table/array; received ${typeof configuredPrinters}`);
            }
            this.configuredPrinterSettings = await loadPrinterConfigurations(
                this,
                Array.isArray(configuredPrinters) ? configuredPrinters : [],
            );
            const printerIds = new Set<string>();
            this.printers = this.configuredPrinterSettings.flatMap((printer, index) => {
                const parsed = parsePrinterConfig(printer, undefined, { allowLegacyInfoId: true });
                if (parsed.config && printerIds.has(parsed.config.id)) {
                    parsed.errors.push('id duplicates another configured printer');
                    delete parsed.config;
                }
                if (!parsed.config) {
                    this.log.warn(`Ignoring printer row ${index + 1}: ${parsed.errors.join('; ')}`);
                    this.log.debug(`Printer row ${index + 1} fields: ${describePrinterConfig(printer)}`);
                    return [];
                }
                printerIds.add(parsed.config.id);
                this.log.debug(`Accepted printer row ${index + 1}: ${describePrinterConfig(printer)}`);
                return [parsed.config];
            });

            if (this.printers.length === 0) {
                this.log.info('No valid printers configured');
            }
            for (const printer of this.printers) {
                await this.createPrinterObjects(printer);
            }
            this.resolveConfigReady();

            const intervalSeconds = boundedNumber(
                this.config.intervalSeconds,
                DEFAULT_INTERVAL_SECONDS,
                MIN_INTERVAL_SECONDS,
                MAX_INTERVAL_SECONDS,
            );
            this.timeoutMs = boundedNumber(this.config.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
            await this.pollPrinters();
            if (!this.unloading) {
                const timer = this.setInterval(() => void this.pollPrinters(), intervalSeconds * 1000);
                if (timer) {
                    this.pollTimer = timer;
                }
            }
        } catch (error) {
            this.rejectConfigReady(error);
            throw error;
        }
    }

    private async createPrinterObjects(printer: PrinterConfig): Promise<void> {
        const channelId = `${printer.id}.status`;
        for (const legacyChannel of ['info', 'status', 'supplies', 'counters']) {
            const legacyId = `${printer.id}.details.${legacyChannel}`;
            const legacyObject = await this.getObjectAsync(legacyId);
            if (legacyObject?.type === 'channel') {
                await this.delObjectAsync(legacyId, { recursive: true });
            }
        }
        await this.setObjectNotExistsAsync(printer.id, {
            type: 'device',
            common: { name: printer.label || printer.id },
            native: {},
        });
        for (const [id, name] of [
            [channelId, 'Status'],
            [`${printer.id}.supplies`, 'Supplies'],
            [`${printer.id}.counters`, 'Counters'],
            [`${printer.id}.details`, 'Printer details'],
        ]) {
            await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
        }
        await this.setObjectNotExistsAsync(`${channelId}.online`, {
            type: 'state',
            common: { name: 'Online', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
    }

    public getConfiguredPrinters(): PrinterConfig[] {
        return getUniquePrinterConfigs(this.configuredPrinterSettings, { allowLegacyInfoId: true });
    }

    public waitForConfig(): Promise<void> {
        return this.configReady;
    }

    public async savePrinter(printer: unknown, previousId?: string): Promise<void> {
        return this.configUpdates.run(async () => {
            await this.configReady;
            const parsed = parsePrinterConfig(printer, previousId, {
                allowLegacyInfoId: previousId?.toLowerCase() === 'info',
            });
            if (!parsed.config) {
                throw new Error(parsed.errors.join('; '));
            }
            const printers = this.configuredPrinterSettings.filter(config => {
                const configured = parsePrinterConfig(config, undefined, { allowLegacyInfoId: true }).config;
                return !configured || configured.id !== previousId;
            });
            if (
                this.getConfiguredPrinters().some(config => config.id !== previousId && config.id === parsed.config!.id)
            ) {
                throw new Error('A printer with this ID is already configured');
            }
            printers.push(parsed.config);
            await this.savePrinterList(printers);
        });
    }

    public async removePrinter(id: string): Promise<void> {
        return this.configUpdates.run(async () => {
            await this.configReady;
            await this.savePrinterList(
                this.configuredPrinterSettings.filter(
                    config => parsePrinterConfig(config, undefined, { allowLegacyInfoId: true }).config?.id !== id,
                ),
            );
        });
    }

    public getPrinter(id: string): PrinterConfig | undefined {
        return this.getConfiguredPrinters().find(printer => printer.id === id);
    }

    private async savePrinterList(printers: unknown[]): Promise<void> {
        const previousIds = new Set(this.printers.map(printer => printer.id));
        this.configRevision++;
        for (const controller of this.activeRequests) {
            controller.abort();
        }
        await this.activePoll;
        try {
            await savePrinterConfigurations(this, printers);
        } catch (error) {
            this.configRevision++;
            throw error;
        }
        this.configuredPrinterSettings = printers;
        this.printers = getUniquePrinterConfigs(printers, { allowLegacyInfoId: true });
        const currentIds = new Set(this.printers.map(printer => printer.id));
        for (const id of previousIds) {
            if (!currentIds.has(id)) {
                if (id === 'info') {
                    for (const channel of ['status', 'supplies', 'counters', 'details']) {
                        await this.delObjectAsync(`info.${channel}`, { recursive: true });
                    }
                } else {
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }
        for (const printer of this.printers) {
            await this.createPrinterObjects(printer);
        }
        await this.pollPrinters();
    }

    private pollPrinters(): Promise<void> {
        if (this.unloading) {
            return Promise.resolve();
        }
        if (this.activePoll) {
            return this.activePoll;
        }
        const poll = this.runPrinterPolls(this.configRevision);
        this.activePoll = poll.finally(() => {
            this.activePoll = null;
        });
        return this.activePoll;
    }

    private async runPrinterPolls(revision: number): Promise<void> {
        for (const printer of this.printers) {
            if (this.unloading || revision !== this.configRevision) {
                break;
            }
            await this.pollOnePrinter(printer, revision);
        }
    }

    private async pollOnePrinter(printer: PrinterConfig, revision: number): Promise<void> {
        const controller = new AbortController();
        this.activeRequests.add(controller);
        try {
            const result = await pollPrinter({
                host: printer.host.trim(),
                port: boundedNumber(printer.port, 631, 1, 65535),
                basePath: printer.basePath || '/ipp/print',
                ssl: printer.ssl === true,
                verifySsl: printer.verifySsl === true,
                timeoutMs: this.timeoutMs,
                signal: controller.signal,
            });
            if (this.isCurrentPoll(printer, revision)) {
                await publishSnapshot(this, printer, result);
            }
        } catch (error) {
            if (this.isCurrentPoll(printer, revision)) {
                try {
                    await markOffline(this, printer);
                } catch {
                    this.log.warn(`Could not update availability for configured printer ${printer.id}`);
                }
                const message = error instanceof Error ? error.message : String(error);
                const logMessage = `Polling configured printer ${printer.id} failed: ${message}`;
                if (isPrinterUnavailableError(error)) {
                    this.log.debug(logMessage);
                } else {
                    this.log.warn(logMessage);
                }
            }
        } finally {
            this.activeRequests.delete(controller);
        }
    }

    private isCurrentPoll(printer: PrinterConfig, revision: number): boolean {
        return (
            !this.unloading && revision === this.configRevision && this.printers.some(item => item.id === printer.id)
        );
    }

    private onUnload(callback: () => void): void {
        this.unloading = true;
        for (const controller of this.activeRequests) {
            controller.abort();
        }
        if (this.pollTimer) {
            try {
                this.clearInterval(this.pollTimer);
            } catch {
                this.log.warn('Failed to clear printer polling timer during unload');
            } finally {
                this.pollTimer = null;
            }
        }
        callback();
    }
}

class IppDeviceManagement extends DeviceManagement<Ipp, string> {
    protected override getInstanceInfo(): InstanceDetails {
        return {
            apiVersion: 'v3',
            actions: [
                {
                    id: 'addPrinter',
                    icon: 'add',
                    title: { en: 'Add printer', de: 'Drucker hinzufügen' },
                    handler: async (context: ActionContext) => {
                        const data = await context.showForm(getPrinterFormSchema(), {
                            title: { en: 'Add printer', de: 'Drucker hinzufügen' },
                        });
                        if (!data) {
                            return { refresh: false };
                        }
                        try {
                            await this.adapter.savePrinter(data);
                            return { refresh: true };
                        } catch (error) {
                            await this.showActionError(
                                context,
                                'Could not add the printer',
                                'Drucker konnte nicht hinzugefügt werden',
                                error,
                            );
                            return { refresh: false };
                        }
                    },
                },
            ],
        };
    }

    protected override async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
        await this.adapter.waitForConfig();
        const printers = this.adapter.getConfiguredPrinters();
        context.setTotalDevices(printers.length);
        for (const printer of printers) {
            context.addDevice({
                id: printer.id,
                identifier: printer.host,
                name: printer.label || printer.id,
                icon: printerIcon,
                model: { stateId: `${this.adapter.namespace}.${printer.id}.status.model` },
                connectionType: 'lan',
                status: {
                    connection: {
                        stateId: `${this.adapter.namespace}.${printer.id}.status.online`,
                        mapping: { true: 'connected', false: 'disconnected' },
                    },
                },
                hasDetails: true,
                actions: [
                    {
                        id: 'edit',
                        icon: 'edit',
                        description: { en: 'Edit printer configuration', de: 'Druckerkonfiguration bearbeiten' },
                        handler: async (deviceId, actionContext) => this.editPrinter(deviceId, actionContext),
                    },
                    {
                        id: 'delete',
                        icon: 'delete',
                        description: { en: 'Remove printer', de: 'Drucker entfernen' },
                        confirmation: { en: 'Remove this printer?', de: 'Diesen Drucker entfernen?' },
                        handler: async (deviceId, actionContext) => {
                            if (
                                await actionContext.showConfirmation({
                                    en: 'Remove this printer?',
                                    de: 'Diesen Drucker entfernen?',
                                })
                            ) {
                                try {
                                    await this.adapter.removePrinter(deviceId);
                                    return { refresh: 'devices' };
                                } catch (error) {
                                    await this.showActionError(
                                        actionContext,
                                        'Could not remove the printer',
                                        'Drucker konnte nicht entfernt werden',
                                        error,
                                    );
                                    return { refresh: 'none' };
                                }
                            }
                            return { refresh: 'none' };
                        },
                    },
                ],
            });
        }
    }

    protected override getDeviceDetails(id: string): DeviceDetails<string> | null {
        const printer = this.adapter.getPrinter(id);
        if (!printer) {
            return null;
        }
        const detailsSchema: JsonFormSchema = {
            type: 'panel',
            items: {
                host: { type: 'text', label: 'Host', readOnly: true },
                port: { type: 'number', label: 'Port', readOnly: true },
                basePath: { type: 'text', label: 'IPP resource path', readOnly: true },
                ssl: { type: 'checkbox', label: 'Use TLS', readOnly: true },
                model: { type: 'state', label: 'Model', oid: `${id}.status.model` },
                online: { type: 'state', label: 'Online', oid: `${id}.status.online` },
            },
        };
        return { id, schema: detailsSchema, data: printer };
    }

    private async editPrinter(id: string, context: ActionContext): Promise<{ refresh: 'devices' | 'none' }> {
        const printer = this.adapter.getPrinter(id);
        if (!printer) {
            return { refresh: 'none' };
        }
        const data = await context.showForm(getPrinterFormSchema(true), {
            data: printer,
            title: { en: 'Edit printer', de: 'Drucker bearbeiten' },
        });
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.adapter.savePrinter(data, id);
            return { refresh: 'devices' };
        } catch (error) {
            await this.showActionError(
                context,
                'Could not save the printer',
                'Drucker konnte nicht gespeichert werden',
                error,
            );
            return { refresh: 'none' };
        }
    }

    private async showActionError(context: ActionContext, en: string, de: string, error: unknown): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error);
        await context.showMessage({ en: `${en}: ${detail}`, de: `${de}: ${detail}` });
    }
}

if (require.main === module) {
    new Ipp();
} else {
    module.exports = (options?: Partial<AdapterOptions>): Ipp => new Ipp(options);
}
