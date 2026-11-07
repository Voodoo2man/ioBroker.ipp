import { expect } from 'chai';
import { markOffline, publishSnapshot } from './printerState';

function makeAdapter(storage = { states: new Map<string, unknown>(), objects: new Map<string, unknown>() }): {
    states: Map<string, unknown>;
    objects: Map<string, unknown>;
    setObjectNotExistsAsync: (id: string, object: unknown) => Promise<void>;
    extendObjectAsync: (id: string, object: unknown) => Promise<void>;
    setStateAsync: (id: string, state: unknown) => Promise<void>;
    getStatesOfAsync: (parentDevice: string, parentChannel?: string) => Promise<ioBroker.StateObject[]>;
} {
    const { states, objects } = storage;
    return {
        states,
        objects,
        setObjectNotExistsAsync: (id: string, object: unknown) =>
            Promise.resolve(objects.has(id) ? undefined : objects.set(id, object)).then(() => undefined),
        extendObjectAsync: (id: string, object: unknown) => {
            const existing = objects.get(id) as { common?: { states?: Record<number, string> } } | undefined;
            const extension = object as { common: { states: Record<number, string> } };
            objects.set(id, {
                ...existing,
                common: { ...existing?.common, states: { ...existing?.common?.states, ...extension.common.states } },
            });
            return Promise.resolve();
        },
        setStateAsync: (id: string, state: unknown) => Promise.resolve(states.set(id, state)).then(() => undefined),
        getStatesOfAsync: (parentDevice: string, parentChannel?: string) =>
            Promise.resolve(
                [...objects.keys()]
                    .filter(id => id.startsWith(`${parentDevice}.${parentChannel ?? ''}.`))
                    .map(_id => ({ _id, type: 'state', common: {}, native: {} }) as ioBroker.StateObject),
            ),
    };
}

