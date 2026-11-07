import type {} from '@iobroker/adapter-core';
import type { PrinterSnapshot, PrinterSupply } from './printerIpp';

interface PrinterConfig {
    id: string;
}

interface StateAdapter {
    printerStateIds?: Map<string, Set<string>>;
    setObjectNotExistsAsync(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    extendObjectAsync(id: string, object: { common: { states: Record<number, string> } }): Promise<unknown>;
    setStateAsync(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

type Snapshot = Omit<Partial<PrinterSnapshot>, 'counters'> & {
    counters?: Partial<PrinterSnapshot['counters']>;
    supplies?: PrinterSupply[];
    details?: PrinterSnapshot['details'];
};

function stateObject(common: ioBroker.StateCommon): ioBroker.SettableObject {
    return { type: 'state', common, native: {} };
}

async function writeState(
    adapter: StateAdapter,
    id: string,
    common: ioBroker.StateCommon,
    value: unknown,
): Promise<void> {
    await adapter.setObjectNotExistsAsync(id, stateObject(common));
    await adapter.setStateAsync(id, { val: value as ioBroker.StateValue, ack: true });
}

function validSupply(supply: PrinterSupply): boolean {
    return (
        typeof supply.description === 'string' &&
        supply.description.trim() !== '' &&
        Number.isFinite(supply.level) &&
        Number.isFinite(supply.maxLevel) &&
        supply.maxLevel > 0 &&
        supply.level >= 0 &&
        supply.level <= supply.maxLevel
    );
}

function supplyStateId(printerId: string, supply: PrinterSupply, index: number): string {
    const slug = supply.description
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return `${printerId}.supplies.${index}_${slug || 'supply'}`;
}

function getPrinterStates(adapter: StateAdapter, printerId: string): Set<string> {
    adapter.printerStateIds ??= new Map();
    if (!adapter.printerStateIds.has(printerId)) {
        adapter.printerStateIds.set(printerId, new Set());
    }
    return adapter.printerStateIds.get(printerId)!;
}

export async function publishSnapshot(adapter: StateAdapter, printer: PrinterConfig, result: Snapshot): Promise<void> {
    if (result.online !== true) {
        await markOffline(adapter, printer);
        return;
    }
    await adapter.setStateAsync(`${printer.id}.status.online`, { val: true, ack: true });
    const knownStates = getPrinterStates(adapter, printer.id);

    const statusValues: Array<{
        id: string;
        common: ioBroker.StateCommon;
        value: unknown;
    }> = [
        {
            id: `${printer.id}.status.model`,
            common: { name: 'Model', type: 'string', role: 'text', read: true, write: false },
            value: typeof result.model === 'string' && result.model.trim() ? result.model.trim() : null,
        },
        {
            id: `${printer.id}.status.message`,
            common: { name: 'Status', type: 'string', role: 'text', read: true, write: false },
            value: typeof result.status === 'string' && result.status.trim() ? result.status.trim() : null,
        },
        {
            id: `${printer.id}.status.state`,
            common: {
                name: 'Printer state',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                states: { 0: 'off', 3: 'idle', 4: 'printing', 5: 'stopped' },
            },
            value:
                typeof result.printerState === 'number' &&
                Number.isInteger(result.printerState) &&
                result.printerState >= 3 &&
                result.printerState <= 5
                    ? result.printerState
                    : null,
        },
    ];

    for (const status of statusValues) {
        if (status.value !== null || knownStates.has(status.id)) {
            await writeState(adapter, status.id, status.common, status.value);
            knownStates.add(status.id);
        }
    }

    for (const [index, supply] of (result.supplies ?? []).entries()) {
        if (!validSupply(supply)) {
            continue;
        }
        const id = supplyStateId(printer.id, supply, index);
        await writeState(
            adapter,
            id,
            {
                name: supply.description.trim(),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                min: 0,
                max: supply.maxLevel,
                unit: '%',
            },
            supply.level,
        );
    }

    const counterDefinitions = [
        ['pagesCompleted', 'pages_completed', 'Pages completed', 'pages'],
        ['impressionsCompleted', 'impressions_completed', 'Impressions completed', 'impressions'],
        ['mediaSheetsCompleted', 'media_sheets_completed', 'Media sheets completed', 'sheets'],
    ] as const;
    for (const [key, id, name, unit] of counterDefinitions) {
        const stateId = `${printer.id}.counters.${id}`;
        const candidate = result.counters?.[key];
        const value = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
        if (value !== null || knownStates.has(stateId)) {
            await writeState(
                adapter,
                stateId,
                { name, type: 'number', role: 'value', read: true, write: false, unit },
                value,
            );
            knownStates.add(stateId);
        }
    }

    const currentDetailIds = new Set<string>();
    for (const detail of result.details ?? []) {
        if (!/^[a-z0-9_]+$/.test(detail.id)) {
            continue;
        }
        const stateId = `${printer.id}.details.${detail.id}`;
        currentDetailIds.add(stateId);
        knownStates.add(stateId);
        const type = typeof detail.value;
        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
            continue;
        }
        await writeState(
            adapter,
            stateId,
            {
                name: detail.name,
                type,
                role: type === 'boolean' ? 'indicator' : type === 'number' ? 'value' : 'text',
                read: true,
                write: false,
                ...(type === 'number' ? { unit: detail.id.includes('per_minute') ? 'pages/min' : undefined } : {}),
            },
            detail.value,
        );
    }

    for (const id of knownStates) {
        if (id.startsWith(`${printer.id}.details.`) && !currentDetailIds.has(id)) {
            await adapter.setStateAsync(id, { val: null, ack: true });
        }
    }
}

export async function markOffline(adapter: StateAdapter, printer: PrinterConfig): Promise<void> {
    await adapter.setStateAsync(`${printer.id}.status.online`, { val: false, ack: true });
    const stateId = `${printer.id}.status.state`;
    const knownStates = getPrinterStates(adapter, printer.id);
    const stateLabels = { 0: 'off', 3: 'idle', 4: 'printing', 5: 'stopped' };
    await writeState(
        adapter,
        stateId,
        {
            name: 'Printer state',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            states: stateLabels,
        },
        0,
    );
    await adapter.extendObjectAsync(stateId, { common: { states: stateLabels } });
    knownStates.add(stateId);
}
