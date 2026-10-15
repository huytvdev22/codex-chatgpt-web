export class TurnBroker {
  constructor(_path?: string) {}
  static forSocket(_path?: string) {
    return new TurnBroker(_path);
  }
  async listen(): Promise<void> {}
  async close(): Promise<void> {}
  revokeTrace(_traceId: string, _reason?: unknown): number { return 0; }
  revokeExternalOwners(): number { return 0; }
  externalOwnerActiveCount(): number { return 0; }
  setExternalOwnersAccepted(_val: boolean): void {}
}
export class RemoteTurnBroker extends TurnBroker {}
export type TurnBrokerOwner = unknown;
export async function closeTurnBrokers(): Promise<void> {}
