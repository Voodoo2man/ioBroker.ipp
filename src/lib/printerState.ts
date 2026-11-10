import type {} from '@iobroker/adapter-core';
import type { PrinterSnapshot, PrinterSupply } from './printerIpp';

interface PrinterConfig {
    id: string;
}

interface StateAdapter {
    namespace: string;
    setObjectNotExistsAsync(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    setObjectAsync(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    extendObjectAsync(id: string, object: { common: { states: Record<number, string> } }): Promise<unknown>;
    setStateAsync(id: string, state: ioBroker.SettableState): Promise<unknown>;
    getStatesOfAsync(parentDevice: string, parentChannel?: string): Promise<ioBroker.StateObject[]>;
}

type Snapshot = Omit<Partial<PrinterSnapshot>, 'counters'> & {
    counters?: Partial<PrinterSnapshot['counters']>;
    supplies?: PrinterSupply[];
    details?: PrinterSnapshot['details'];
};

function stateObject(common: ioBroker.StateCommon): ioBroker.SettableObject {
    return { type: 'state', common, native: {} };
}

const managedCommonKeys = ['name', 'type', 'role', 'read', 'write', 'min', 'max', 'unit', 'states'] as const;

function fullStateId(adapter: StateAdapter, id: string): string {
    const prefix = `${adapter.namespace}.`;
    return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

function localStateId(adapter: StateAdapter, id: string): string {
    const prefix = `${adapter.namespace}.`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

async function writeState(
    adapter: StateAdapter,
    id: string,
    common: ioBroker.StateCommon,
    value: unknown,
): Promise<void> {
    const existing = await adapter.getObjectAsync(id);
    if (!existing) {
        await adapter.setObjectNotExistsAsync(id, stateObject(common));
    } else {
        const existingCommon = existing.common as ioBroker.StateCommon;
        const metadataChanged =
            existing.type !== 'state' ||
            managedCommonKeys.some(key => JSON.stringify(existingCommon[key]) !== JSON.stringify(common[key]));
        if (metadataChanged) {
            const updatedCommon: Record<string, unknown> = { ...existingCommon };
            for (const key of managedCommonKeys) {
                if (common[key] === undefined) {
                    delete updatedCommon[key];
                } else {
                    updatedCommon[key] = common[key];
                }
            }
            await adapter.setObjectAsync(id, {
                type: 'state',
                common: updatedCommon as unknown as ioBroker.StateCommon,
                native: existing.native ?? {},
                acl: existing.type === 'state' ? existing.acl : undefined,
            });
        }
    }
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
    const slug = (supply.sourceName ?? supply.description)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return `${printerId}.supplies.${index}_${slug || 'supply'}`;
}

export async function publishSnapshot(adapter: StateAdapter, printer: PrinterConfig, result: Snapshot): Promise<void> {
    if (result.online !== true) {
        await markOffline(adapter, printer);
        return;
    }
    await writeState(
        adapter,
        `${printer.id}.status.online`,
        { name: 'Online', type: 'boolean', role: 'indicator', read: true, write: false },
        true,
    );

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

    const existingStatusIds = new Set((await adapter.getStatesOfAsync(printer.id, 'status')).map(state => state._id));
    for (const status of statusValues) {
        if (status.value !== null || existingStatusIds.has(fullStateId(adapter, status.id))) {
            await writeState(adapter, status.id, status.common, status.value);
        }
    }

    for (const [index, supply] of (result.supplies ?? []).entries()) {
        if (!validSupply(supply)) {
            continue;
        }
        const id = supplyStateId(printer.id, supply, supply.sourceIndex ?? index);
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
    const currentCounterIds = new Set<string>();
    for (const [key, id, name, unit] of counterDefinitions) {
        const stateId = `${printer.id}.counters.${id}`;
        const candidate = result.counters?.[key];
        const value = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
        if (value !== null) {
            await writeState(
                adapter,
                stateId,
                { name, type: 'number', role: 'value', read: true, write: false, unit },
                value,
            );
            currentCounterIds.add(fullStateId(adapter, stateId));
        }
    }
    for (const state of await adapter.getStatesOfAsync(printer.id, 'counters')) {
        if (!currentCounterIds.has(fullStateId(adapter, state._id))) {
            await adapter.setStateAsync(localStateId(adapter, state._id), { val: null, ack: true });
        }
    }

    const currentDetailIds = new Set<string>();
    for (const detail of result.details ?? []) {
        if (!/^[a-z0-9_]+$/.test(detail.id)) {
            continue;
        }
        const stateId = `${printer.id}.details.${detail.id}`;
        const type = typeof detail.value;
        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
            continue;
        }
        currentDetailIds.add(fullStateId(adapter, stateId));
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

    for (const state of await adapter.getStatesOfAsync(printer.id, 'details')) {
        if (!currentDetailIds.has(fullStateId(adapter, state._id))) {
            await adapter.setStateAsync(localStateId(adapter, state._id), { val: null, ack: true });
        }
    }
}

export async function markOffline(adapter: StateAdapter, printer: PrinterConfig): Promise<void> {
    await writeState(
        adapter,
        `${printer.id}.status.online`,
        { name: 'Online', type: 'boolean', role: 'indicator', read: true, write: false },
        false,
    );
    const stateId = `${printer.id}.status.state`;
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
}
