import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { networkInterfaces } from 'node:os';
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
    getNewPrinterConfigs,
    getPrinterIdKey,
    getUniquePrinterConfigs,
    parsePrinterConfig,
    type PrinterConfig,
} from './lib/printerConfig';
import { loadPrinterConfigurations, savePrinterConfigurations } from './lib/printerConfigStore';
import { isValidIppBasePath, isValidPrinterHost } from './lib/printerEndpoint';
import {
    createDeferredPrinterScanRefresh,
    createSerializedProgressUpdates,
    flushDeferredPrinterScanRefresh,
    getPrinterScanTargets,
    MAX_CONFIGURED_PRINTER_HOSTNAMES,
    MAX_PRINTER_SCAN_ADDRESSES,
    MAX_PRINTER_SCAN_CONCURRENCY,
    scanForPrinters,
} from './lib/printerDiscovery';
import { SerialQueue } from './lib/serialQueue';
import { isPrinterUnavailableError, normalizeRequestTimeout, pollPrinter } from './lib/printerIpp';
import { markOffline, publishSnapshot } from './lib/printerState';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 86400;
const PRINTER_SCAN_TIMEOUT_MS = 1000;
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

const scanTranslations = {
    scanPrinters: {
        en: 'Scan for printers',
        de: 'Nach Druckern suchen',
        ru: 'Поиск принтеров',
        pt: 'Procurar impressoras',
        nl: 'Scannen naar printers',
        fr: 'Rechercher des imprimantes',
        it: 'Cerca stampanti',
        es: 'Buscar impresoras',
        pl: 'Skanuj w poszukiwaniu drukarek',
        uk: 'Шукати принтери',
        'zh-cn': '扫描打印机',
    },
    scanning: {
        en: 'Scanning for printers',
        de: 'Druckersuche läuft',
        ru: 'Выполняется поиск принтеров',
        pt: 'Procurando impressoras',
        nl: 'Printers zoeken',
        fr: "Recherche d'imprimantes",
        it: 'Ricerca delle stampanti',
        es: 'Buscando impresoras',
        pl: 'Wyszukiwanie drukarek',
        uk: 'Пошук принтерів',
        'zh-cn': '正在扫描打印机',
    },
    progress: {
        en: 'Address {completed} of {total}',
        de: 'Adresse {completed} von {total}',
        ru: 'Адрес {completed} из {total}',
        pt: 'Endereço {completed} de {total}',
        nl: 'Adres {completed} van {total}',
        fr: 'Adresse {completed} sur {total}',
        it: 'Indirizzo {completed} di {total}',
        es: 'Dirección {completed} de {total}',
        pl: 'Adres {completed} z {total}',
        uk: 'Адреса {completed} з {total}',
        'zh-cn': '地址 {completed}/{total}',
    },
    noTargets: {
        en: 'No eligible private or link-local IPv4 addresses were found on directly connected networks.',
        de: 'In direkt verbundenen Netzwerken wurden keine geeigneten privaten oder Link-Local-IPv4-Adressen gefunden.',
        ru: 'В напрямую подключённых сетях не найдено подходящих частных IPv4-адресов или адресов link-local.',
        pt: 'Não foram encontrados endereços IPv4 privados ou link-local elegíveis nas redes diretamente conectadas.',
        nl: 'Geen geschikte private of link-local IPv4-adressen gevonden op direct verbonden netwerken.',
        fr: "Aucune adresse IPv4 privée ou link-local éligible n'a été trouvée sur les réseaux directement connectés.",
        it: 'Nessun indirizzo IPv4 privato o link-local idoneo trovato sulle reti direttamente connesse.',
        es: 'No se encontraron direcciones IPv4 privadas o link-local aptas en las redes conectadas directamente.',
        pl: 'Nie znaleziono odpowiednich prywatnych ani link-local adresów IPv4 w sieciach bezpośrednio połączonych.',
        uk: 'У безпосередньо підключених мережах не знайдено відповідних приватних або link-local IPv4-адрес.',
        'zh-cn': '在直接连接的网络中未找到符合条件的私有或链路本地 IPv4 地址。',
    },
    configuredHostnameResolutionFailed: {
        en: 'Scanning was skipped because a configured printer hostname could not be resolved safely.',
        de: 'Die Suche wurde übersprungen, da ein konfigurierter Drucker-Hostname nicht sicher aufgelöst werden konnte.',
        ru: 'Сканирование пропущено: не удалось безопасно разрешить имя настроенного принтера.',
        pt: 'A pesquisa foi ignorada porque não foi possível resolver com segurança o nome de uma impressora configurada.',
        nl: 'De scan is overgeslagen omdat een geconfigureerde printernaam niet veilig kon worden omgezet.',
        fr: "La recherche a été ignorée, car le nom d'une imprimante configurée n'a pas pu être résolu en toute sécurité.",
        it: 'La scansione è stata ignorata perché non è stato possibile risolvere in modo sicuro il nome di una stampante configurata.',
        es: 'Se omitió el escaneo porque no se pudo resolver de forma segura el nombre de una impresora configurada.',
        pl: 'Pominięto skanowanie, ponieważ nie można było bezpiecznie rozpoznać nazwy skonfigurowanej drukarki.',
        uk: 'Сканування пропущено, оскільки не вдалося безпечно визначити адресу налаштованого принтера.',
        'zh-cn': '由于无法安全解析已配置的打印机主机名，已跳过扫描。',
    },
    configuredHostnameResolutionLimited: {
        en: 'Scanning was skipped because more than {maximum} unique configured printer hostnames would need resolution.',
        de: 'Die Suche wurde übersprungen, da mehr als {maximum} eindeutige konfigurierte Drucker-Hostnamen aufgelöst werden müssten.',
        ru: 'Сканирование пропущено: требуется разрешить более {maximum} уникальных имён настроенных принтеров.',
        pt: 'A pesquisa foi ignorada porque seria necessário resolver mais de {maximum} nomes únicos de impressoras configuradas.',
        nl: 'De scan is overgeslagen omdat meer dan {maximum} unieke geconfigureerde printernamen moeten worden omgezet.',
        fr: 'La recherche a été ignorée, car il faudrait résoudre plus de {maximum} noms uniques d’imprimantes configurées.',
        it: 'La scansione è stata ignorata perché sarebbe necessario risolvere più di {maximum} nomi univoci di stampanti configurate.',
        es: 'Se omitió el escaneo porque habría que resolver más de {maximum} nombres únicos de impresoras configuradas.',
        pl: 'Pominięto skanowanie, ponieważ należałoby rozpoznać więcej niż {maximum} unikatowych nazw skonfigurowanych drukarek.',
        uk: 'Сканування пропущено, оскільки потрібно визначити понад {maximum} унікальних імен налаштованих принтерів.',
        'zh-cn': '由于需要解析的已配置打印机主机名超过 {maximum} 个，已跳过扫描。',
    },
    noResults: {
        en: 'No IPP printers were found at /ipp/print on TCP port 631 after checking {scanned} addresses.',
        de: 'Nach Prüfung von {scanned} Adressen wurden keine IPP-Drucker unter /ipp/print an TCP-Port 631 gefunden.',
        ru: 'После проверки {scanned} адресов IPP-принтеры на /ipp/print через TCP-порт 631 не найдены.',
        pt: 'Nenhuma impressora IPP foi encontrada em /ipp/print na porta TCP 631 após verificar {scanned} endereços.',
        nl: 'Na controle van {scanned} adressen zijn geen IPP-printers gevonden op /ipp/print via TCP-poort 631.',
        fr: "Aucune imprimante IPP n'a été trouvée sur /ipp/print au port TCP 631 après vérification de {scanned} adresses.",
        it: 'Nessuna stampante IPP trovata su /ipp/print alla porta TCP 631 dopo aver controllato {scanned} indirizzi.',
        es: 'No se encontraron impresoras IPP en /ipp/print en el puerto TCP 631 tras comprobar {scanned} direcciones.',
        pl: 'Po sprawdzeniu {scanned} adresów nie znaleziono drukarek IPP pod /ipp/print na porcie TCP 631.',
        uk: 'Після перевірки {scanned} адрес IPP-принтери на /ipp/print через TCP-порт 631 не знайдені.',
        'zh-cn': '检查 {scanned} 个地址后，未在 TCP 端口 631 的 /ipp/print 上发现 IPP 打印机。',
    },
    found: {
        en: 'Found {found} IPP printer candidate(s). Select which to add; confirm each in the printer form. Scanning does not save devices.',
        de: '{found} mögliche IPP-Drucker gefunden. Wählen Sie die hinzuzufügenden Geräte aus und bestätigen Sie jeden im Formular. Die Suche speichert keine Geräte.',
        ru: 'Найдено кандидатов IPP-принтеров: {found}. Выберите нужные и подтвердите каждый в форме. Поиск не сохраняет устройства.',
        pt: 'Encontradas {found} possíveis impressoras IPP. Selecione as que pretende adicionar e confirme cada uma no formulário. A pesquisa não guarda dispositivos.',
        nl: '{found} mogelijke IPP-printers gevonden. Selecteer welke u wilt toevoegen en bevestig elke printer in het formulier. Scannen slaat niets op.',
        fr: "{found} imprimante(s) IPP potentielle(s) trouvée(s). Sélectionnez celles à ajouter et confirmez chacune dans le formulaire. La recherche n'enregistre rien.",
        it: 'Trovate {found} possibili stampanti IPP. Selezionare quelle da aggiungere e confermare ciascuna nel modulo. La scansione non salva nulla.',
        es: 'Se encontraron {found} posibles impresoras IPP. Seleccione cuáles añadir y confirme cada una en el formulario. La búsqueda no guarda nada.',
        pl: 'Znaleziono kandydatów na drukarki IPP: {found}. Wybierz je i potwierdź każdą w formularzu. Skanowanie niczego nie zapisuje.',
        uk: 'Знайдено кандидатів IPP-принтерів: {found}. Виберіть потрібні та підтвердьте кожен у формі. Сканування нічого не зберігає.',
        'zh-cn': '发现 {found} 个可能的 IPP 打印机。选择要添加的设备，并在打印机表单中逐一确认。扫描不会保存设备。',
    },
    limit: {
        en: 'The scan is limited to {maximum} addresses; some printers may not have been checked.',
        de: 'Die Suche ist auf {maximum} Adressen begrenzt; möglicherweise wurden nicht alle Drucker geprüft.',
        ru: 'Сканирование ограничено {maximum} адресами; некоторые принтеры могли не попасть в проверку.',
        pt: 'A pesquisa está limitada a {maximum} endereços; algumas impressoras podem não ter sido verificadas.',
        nl: 'De scan is beperkt tot {maximum} adressen; sommige printers zijn mogelijk niet gecontroleerd.',
        fr: "La recherche est limitée à {maximum} adresses ; certaines imprimantes n'ont peut-être pas été vérifiées.",
        it: 'La scansione è limitata a {maximum} indirizzi; alcune stampanti potrebbero non essere state controllate.',
        es: 'El escaneo está limitado a {maximum} direcciones; es posible que no se hayan comprobado algunas impresoras.',
        pl: 'Skanowanie jest ograniczone do {maximum} adresów; niektóre drukarki mogły nie zostać sprawdzone.',
        uk: 'Сканування обмежено {maximum} адресами; деякі принтери могли не перевірятися.',
        'zh-cn': '扫描最多检查 {maximum} 个地址；部分打印机可能未被检查。',
    },
    selectTitle: {
        en: 'Select printers to add',
        de: 'Drucker zum Hinzufügen auswählen',
        ru: 'Выберите принтеры для добавления',
        pt: 'Selecionar impressoras para adicionar',
        nl: 'Printers selecteren om toe te voegen',
        fr: 'Sélectionner les imprimantes à ajouter',
        it: 'Seleziona le stampanti da aggiungere',
        es: 'Seleccionar impresoras para añadir',
        pl: 'Wybierz drukarki do dodania',
        uk: 'Виберіть принтери для додавання',
        'zh-cn': '选择要添加的打印机',
    },
    candidates: {
        en: 'Printer candidates',
        de: 'Druckerkandidaten',
        ru: 'Кандидаты в принтеры',
        pt: 'Impressoras encontradas',
        nl: 'Printerkandidaten',
        fr: 'Imprimantes candidates',
        it: 'Stampanti candidate',
        es: 'Impresoras candidatas',
        pl: 'Kandydaci na drukarki',
        uk: 'Кандидати на принтери',
        'zh-cn': '打印机候选项',
    },
    alreadyRunning: {
        en: 'A printer scan is already running.',
        de: 'Eine Druckersuche läuft bereits.',
        ru: 'Поиск принтеров уже выполняется.',
        pt: 'Já está a decorrer uma pesquisa de impressoras.',
        nl: 'Er wordt al naar printers gescand.',
        fr: 'Une recherche des imprimantes est déjà en cours.',
        it: 'È già in corso una scansione delle stampanti.',
        es: 'Ya hay un escaneo de impresoras en curso.',
        pl: 'Skanowanie drukarek jest już uruchomione.',
        uk: 'Сканування принтерів уже виконується.',
        'zh-cn': '打印机扫描已在运行。',
    },
    scanFailed: {
        en: 'Could not scan for printers',
        de: 'Druckersuche fehlgeschlagen',
        ru: 'Не удалось выполнить поиск принтеров',
        pt: 'Não foi possível procurar impressoras',
        nl: 'Scannen naar printers is mislukt',
        fr: 'Impossible de rechercher des imprimantes',
        it: 'Impossibile cercare stampanti',
        es: 'No se pudieron buscar impresoras',
        pl: 'Nie można było wyszukać drukarek',
        uk: 'Не вдалося знайти принтери',
        'zh-cn': '无法扫描打印机',
    },
} satisfies Record<string, CompleteTranslations>;

