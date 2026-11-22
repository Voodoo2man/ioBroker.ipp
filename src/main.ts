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
import {
    discoverPrinters,
    importDiscoveredPrinters,
    isPrinterAlreadyConfigured,
    type DiscoveredPrinter,
    type PrinterDiscoveryResult,
} from './lib/printerDiscovery';
import { isPrinterUnavailableError, normalizeRequestTimeout, pollPrinter } from './lib/printerIpp';
import { markOffline, publishSnapshot } from './lib/printerState';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 86400;
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
    discoverPrinters: {
        en: 'Discover printers',
        de: 'Drucker suchen',
        ru: 'Найти принтеры',
        pt: 'Procurar impressoras',
        nl: 'Printers zoeken',
        fr: 'Rechercher des imprimantes',
        it: 'Cerca stampanti',
        es: 'Buscar impresoras',
        pl: 'Szukaj drukarek',
        uk: 'Шукати принтери',
        'zh-cn': '搜索打印机',
    },
    searchingPrinters: {
        en: 'Searching for IPP printers',
        de: 'Suche nach IPP-Druckern',
        ru: 'Поиск принтеров IPP',
        pt: 'A procurar impressoras IPP',
        nl: 'Zoeken naar IPP-printers',
        fr: 'Recherche des imprimantes IPP',
        it: 'Ricerca di stampanti IPP',
        es: 'Buscando impresoras IPP',
        pl: 'Wyszukiwanie drukarek IPP',
        uk: 'Пошук принтерів IPP',
        'zh-cn': '正在搜索 IPP 打印机',
    },
    printerSearchFailed: {
        en: 'Printer search failed',
        de: 'Die Druckersuche ist fehlgeschlagen',
        ru: 'Не удалось выполнить поиск принтеров',
        pt: 'A pesquisa de impressoras falhou',
        nl: 'Het zoeken naar printers is mislukt',
        fr: 'La recherche des imprimantes a échoué',
        it: 'Ricerca delle stampanti non riuscita',
        es: 'La búsqueda de impresoras ha fallado',
        pl: 'Wyszukiwanie drukarek nie powiodło się',
        uk: 'Не вдалося знайти принтери',
        'zh-cn': '打印机搜索失败',
    },
    partialScan: {
        en: 'Some network interfaces could not be searched',
        de: 'Einige Netzwerkschnittstellen konnten nicht durchsucht werden',
        ru: 'Не удалось проверить некоторые сетевые интерфейсы',
        pt: 'Não foi possível pesquisar algumas interfaces de rede',
        nl: 'Sommige netwerkinterfaces konden niet worden doorzocht',
        fr: 'Certaines interfaces réseau n’ont pas pu être analysées',
        it: 'Impossibile analizzare alcune interfacce di rete',
        es: 'No se pudieron buscar algunas interfaces de red',
        pl: 'Nie udało się przeszukać niektórych interfejsów sieciowych',
        uk: 'Не вдалося просканувати деякі мережеві інтерфейси',
        'zh-cn': '无法搜索某些网络接口',
    },
    noPrintersFound: {
        en: 'No compatible IPP printers were found. Check mDNS availability and try again.',
        de: 'Es wurden keine kompatiblen IPP-Drucker gefunden. Prüfen Sie mDNS und versuchen Sie es erneut.',
        ru: 'Совместимые принтеры IPP не найдены. Проверьте доступность mDNS и повторите попытку.',
        pt: 'Não foram encontradas impressoras IPP compatíveis. Verifique o mDNS e tente novamente.',
        nl: 'Geen compatibele IPP-printers gevonden. Controleer mDNS en probeer het opnieuw.',
        fr: 'Aucune imprimante IPP compatible trouvée. Vérifiez mDNS et réessayez.',
        it: 'Nessuna stampante IPP compatibile trovata. Verificare mDNS e riprovare.',
        es: 'No se encontraron impresoras IPP compatibles. Compruebe mDNS e inténtelo de nuevo.',
        pl: 'Nie znaleziono zgodnych drukarek IPP. Sprawdź mDNS i spróbuj ponownie.',
        uk: 'Сумісні принтери IPP не знайдені. Перевірте mDNS і повторіть спробу.',
        'zh-cn': '未找到兼容的 IPP 打印机。请检查 mDNS 并重试。',
    },
    searchResults: {
        en: 'Discovered printers (configured status refers to the advertised endpoint):',
        de: 'Gefundene Drucker (der Status bezieht sich auf den angekündigten Endpunkt):',
        ru: 'Найденные принтеры (статус относится к объявленному адресу):',
        pt: 'Impressoras encontradas (o estado refere-se ao endpoint anunciado):',
        nl: 'Gevonden printers (status geldt voor het aangekondigde eindpunt):',
        fr: 'Imprimantes détectées (statut correspondant au point de terminaison annoncé) :',
        it: 'Stampanti rilevate (lo stato si riferisce all’endpoint annunciato):',
        es: 'Impresoras encontradas (el estado corresponde al endpoint anunciado):',
        pl: 'Znalezione drukarki (status dotyczy ogłoszonego punktu końcowego):',
        uk: 'Знайдені принтери (статус стосується оголошеної адреси):',
        'zh-cn': '已发现的打印机（状态对应公告的端点）：',
    },
    alreadyConfigured: {
        en: 'already configured',
        de: 'bereits konfiguriert',
        ru: 'уже настроен',
        pt: 'já configurada',
        nl: 'al geconfigureerd',
        fr: 'déjà configurée',
        it: 'già configurata',
        es: 'ya configurada',
        pl: 'już skonfigurowana',
        uk: 'вже налаштований',
        'zh-cn': '已配置',
    },
    notConfigured: {
        en: 'not configured',
        de: 'nicht konfiguriert',
        ru: 'не настроен',
        pt: 'não configurada',
        nl: 'niet geconfigureerd',
        fr: 'non configurée',
        it: 'non configurata',
        es: 'no configurada',
        pl: 'nieskonfigurowana',
        uk: 'не налаштований',
        'zh-cn': '未配置',
    },
    pathNeedsReview: {
        en: 'not advertised; enter and verify it before saving',
        de: 'nicht angekündigt; vor dem Speichern ergänzen und prüfen',
        ru: 'не указан; укажите и проверьте перед сохранением',
        pt: 'não anunciado; indique e confirme antes de guardar',
        nl: 'niet vermeld; vul dit in en controleer het vóór het opslaan',
        fr: 'non annoncé ; renseignez-le et vérifiez-le avant l’enregistrement',
        it: 'non annunciato; inserirlo e verificarlo prima di salvare',
        es: 'no anunciada; introdúzcala y verifíquela antes de guardar',
        pl: 'nieogłoszona; uzupełnij i sprawdź przed zapisaniem',
        uk: 'не вказаний; введіть і перевірте перед збереженням',
        'zh-cn': '未公告；请在保存前填写并验证',
    },
    selectPrinters: {
        en: 'Select printers to configure',
        de: 'Drucker zur Konfiguration auswählen',
        ru: 'Выберите принтеры для настройки',
        pt: 'Selecione as impressoras para configurar',
        nl: 'Selecteer printers om te configureren',
        fr: 'Sélectionner les imprimantes à configurer',
        it: 'Seleziona le stampanti da configurare',
        es: 'Seleccione las impresoras que desea configurar',
        pl: 'Wybierz drukarki do skonfigurowania',
        uk: 'Виберіть принтери для налаштування',
        'zh-cn': '选择要配置的打印机',
    },
    configureDiscoveredPrinter: {
        en: 'Review discovered printer',
        de: 'Erkannten Drucker überprüfen',
        ru: 'Проверьте найденный принтер',
        pt: 'Rever impressora encontrada',
        nl: 'Gevonden printer controleren',
        fr: 'Vérifier l’imprimante détectée',
        it: 'Verifica stampante rilevata',
        es: 'Revisar impresora encontrada',
        pl: 'Sprawdź znalezioną drukarkę',
        uk: 'Перевірте знайдений принтер',
        'zh-cn': '检查发现的打印机',
    },
    allPrintersConfigured: {
        en: 'All discovered printer endpoints are already configured.',
        de: 'Alle gefundenen Drucker-Endpunkte sind bereits konfiguriert.',
        ru: 'Все найденные адреса принтеров уже настроены.',
        pt: 'Todos os endpoints encontrados já estão configurados.',
        nl: 'Alle gevonden printer-eindpunten zijn al geconfigureerd.',
        fr: 'Tous les points de terminaison détectés sont déjà configurés.',
        it: 'Tutti gli endpoint rilevati sono già configurati.',
        es: 'Todos los endpoints encontrados ya están configurados.',
        pl: 'Wszystkie znalezione punkty końcowe są już skonfigurowane.',
        uk: 'Усі знайдені кінцеві точки принтерів уже налаштовані.',
        'zh-cn': '发现的所有打印机端点均已配置。',
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

function formatPrinterDiscoverySummary(
    results: Array<{ printer: DiscoveredPrinter; configured: boolean }>,
): CompleteTranslations {
    const summary = {} as CompleteTranslations;
    for (const language of Object.keys(translations.discoverPrinters) as (keyof CompleteTranslations)[]) {
        const lines = results.map(({ printer, configured }) => {
            const model = [printer.manufacturer, printer.model].filter(Boolean).join(' ');
            const addresses = printer.addresses.length ? ` (${printer.addresses.join(', ')})` : '';
            return [
                `${printer.name}${model ? ` — ${model}` : ''}`,
                printer.ssl ? 'IPPS' : 'IPP',
                `${translations.host[language]}: ${printer.host}${addresses}`,
                `${translations.port[language]}: ${printer.port}`,
                `${translations.ippResourcePath[language]}: ${printer.basePath || translations.pathNeedsReview[language]}`,
                configured ? translations.alreadyConfigured[language] : translations.notConfigured[language],
            ].join(' | ');
        });
        summary[language] = [translations.searchResults[language], ...lines].join('\n');
    }
    return summary;
}

const printerIcon =
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22%3E%3Cpath fill=%22%23ffffff%22 d=%22M14 4h20v10H14zM10 14h28a4 4 0 0 1 4 4v14h-8v12H14V32H6V18a4 4 0 0 1 4-4m8 20v6h12v-6zm16-14a2 2 0 1 0 0 4 2 2 0 0 0 0-4%22/%3E%3C/svg%3E';

function getPrinterFormSchema(
    idReadOnly = false,
    basePathDefault = '/ipp/print',
    discoveryInfo?: CompleteTranslations,
): JsonFormSchema {
    const reservedIdValidator = idReadOnly ? 'true' : "data.id.toLowerCase() !== 'info'";
    return {
        type: 'panel',
        items: {
            ...(discoveryInfo ? { discoveryInfo: { type: 'infoBox' as const, text: discoveryInfo } } : {}),
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
                default: basePathDefault,
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
    private activeDiscoveryController: AbortController | null = null;
    private activeDiscovery: Promise<PrinterDiscoveryResult> | null = null;
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
            this.timeoutMs = normalizeRequestTimeout(this.config.timeoutMs, DEFAULT_TIMEOUT_MS);
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
                await this.deletePrinterObjectSubtreeIfUncustomized(legacyId);
            }
        }
        await this.setObjectNotExistsAsync(printer.id, {
            type: 'device',
            common: {
                name: printer.label || printer.id,
                statusStates: { onlineId: 'status.online' },
            },
            native: {},
        });
        await this.extendObjectAsync(printer.id, {
            common: { statusStates: { onlineId: 'status.online' } },
        });
        if (printer.id.toLowerCase() === 'info' && printer.label) {
            const device = await this.getObjectAsync(printer.id);
            if (device?.type === 'device' && device.common.name === 'info') {
                await this.extendObjectAsync(printer.id, { common: { name: printer.label } });
            }
        }
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

    public discoverPrinters(): Promise<PrinterDiscoveryResult> {
        if (this.unloading) {
            return Promise.reject(new Error('The adapter is shutting down'));
        }
        if (this.activeDiscovery) {
            return Promise.reject(new Error('A printer discovery scan is already running'));
        }
        const controller = new AbortController();
        this.activeDiscoveryController = controller;
        const scan = discoverPrinters({ signal: controller.signal });
        this.activeDiscovery = scan;
        const clearScan = (): void => {
            if (this.activeDiscovery === scan) {
                this.activeDiscovery = null;
                this.activeDiscoveryController = null;
            }
        };
        void scan.then(clearScan, clearScan);
        return scan;
    }

    public waitForConfig(): Promise<void> {
        return this.configReady;
    }

    public savePrinter(printer: unknown, previousId?: string): Promise<void> {
        return this.savePrinterWithOptions(printer, previousId);
    }

    public saveDiscoveredPrinter(printer: unknown): Promise<void> {
        return this.savePrinterWithOptions(printer, undefined, true);
    }

    public finishPrinterDiscoveryImport(): Promise<void> {
        return this.configUpdates.run(async () => {
            await this.configReady;
            await this.activePoll?.catch(error => {
                this.log.warn(
                    `Printer polling cycle failed before discovery refresh: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
            this.configRevision++;
            await this.pollAndSchedule();
        });
    }

    private savePrinterWithOptions(printer: unknown, previousId?: string, deferPolling = false): Promise<void> {
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
            await this.savePrinterList(printers, { deferPolling });
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

    private async deletePrinterObjectSubtreeIfUncustomized(id: string): Promise<void> {
        const prefix = `${this.namespace}.${id}.`;
        const { rows } = await this.getObjectViewAsync('system', 'state', {
            startkey: prefix,
            endkey: `${prefix}\uFFFF`,
        });
        const protectedStates = rows
            .filter(row => Object.keys(row.value.common.custom ?? {}).length > 0)
            .map(row => row.id);
        if (protectedStates.length > 0) {
            this.log.warn(
                `Preserving printer object subtree ${id} because descendant states have custom settings: ${protectedStates.join(', ')}`,
            );
            return;
        }
        await this.delObjectAsync(id, { recursive: true });
    }

    private async deletePrinterObjects(id: string): Promise<void> {
        if (id === 'info') {
            for (const channel of ['status', 'supplies', 'counters', 'details']) {
                await this.deletePrinterObjectSubtreeIfUncustomized(`info.${channel}`);
            }
        } else {
            await this.deletePrinterObjectSubtreeIfUncustomized(id);
        }
    }

    private async savePrinterList(printers: unknown[], options: { deferPolling?: boolean } = {}): Promise<void> {
        const previousIds = new Set(this.printers.map(printer => printer.id));
        const previousIdKeys = new Set([...previousIds].map(getPrinterIdKey));
        if (!options.deferPolling) {
            this.configRevision++;
            for (const controller of this.activeRequests) {
                controller.abort();
            }
            await this.activePoll;
        }
        try {
            await savePrinterConfigurations(this, printers);
        } catch (error) {
            if (!options.deferPolling) {
                this.configRevision++;
            }
            throw error;
        }
        this.configuredPrinterSettings = printers;
        this.printers = getUniquePrinterConfigs(printers, { allowLegacyInfoId: true });
        const currentIds = new Set(this.printers.map(printer => getPrinterIdKey(printer.id)));
        for (const id of previousIds) {
            if (!currentIds.has(getPrinterIdKey(id))) {
                await this.deletePrinterObjects(id);
            }
        }
        for (const printer of this.printers) {
            if (!options.deferPolling || !previousIdKeys.has(getPrinterIdKey(printer.id))) {
                await this.createPrinterObjects(printer);
            }
        }
        if (!options.deferPolling) {
            await this.pollAndSchedule();
        }
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
        this.activeDiscoveryController?.abort();
        if (this.pollTimer) {
            try {
                this.clearTimeout(this.pollTimer);
            } catch {
                this.log.warn('Failed to clear printer polling timer during unload');
            } finally {
                this.pollTimer = null;
            }
        }
        if (this.activeDiscovery) {
            void this.activeDiscovery.then(callback, callback);
        } else {
            callback();
        }
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
                {
                    id: 'discoverPrinters',
                    icon: 'search',
                    title: translations.discoverPrinters,
                    handler: async (context: ActionContext) => this.discoverPrintersFromNetwork(context),
                },
            ],
        };
    }

    private async discoverPrintersFromNetwork(context: ActionContext): Promise<{ refresh: boolean }> {
        let result: PrinterDiscoveryResult | undefined;
        let scanError: unknown;
        let closeProgress: (() => Promise<void>) | undefined;
        try {
            const progress = await context.openProgress(translations.searchingPrinters, { indeterminate: true });
            closeProgress = () => progress.close();
            result = await this.adapter.discoverPrinters();
        } catch (error) {
            scanError = error;
        } finally {
            if (closeProgress) {
                try {
                    await closeProgress();
                } catch (error) {
                    scanError ??= error;
                }
            }
        }
        if (scanError) {
            await this.showActionError(context, translations.printerSearchFailed, scanError);
            return { refresh: false };
        }
        if (!result) {
            await context.showMessage(translations.printerSearchFailed);
            return { refresh: false };
        }
        if (result.printers.length === 0) {
            if (result.warnings.length > 0) {
                await this.showActionError(
                    context,
                    translations.printerSearchFailed,
                    new Error(result.warnings.join('; ')),
                );
            } else {
                await context.showMessage(translations.noPrintersFound);
            }
            return { refresh: false };
        }
        if (result.warnings.length > 0) {
            await context.showMessage(withErrorDetail(translations.partialScan, new Error(result.warnings.join('; '))));
        }

        const configuredPrinters = this.adapter.getConfiguredPrinters();
        const discovered = result.printers.map(printer => ({
            printer,
            configured: isPrinterAlreadyConfigured(printer, configuredPrinters),
        }));
        const available = discovered.filter(item => !item.configured);
        const summary = formatPrinterDiscoverySummary(discovered);
        if (available.length === 0) {
            const messages = Object.fromEntries(
                Object.entries(summary).map(([language, text]) => [
                    language,
                    `${text}\n${translations.allPrintersConfigured[language as keyof CompleteTranslations]}`,
                ]),
            ) as CompleteTranslations;
            await context.showMessage(messages);
            return { refresh: false };
        }

        const selected = await context.showForm(
            {
                type: 'panel',
                items: {
                    results: { type: 'infoBox', boxType: 'info', text: summary },
                    printers: {
                        type: 'select',
                        label: translations.selectPrinters,
                        multiple: true,
                        options: available.map(({ printer }) => ({
                            label: `${printer.name} — ${printer.ssl ? 'IPPS' : 'IPP'} — ${printer.host}:${printer.port}${printer.basePath || ` — ${translations.pathNeedsReview.en}`}`,
                            value: printer.key,
                            noTranslation: true,
                        })),
                    },
                },
            },
            { title: translations.selectPrinters },
        );
        if (!selected) {
            return { refresh: false };
        }
        const selectedValues = Array.isArray(selected.printers)
            ? selected.printers
            : typeof selected.printers === 'string'
              ? [selected.printers]
              : [];
        const selectedKeys = new Set(selectedValues.filter((value): value is string => typeof value === 'string'));
        const selectedPrinters = available
            .filter(({ printer }) => selectedKeys.has(printer.key))
            .map(({ printer }) => printer);
        if (selectedPrinters.length === 0) {
            return { refresh: false };
        }

        const imported = await importDiscoveredPrinters(selectedPrinters, {
            getConfiguredPrinters: () => this.adapter.getConfiguredPrinters(),
            configurePrinter: (printer, proposed) =>
                context.showForm(
                    getPrinterFormSchema(
                        false,
                        proposed.basePath ?? '',
                        formatPrinterDiscoverySummary([{ printer, configured: false }]),
                    ),
                    {
                        data: proposed,
                        title: translations.configureDiscoveredPrinter,
                    },
                ),
            savePrinter: printer => this.adapter.saveDiscoveredPrinter(printer),
            finishImport: () => this.adapter.finishPrinterDiscoveryImport(),
        });
        if (imported.error) {
            await this.showActionError(context, translations.couldNotAdd, imported.error);
        }
        return { refresh: imported.added > 0 };
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
