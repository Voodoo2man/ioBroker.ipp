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
    getPrinterIdKey,
    getUniquePrinterConfigs,
    parsePrinterConfig,
    type PrinterConfig,
} from './lib/printerConfig';
import { loadPrinterConfigurations, savePrinterConfigurations } from './lib/printerConfigStore';
import { isValidIppBasePath, isValidPrinterHost } from './lib/printerEndpoint';
import { SerialQueue } from './lib/serialQueue';
import { isPrinterUnavailableError, pollPrinter } from './lib/printerIpp';
import { markOffline, publishSnapshot } from './lib/printerState';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 86400;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30000;
type CompleteTranslations = {
    en: string;
    de: string;
    ru: string;
    pt: string;
    nl: string;
    fr: string;
    it: string;
    es: string;
    pl: string;
    uk: string;
    'zh-cn': string;
};

const translations = {
    addPrinter: {
        en: 'Add printer',
        de: 'Drucker hinzufügen',
        ru: 'Добавить принтер',
        pt: 'Adicionar impressora',
        nl: 'Printer toevoegen',
        fr: 'Ajouter une imprimante',
        it: 'Aggiungi stampante',
        es: 'Añadir impresora',
        pl: 'Dodaj drukarkę',
        uk: 'Додати принтер',
        'zh-cn': '添加打印机',
    },
    editPrinter: {
        en: 'Edit printer',
        de: 'Drucker bearbeiten',
        ru: 'Изменить принтер',
        pt: 'Editar impressora',
        nl: 'Printer bewerken',
        fr: "Modifier l'imprimante",
        it: 'Modifica stampante',
        es: 'Editar impresora',
        pl: 'Edytuj drukarkę',
        uk: 'Редагувати принтер',
        'zh-cn': '编辑打印机',
    },
    editPrinterConfiguration: {
        en: 'Edit printer configuration',
        de: 'Druckerkonfiguration bearbeiten',
        ru: 'Изменить настройки принтера',
        pt: 'Editar configuração da impressora',
        nl: 'Printerconfiguratie bewerken',
        fr: "Modifier la configuration de l'imprimante",
        it: 'Modifica configurazione stampante',
        es: 'Editar configuración de la impresora',
        pl: 'Edytuj konfigurację drukarki',
        uk: 'Редагувати конфігурацію принтера',
        'zh-cn': '编辑打印机配置',
    },
    removePrinter: {
        en: 'Remove printer',
        de: 'Drucker entfernen',
        ru: 'Удалить принтер',
        pt: 'Remover impressora',
        nl: 'Printer verwijderen',
        fr: "Supprimer l'imprimante",
        it: 'Rimuovi stampante',
        es: 'Eliminar impresora',
        pl: 'Usuń drukarkę',
        uk: 'Видалити принтер',
        'zh-cn': '移除打印机',
    },
    removePrinterConfirmation: {
        en: 'Remove this printer?',
        de: 'Diesen Drucker entfernen?',
        ru: 'Удалить этот принтер?',
        pt: 'Remover esta impressora?',
        nl: 'Deze printer verwijderen?',
        fr: 'Supprimer cette imprimante ?',
        it: 'Rimuovere questa stampante?',
        es: '¿Eliminar esta impresora?',
        pl: 'Usunąć tę drukarkę?',
        uk: 'Видалити цей принтер?',
        'zh-cn': '要移除此打印机吗？',
    },
    id: {
        en: 'ID',
        de: 'ID',
        ru: 'Идентификатор',
        pt: 'ID',
        nl: 'ID',
        fr: 'ID',
        it: 'ID',
        es: 'ID',
        pl: 'ID',
        uk: 'Ідентифікатор',
        'zh-cn': '标识符',
    },
    label: {
        en: 'Label',
        de: 'Bezeichnung',
        ru: 'Название',
        pt: 'Nome',
        nl: 'Label',
        fr: 'Libellé',
        it: 'Etichetta',
        es: 'Etiqueta',
        pl: 'Etykieta',
        uk: 'Назва',
        'zh-cn': '标签',
    },
    host: {
        en: 'Host',
        de: 'Host',
        ru: 'Узел',
        pt: 'Host',
        nl: 'Host',
        fr: 'Hôte',
        it: 'Host',
        es: 'Host',
        pl: 'Host',
        uk: 'Вузол',
        'zh-cn': '主机',
    },
    port: {
        en: 'Port',
        de: 'Port',
        ru: 'Порт',
        pt: 'Porta',
        nl: 'Poort',
        fr: 'Port',
        it: 'Porta',
        es: 'Puerto',
        pl: 'Port',
        uk: 'Порт',
        'zh-cn': '端口',
    },
    ippResourcePath: {
        en: 'IPP resource path',
        de: 'IPP-Ressourcenpfad',
        ru: 'Путь ресурса IPP',
        pt: 'Caminho do recurso IPP',
        nl: 'IPP-bronpad',
        fr: 'Chemin de ressource IPP',
        it: 'Percorso risorsa IPP',
        es: 'Ruta del recurso IPP',
        pl: 'Ścieżka zasobu IPP',
        uk: 'Шлях ресурсу IPP',
        'zh-cn': 'IPP 资源路径',
    },
    useTls: {
        en: 'Use TLS',
        de: 'TLS verwenden',
        ru: 'Использовать TLS',
        pt: 'Usar TLS',
        nl: 'TLS gebruiken',
        fr: 'Utiliser TLS',
        it: 'Usa TLS',
        es: 'Usar TLS',
        pl: 'Użyj TLS',
        uk: 'Використовувати TLS',
        'zh-cn': '使用 TLS',
    },
    verifyTlsCertificate: {
        en: 'Verify TLS certificate',
        de: 'TLS-Zertifikat prüfen',
        ru: 'Проверять сертификат TLS',
        pt: 'Verificar certificado TLS',
        nl: 'TLS-certificaat controleren',
        fr: 'Vérifier le certificat TLS',
        it: 'Verifica certificato TLS',
        es: 'Verificar certificado TLS',
        pl: 'Weryfikuj certyfikat TLS',
        uk: 'Перевіряти сертифікат TLS',
        'zh-cn': '验证 TLS 证书',
    },
    model: {
        en: 'Model',
        de: 'Modell',
        ru: 'Модель',
        pt: 'Modelo',
        nl: 'Model',
        fr: 'Modèle',
        it: 'Modello',
        es: 'Modelo',
        pl: 'Model',
        uk: 'Модель',
        'zh-cn': '型号',
    },
    online: {
        en: 'Online',
        de: 'Online',
        ru: 'В сети',
        pt: 'Online',
        nl: 'Online',
        fr: 'En ligne',
        it: 'Online',
        es: 'En línea',
        pl: 'Online',
        uk: 'У мережі',
        'zh-cn': '在线',
    },
    couldNotAdd: {
        en: 'Could not add the printer',
        de: 'Drucker konnte nicht hinzugefügt werden',
        ru: 'Не удалось добавить принтер',
        pt: 'Não foi possível adicionar a impressora',
        nl: 'De printer kon niet worden toegevoegd',
        fr: "Impossible d'ajouter l'imprimante",
        it: 'Impossibile aggiungere la stampante',
        es: 'No se pudo añadir la impresora',
        pl: 'Nie można dodać drukarki',
        uk: 'Не вдалося додати принтер',
        'zh-cn': '无法添加打印机',
    },
    couldNotRemove: {
        en: 'Could not remove the printer',
        de: 'Drucker konnte nicht entfernt werden',
        ru: 'Не удалось удалить принтер',
        pt: 'Não foi possível remover a impressora',
        nl: 'De printer kon niet worden verwijderd',
        fr: "Impossible de supprimer l'imprimante",
        it: 'Impossibile rimuovere la stampante',
        es: 'No se pudo eliminar la impresora',
        pl: 'Nie można usunąć drukarki',
        uk: 'Не вдалося видалити принтер',
        'zh-cn': '无法移除打印机',
    },
    couldNotSave: {
        en: 'Could not save the printer',
        de: 'Drucker konnte nicht gespeichert werden',
        ru: 'Не удалось сохранить принтер',
        pt: 'Não foi possível guardar a impressora',
        nl: 'De printer kon niet worden opgeslagen',
        fr: "Impossible d'enregistrer l'imprimante",
        it: 'Impossibile salvare la stampante',
        es: 'No se pudo guardar la impresora',
        pl: 'Nie można zapisać drukarki',
        uk: 'Не вдалося зберегти принтер',
        'zh-cn': '无法保存打印机',
    },
} satisfies Record<string, CompleteTranslations>;