function withErrorDetail(messages: CompleteTranslations, error: unknown): CompleteTranslations {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(
        Object.entries(messages).map(([language, message]) => [language, `${message}: ${detail}`]),
    ) as CompleteTranslations;
}

function withTranslationValues(
    messages: CompleteTranslations,
    values: Record<string, string | number>,
): CompleteTranslations {
    return Object.fromEntries(
        Object.entries(messages).map(([language, message]) => [
            language,
            message.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder)),
        ]),
    ) as CompleteTranslations;
}

function appendTranslations(first: CompleteTranslations, second: CompleteTranslations): CompleteTranslations {
    return Object.fromEntries(
        Object.entries(first).map(([language, message]) => [
            language,
            `${message} ${second[language as keyof CompleteTranslations]}`,
        ]),
    ) as CompleteTranslations;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        throw new Error('Printer scan was cancelled');
    }
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            reject(new Error('Printer scan was cancelled'));
        };
        const onResolve = (value: T): void => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onReject = (error: unknown): void => {
            signal.removeEventListener('abort', onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(onResolve, onReject);
    });
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

interface SavePrinterOptions {
    preservedController?: AbortController;
    deferPoll?: boolean;
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

    public waitForConfig(): Promise<void> {
        return this.configReady;
    }

    public async savePrinter(printer: unknown, previousId?: string, options: SavePrinterOptions = {}): Promise<void> {
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
            await this.savePrinterList(printers, options);
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

    public createPrinterScanController(): AbortController {
        const controller = new AbortController();
        this.activeRequests.add(controller);
        if (this.unloading) {
            controller.abort();
        }
        return controller;
    }

    public releasePrinterScanController(controller: AbortController): void {
        this.activeRequests.delete(controller);
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

    private async savePrinterList(printers: unknown[], options: SavePrinterOptions = {}): Promise<void> {
        const previousIds = new Set(this.printers.map(printer => printer.id));
        this.configRevision++;
        for (const controller of this.activeRequests) {
            if (controller !== options.preservedController) {
                controller.abort();
            }
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
        const printersToInitialize = options.deferPoll
            ? getNewPrinterConfigs(this.printers, previousIds)
            : this.printers;
        for (const printer of printersToInitialize) {
            await this.createPrinterObjects(printer);
        }
        if (!options.deferPoll) {
            await this.pollAndSchedule();
        }
    }

    public async refreshPrintersAfterScan(): Promise<void> {
        if (!this.unloading) {
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
    private scanInProgress = false;

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
                    id: 'scanPrinters',
                    icon: 'search',
                    title: scanTranslations.scanPrinters,
                    handler: async (context: ActionContext) => this.scanPrinters(context),
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

    private async scanPrinters(context: ActionContext): Promise<{ refresh: boolean }> {
        const scanController = this.adapter.createPrinterScanController();
        if (scanController.signal.aborted) {
            this.adapter.releasePrinterScanController(scanController);
            return { refresh: false };
        }
        if (this.scanInProgress) {
            try {
                await context.showMessage(scanTranslations.alreadyRunning);
                return { refresh: false };
            } finally {
                this.adapter.releasePrinterScanController(scanController);
            }
        }
        this.scanInProgress = true;
        let progress: Awaited<ReturnType<ActionContext['openProgress']>> | undefined;
        let progressUpdates: ReturnType<typeof createSerializedProgressUpdates> | undefined;
        let added = false;
        const deferredScanRefresh = createDeferredPrinterScanRefresh(() => this.adapter.refreshPrintersAfterScan());
        const closeProgress = async (): Promise<void> => {
            if (!progress) {
                return;
            }
            const openedProgress = progress;
            progress = undefined;
            if (!scanController.signal.aborted) {
                try {
                    await awaitWithAbort(progressUpdates?.flush() ?? Promise.resolve(), scanController.signal);
                } catch {
                    // Cancellation or a failed progress update must not prevent closing the dialog.
                }
            }
            try {
                await openedProgress.close();
            } catch {
                // The scan result remains the useful outcome if the progress dialog has already closed.
            }
        };
        try {
            await awaitWithAbort(this.adapter.waitForConfig(), scanController.signal);
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            const configuredPrinters = this.adapter.getConfiguredPrinters();
            const targets = await getPrinterScanTargets(networkInterfaces(), {
                configuredHosts: configuredPrinters.map(printer => printer.host),
                signal: scanController.signal,
            });
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            if (targets.configuredHostResolutionLimited) {
                await context.showMessage(
                    withTranslationValues(scanTranslations.configuredHostnameResolutionLimited, {
                        maximum: MAX_CONFIGURED_PRINTER_HOSTNAMES,
                    }),
                );
                return { refresh: false };
            }
            if (targets.configuredHostResolutionFailed) {
                await context.showMessage(scanTranslations.configuredHostnameResolutionFailed);
                return { refresh: false };
            }
            if (targets.addresses.length === 0) {
                await context.showMessage(scanTranslations.noTargets);
                return { refresh: false };
            }

            const openingProgress = context.openProgress(scanTranslations.scanning, {
                value: 0,
                label: withTranslationValues(scanTranslations.progress, {
                    completed: 0,
                    total: targets.addresses.length,
                }),
            });
            try {
                progress = await awaitWithAbort(openingProgress, scanController.signal);
            } catch (error) {
                if (scanController.signal.aborted) {
                    void openingProgress.then(openedProgress => openedProgress.close()).catch(() => undefined);
                }
                throw error;
            }
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            const progressDialog = progress;
            progressUpdates = createSerializedProgressUpdates(
                (completed, total) =>
                    progressDialog.update({
                        value: Math.floor((completed / total) * 100),
                        label: withTranslationValues(scanTranslations.progress, { completed, total }),
                    }),
                scanController.signal,
            );
            const progressUpdateStride = Math.max(1, Math.ceil(targets.addresses.length / 20));
            const result = await scanForPrinters(
                targets,
                host =>
                    pollPrinter(
                        {
                            host,
                            port: 631,
                            basePath: '/ipp/print',
                            ssl: false,
                            verifySsl: false,
                            timeoutMs: PRINTER_SCAN_TIMEOUT_MS,
                            signal: scanController.signal,
                        },
                        {
                            schedule: (callback, timeout) => this.adapter.setTimeout(callback, timeout),
                            cancel: timer => this.adapter.clearTimeout(timer),
                        },
                    ),
                {
                    concurrency: MAX_PRINTER_SCAN_CONCURRENCY,
                    configuredIds: configuredPrinters.map(printer => printer.id),
                    signal: scanController.signal,
                    onProgress: (completed, total) => {
                        if (completed === total || completed % progressUpdateStride === 0) {
                            return progressUpdates!.report(completed, total);
                        }
                    },
                },
            );
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            await awaitWithAbort(progressUpdates.flush(), scanController.signal);
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            await closeProgress();
            if (scanController.signal.aborted) {
                return { refresh: false };
            }

            if (result.candidates.length === 0) {
                let message = withTranslationValues(scanTranslations.noResults, { scanned: result.scanned });
                if (targets.limited) {
                    message = appendTranslations(
                        message,
                        withTranslationValues(scanTranslations.limit, { maximum: MAX_PRINTER_SCAN_ADDRESSES }),
                    );
                }
                await context.showMessage(message);
                return { refresh: false };
            }

            let message = withTranslationValues(scanTranslations.found, { found: result.candidates.length });
            if (targets.limited) {
                message = appendTranslations(
                    message,
                    withTranslationValues(scanTranslations.limit, { maximum: MAX_PRINTER_SCAN_ADDRESSES }),
                );
            }
            await context.showMessage(message);
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            const selection = await context.showForm(
                {
                    type: 'panel',
                    items: {
                        selected: {
                            type: 'select',
                            label: scanTranslations.candidates,
                            multiple: true,
                            options: result.candidates.map(candidate => ({
                                label: `${candidate.label} (${candidate.host})`,
                                value: candidate.id,
                            })),
                        },
                    },
                },
                {
                    title: scanTranslations.selectTitle,
                    data: { selected: [] },
                    ignoreApplyDisabled: true,
                },
            );
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            const selectedValue: unknown = selection?.selected;
            const selectedIds = new Set(
                typeof selectedValue === 'string'
                    ? [selectedValue]
                    : Array.isArray(selectedValue)
                      ? selectedValue.filter((id): id is string => typeof id === 'string')
                      : [],
            );
            for (const candidate of result.candidates) {
                if (scanController.signal.aborted) {
                    return { refresh: false };
                }
                if (!selectedIds.has(candidate.id)) {
                    continue;
                }
                const data = await context.showForm(getPrinterFormSchema(), {
                    title: translations.addPrinter,
                    data: {
                        id: candidate.id,
                        label: candidate.label,
                        host: candidate.host,
                        port: 631,
                        basePath: '/ipp/print',
                        ssl: false,
                        verifySsl: false,
                    },
                    ignoreApplyDisabled: true,
                });
                if (scanController.signal.aborted) {
                    return { refresh: false };
                }
                if (!data) {
                    continue;
                }
                try {
                    await deferredScanRefresh.save(() =>
                        this.adapter.savePrinter(data, undefined, {
                            preservedController: scanController,
                            deferPoll: true,
                        }),
                    );
                    if (scanController.signal.aborted) {
                        return { refresh: false };
                    }
                    added = true;
                } catch (error) {
                    if (scanController.signal.aborted) {
                        return { refresh: false };
                    }
                    await this.showActionError(context, translations.couldNotAdd, error);
                    if (scanController.signal.aborted) {
                        return { refresh: false };
                    }
                }
            }
            await deferredScanRefresh.flush();
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            return { refresh: added };
        } catch (error) {
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            await closeProgress();
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            if (!(await flushDeferredPrinterScanRefresh(deferredScanRefresh, scanController.signal))) {
                return { refresh: false };
            }
            await this.showActionError(context, scanTranslations.scanFailed, error);
            if (scanController.signal.aborted) {
                return { refresh: false };
            }
            return { refresh: added };
        } finally {
            await closeProgress();
            this.adapter.releasePrinterScanController(scanController);
            this.scanInProgress = false;
        }
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
