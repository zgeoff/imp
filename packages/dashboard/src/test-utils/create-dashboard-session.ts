import { sessionCollection } from '../mocks/db/session-collection';
import { readTokenId, tokenCollection } from '../mocks/db/token-collection';

type TokenRow = Awaited<ReturnType<typeof tokenCollection.create>>;

interface DashboardSessionInput {
  // the token the browser logged in with; a new default token when left out
  readonly token?: TokenRow;
}

// A browser logged in to the mock impd: the token and the session made with it
// oxlint-disable-next-line prefer-readonly-parameter-types -- a collection record, which @msw/data hands out mutable
export async function createDashboardSession(input: Readonly<DashboardSessionInput> = {}) {
  const token = await readToken(input.token);
  const session = await sessionCollection.create({ tokenId: readTokenId(token.secret) });

  return { token, session };
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- a collection record, which @msw/data hands out mutable
async function readToken(token: TokenRow | undefined): Promise<TokenRow> {
  if (token !== undefined) {
    return token;
  }

  const created = await tokenCollection.create({});

  return created;
}
