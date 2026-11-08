import { expect } from 'chai';
import { SerialQueue } from '../../src/lib/serialQueue';

describe('SerialQueue', () => {
    it('runs overlapping operations in order and recovers after a rejection', async () => {
        const queue = new SerialQueue();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });

        const first = queue.run(async () => {
            events.push('first-start');
            await firstGate;
            events.push('first-end');
        });
        const second = queue.run(() => {
            events.push('second');
            return Promise.reject(new Error('test failure'));
        });
        const third = queue.run(() =>
            Promise.resolve().then(() => {
                events.push('third');
            }),
        );

        await Promise.resolve();
        expect(events).to.deep.equal(['first-start']);
        releaseFirst();
        await first;
        await second.catch(() => undefined);
        await third;

        expect(events).to.deep.equal(['first-start', 'first-end', 'second', 'third']);
    });
});