function withErrorDetail(messages: CompleteTranslations, error: unknown): CompleteTranslations {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(
        Object.entries(messages).map(([language, message]) => [language, `${message}: ${detail}`]),
    ) as CompleteTranslations;
}

const printerIcon =
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22%3E%3Cpath fill=%22%23ffffff%22 d=%22M14 4h20v10H14zM10 14h28a4 4 0 0 1 4 4v14h-8v12H14V32H6V18a4 4 0 0 1 4-4m8 20v6h12v-6zm16-14a2 2 0 1 0 0 4 2 2 0 0 0 0-4%22/%3E%3C/svg%3E';

function getPrinterFormSchema(idReadOnly = false): JsonFormSchema {
    const reservedIdValidator = idReadOnly ? 'true' : "data.id.toLowerCase() !== 'info'";
    return {
        type: 'panel',
        items: {
            id: {
                type: 'text',
                label: translations.id,
                readOnly: idReadOnly,
                validator: `!!data.id && ${reservedIdValidator} && /^[A-Za-z0-9_-]{1,32}$/.test(data.id.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'))`,
            },
            label: { type: 'text', label: translations.label },
            host: {
                type: 'text',
                label: translations.host,
                validator: `(${isValidPrinterHost.toString()})(data.host)`,
            },
            port: { type: 'number', label: translations.port, min: 1, max: 65535, default: 631 },
            basePath: {
                type: 'text',
                label: translations.ippResourcePath,
                default: '/ipp/print',
                validator: `(${isValidIppBasePath.toString()})(data.basePath)`,
            },
            ssl: { type: 'checkbox', label: translations.useTls },
            verifySsl: { type: 'checkbox', label: translations.verifyTlsCertificate, default: false },
        },
    };
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

class Ipp extends Adapter {
    private readonly deviceManagement: IppDeviceManagement;
    private pollTimer: ioBroker.Timeout | null = null;
    private pollIntervalMs = DEFAULT_INTERVAL_SECONDS * 1000;
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
            const loadedPrinterSettings = await loadPrinterConfigurations(
                this,
                Array.isArray(configuredPrinters) ? configuredPrinters : [],
            );
            const printerIds = new Map<string, string>();
            const duplicatePrinterIds = new Set<string>();
            this.configuredPrinterSettings = loadedPrinterSettings.filter((printer, index) => {
                const parsed = parsePrinterConfig(printer, undefined, { allowLegacyInfoId: true });
                if (!parsed.config) {
                    return true;
                }
                const idKey = getPrinterIdKey(parsed.config.id);
                const existingId = printerIds.get(idKey);
                if (existingId !== undefined) {
                    if (parsed.config.id !== existingId) {
                        duplicatePrinterIds.add(parsed.config.id);
                    }
                    this.log.warn(`Ignoring printer row ${index + 1}: id duplicates another configured printer`);
                    this.log.debug(`Printer row ${index + 1} fields: ${describePrinterConfig(printer)}`);
                    return false;
                }
                printerIds.set(idKey, parsed.config.id);
                return true;
            });
            for (const id of duplicatePrinterIds) {
                await this.deletePrinterObjects(id);
            }
            if (this.configuredPrinterSettings.length !== loadedPrinterSettings.length) {
                await savePrinterConfigurations(this, this.configuredPrinterSettings);
            }
            this.printers = this.configuredPrinterSettings.flatMap((printer, index) => {
                const parsed = parsePrinterConfig(printer, undefined, { allowLegacyInfoId: true });
                if (!parsed.config) {
                    this.log.warn(`Ignoring printer row ${index + 1}: ${parsed.errors.join('; ')}`);
                    this.log.debug(`Printer row ${index + 1} fields: ${describePrinterConfig(printer)}`);
                    return [];
                }
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
            this.pollIntervalMs = intervalSeconds * 1000;
            this.timeoutMs = boundedNumber(this.config.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
            await this.pollAndSchedule();
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
                return !configured || getPrinterIdKey(configured.id) !== getPrinterIdKey(previousId ?? '');
            });
            if (
                this.getConfiguredPrinters().some(
                    config =>
                        getPrinterIdKey(config.id) !== getPrinterIdKey(previousId ?? '') &&
                        getPrinterIdKey(config.id) === getPrinterIdKey(parsed.config!.id),
                )
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
                    config =>
                        getPrinterIdKey(
                            parsePrinterConfig(config, undefined, { allowLegacyInfoId: true }).config?.id ?? '',
                        ) !== getPrinterIdKey(id),
                ),
            );
        });
    }

    public getPrinter(id: string): PrinterConfig | undefined {
        const idKey = getPrinterIdKey(id);
        return this.getConfiguredPrinters().find(printer => getPrinterIdKey(printer.id) === idKey);
    }

    private async deletePrinterObjects(id: string): Promise<void> {
        if (id === 'info') {
            for (const channel of ['status', 'supplies', 'counters', 'details']) {
                await this.delObjectAsync(`info.${channel}`, { recursive: true });
            }
        } else {
            await this.delObjectAsync(id, { recursive: true });
        }
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
                await this.deletePrinterObjects(id);
            }
        }
        for (const printer of this.printers) {
            await this.createPrinterObjects(printer);
        }
        await this.pollAndSchedule();
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

    private scheduleNextPoll(): void {
        if (this.unloading) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        this.pollTimer =
            this.setTimeout(() => {
                this.pollTimer = null;
                void this.pollAndSchedule().catch(error => {
                    this.log.warn(
                        `Printer polling cycle failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
            }, this.pollIntervalMs) ?? null;
    }

    private async pollAndSchedule(): Promise<void> {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        try {
            await this.pollPrinters();
        } finally {
            this.scheduleNextPoll();
        }
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
            const result = await pollPrinter(
                {
                    host: printer.host.trim(),
                    port: boundedNumber(printer.port, 631, 1, 65535),
                    basePath: printer.basePath || '/ipp/print',
                    ssl: printer.ssl === true,
                    verifySsl: printer.verifySsl === true,
                    timeoutMs: this.timeoutMs,
                    signal: controller.signal,
                },
                {
                    schedule: (callback, timeout) => this.setTimeout(callback, timeout),
                    cancel: timer => this.clearTimeout(timer),
                },
            );
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
                this.clearTimeout(this.pollTimer);
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
                    title: translations.addPrinter,
                    handler: async (context: ActionContext) => {
                        const data = await context.showForm(getPrinterFormSchema(), {
                            title: translations.addPrinter,
                        });
                        if (!data) {
                            return { refresh: false };
                        }
                        try {
                            await this.adapter.savePrinter(data);
                            return { refresh: true };
                        } catch (error) {
                            await this.showActionError(context, translations.couldNotAdd, error);
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
                        description: translations.editPrinterConfiguration,
                        handler: async (deviceId, actionContext) => this.editPrinter(deviceId, actionContext),
                    },
                    {
                        id: 'delete',
                        icon: 'delete',
                        description: translations.removePrinter,
                        confirmation: translations.removePrinterConfirmation,
                        handler: async (deviceId, actionContext) => {
                            try {
                                await this.adapter.removePrinter(deviceId);
                                return { refresh: 'devices' };
                            } catch (error) {
                                await this.showActionError(actionContext, translations.couldNotRemove, error);
                                return { refresh: 'none' };
                            }
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
                host: { type: 'text', label: translations.host, readOnly: true },
                port: { type: 'number', label: translations.port, readOnly: true },
                basePath: { type: 'text', label: translations.ippResourcePath, readOnly: true },
                ssl: { type: 'checkbox', label: translations.useTls, readOnly: true },
                model: { type: 'state', label: translations.model, oid: `${id}.status.model` },
                online: { type: 'state', label: translations.online, oid: `${id}.status.online` },
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
            title: translations.editPrinter,
        });
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.adapter.savePrinter(data, id);
            return { refresh: 'devices' };
        } catch (error) {
            await this.showActionError(context, translations.couldNotSave, error);
            return { refresh: 'none' };
        }
    }

    private async showActionError(
        context: ActionContext,
        messages: CompleteTranslations,
        error: unknown,
    ): Promise<void> {
        await context.showMessage(withErrorDetail(messages, error));
    }
}

if (require.main === module) {
    new Ipp();
} else {
    module.exports = (options?: Partial<AdapterOptions>): Ipp => new Ipp(options);
}