describe('printerState', () => {
    it('publishes status and supply values as acknowledged states', async () => {
        const adapter = makeAdapter();
        await publishSnapshot(
            adapter,
            { id: 'office' },
            {
                online: true,
                status: 'printing',
                printerState: 4,
                model: 'HP Printer',
                counters: { pagesCompleted: 100, impressionsCompleted: null, mediaSheetsCompleted: null },
                supplies: [{ description: 'Black toner', level: 70, maxLevel: 100, unit: 14, markerType: 'toner' }],
                details: [
                    { id: 'printer_location', name: 'Printer location', value: 'Office' },
                    { id: 'queued_job_count', name: 'Queued jobs', value: 2 },
                ],
            },
        );
        expect(adapter.states.get('office.status.online')).to.deep.equal({ val: true, ack: true });
        expect(adapter.states.get('office.status.message')).to.deep.equal({ val: 'printing', ack: true });
        expect(adapter.states.get('office.status.state')).to.deep.equal({ val: 4, ack: true });
        expect(adapter.states.get('office.status.model')).to.deep.equal({ val: 'HP Printer', ack: true });
        expect(adapter.states.get('office.counters.pages_completed')).to.deep.equal({ val: 100, ack: true });
        expect(adapter.states.get('office.supplies.0_black_toner')).to.deep.equal({ val: 70, ack: true });
        expect(adapter.states.get('office.details.printer_location')).to.deep.equal({ val: 'Office', ack: true });
        expect(adapter.states.get('office.details.queued_job_count')).to.deep.equal({ val: 2, ack: true });
    });

    it('keeps the last supply reading when the next successful poll lacks supply data', async () => {
        const adapter = makeAdapter();
        const printer = { id: 'office' };
        await publishSnapshot(adapter, printer, {
            online: true,
            status: 'printing',
            printerState: 4,
            counters: { pagesCompleted: 100, impressionsCompleted: null, mediaSheetsCompleted: null },
            supplies: [{ description: 'Black toner', level: 70, maxLevel: 100, unit: 14, markerType: 'toner' }],
            details: [{ id: 'printer_location', name: 'Printer location', value: 'Office' }],
        });
        await publishSnapshot(adapter, printer, {
            online: true,
            status: null,
            printerState: null,
            counters: {},
            supplies: [],
            details: [],
        });
        expect(adapter.states.get('office.status.online')).to.deep.equal({ val: true, ack: true });
        expect(adapter.states.get('office.status.message')).to.deep.equal({ val: null, ack: true });
        expect(adapter.states.get('office.status.state')).to.deep.equal({ val: null, ack: true });
        expect(adapter.states.get('office.counters.pages_completed')).to.deep.equal({ val: null, ack: true });
        expect(adapter.states.get('office.supplies.0_black_toner')).to.deep.equal({ val: 70, ack: true });
        expect(adapter.states.get('office.details.printer_location')).to.deep.equal({ val: null, ack: true });
    });

    it('clears missing counters and details after a restart using stored state objects', async () => {
        const firstRun = makeAdapter();
        await publishSnapshot(
            firstRun,
            { id: 'office' },
            {
                online: true,
                counters: { pagesCompleted: 10 },
                details: [{ id: 'printer_location', name: 'Printer location', value: 'Office' }],
            },
        );

        const restarted = makeAdapter({ states: firstRun.states, objects: firstRun.objects });
        await publishSnapshot(restarted, { id: 'office' }, { online: true, counters: {}, details: [] });

        expect(firstRun.states.get('office.counters.pages_completed')).to.deep.equal({ val: null, ack: true });
        expect(firstRun.states.get('office.details.printer_location')).to.deep.equal({ val: null, ack: true });
    });

    it('keeps the last known readings when the printer goes offline', async () => {
        const adapter = makeAdapter();
        const printer = { id: 'office' };
        await publishSnapshot(adapter, printer, {
            online: true,
            status: 'idle',
            printerState: 3,
            counters: { pagesCompleted: 20, impressionsCompleted: null, mediaSheetsCompleted: null },
            supplies: [{ description: 'Black toner', level: 0, maxLevel: 100, unit: 14, markerType: 'toner' }],
        });
        await markOffline(adapter, printer);
        expect(adapter.states.get('office.status.online')).to.deep.equal({ val: false, ack: true });
        expect(adapter.states.get('office.status.state')).to.deep.equal({ val: 0, ack: true });
        expect(
            (adapter.objects.get('office.status.state') as { common: { states: Record<number, string> } }).common
                .states[0],
        ).to.equal('off');
        expect(adapter.states.get('office.status.message')).to.deep.equal({ val: 'idle', ack: true });
        expect(adapter.states.get('office.counters.pages_completed')).to.deep.equal({ val: 20, ack: true });
        expect(adapter.states.get('office.supplies.0_black_toner')).to.deep.equal({ val: 0, ack: true });
    });

    it('keeps the last known readings when an offline poll result arrives', async () => {
        const adapter = makeAdapter();
        const printer = { id: 'office' };
        await publishSnapshot(adapter, printer, {
            online: true,
            status: 'idle',
            printerState: 3,
            counters: { pagesCompleted: 20, impressionsCompleted: null, mediaSheetsCompleted: null },
            supplies: [{ description: 'Black toner', level: 45.25, maxLevel: 100, unit: 14, markerType: 'toner' }],
        });
        await publishSnapshot(adapter, printer, { online: false });
        expect(adapter.states.get('office.status.online')).to.deep.equal({ val: false, ack: true });
        expect(adapter.states.get('office.status.state')).to.deep.equal({ val: 0, ack: true });
        expect(adapter.states.get('office.status.message')).to.deep.equal({ val: 'idle', ack: true });
        expect(adapter.states.get('office.counters.pages_completed')).to.deep.equal({ val: 20, ack: true });
        expect(adapter.states.get('office.supplies.0_black_toner')).to.deep.equal({ val: 45.25, ack: true });
    });

    it('creates the off state when the printer is offline before the first successful poll', async () => {
        const adapter = makeAdapter();
        await markOffline(adapter, { id: 'office' });
        expect(adapter.states.get('office.status.online')).to.deep.equal({ val: false, ack: true });
        expect(adapter.states.get('office.status.state')).to.deep.equal({ val: 0, ack: true });
    });
});
