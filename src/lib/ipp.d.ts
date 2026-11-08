declare module '@sealsystems/ipp' {
    export interface IppMessage {
        [key: string]: unknown;
    }

    export interface IppResponse {
        statusCode?: string | number;
        [key: string]: unknown;
    }

    export const attributes: Record<string, Record<string, unknown>>;
    export function serialize(message: IppMessage): Buffer;
    export function parse(message: Buffer): IppResponse;
}
