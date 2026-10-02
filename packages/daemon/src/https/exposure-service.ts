import type { ExposeResult, PublicAuth } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildNotFoundError } from '../api-errors';
import { findImpByName, updateImpExposure } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { HttpsConfig } from './https-config';
import type { RecordsStatus } from './https-service';
import { buildCredentialHash, createCredential } from './public-auth';

// basic auth's user when the caller names none
const DEFAULT_USER = 'imp';

interface ExposeRequest {
  readonly name: string;
  readonly auth: PublicAuth;
  readonly user?: string | undefined;
}

// Which imps the internet reaches (docs/guides/https.md#public-imps). The
// records and the listeners follow the database: the HTTPS service watches
// for the change.
export interface ExposureService {
  // public, with a fresh credential each time; shown this once
  readonly expose: (request: ExposeRequest) => Promise<ExposeResult>;
  readonly unexpose: (name: string) => Promise<ImpRecord>;
}

interface ExposureDeps {
  readonly db: ImpDatabase;
  readonly https: HttpsConfig | null;

  // a pass over the public records now; null without the HTTPS service
  readonly updateRecords: () => Promise<RecordsStatus | null>;
}

export function createExposureService(deps: ExposureDeps): ExposureService {
  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  return {
    expose: async (request) => {
      const https = deps.https;

      if (https === null || https.public === null) {
        throw new ORPCError('PRECONDITION_FAILED', {
          message: 'public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
        });
      }

      const imp = await requireImp(request.name);

      const credential = request.auth === 'none' ? null : createCredential();
      const user = request.auth === 'basic' ? (request.user ?? DEFAULT_USER) : null;

      await updateImpExposure(deps.db, imp.id, {
        auth: request.auth,
        user,
        hash: credential === null ? null : buildCredentialHash(credential),
      });

      const records = await deps.updateRecords();

      const isWritten = records === null || records.isOk;

      return {
        url: `https://${imp.name}.${https.domain}`,
        auth: request.auth,
        user,
        credential,
        ...(!isWritten && {
          warning: `the DNS record for ${imp.name}.${https.domain} is not written yet (${records.error ?? 'unknown error'}); impd tries again every 10 minutes`,
        }),
      };
    },
    unexpose: async (name) => {
      const imp = await requireImp(name);
      const changed = await updateImpExposure(deps.db, imp.id, null);

      // a failed removal is logged, and the next pass tries again
      await deps.updateRecords();

      return changed;
    },
  };
}
