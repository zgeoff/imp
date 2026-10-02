import type { HttpsService, RecordsStatus } from './https-service';

// The router's way to the public records. impd builds the router before
// the HTTPS service, so the service attaches itself here once it exists;
// until then, and without IMP_DOMAIN, there is nothing to update.
export interface PublicRecordsLink {
  readonly attach: (
    service: Pick<HttpsService, 'updatePublicRecords' | 'readRecordsStatus'>,
  ) => void;
  readonly update: () => Promise<RecordsStatus | null>;
  readonly readStatus: () => RecordsStatus | null;
}

export function createPublicRecordsLink(): PublicRecordsLink {
  let attached: Pick<HttpsService, 'updatePublicRecords' | 'readRecordsStatus'> | null = null;

  return {
    attach: (service) => {
      attached = service;
    },
    update: () => (attached === null ? Promise.resolve(null) : attached.updatePublicRecords()),
    readStatus: () => attached?.readRecordsStatus() ?? null,
  };
}
