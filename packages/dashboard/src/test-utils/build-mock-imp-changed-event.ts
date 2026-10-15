import { faker } from '@faker-js/faker';
import type { Imp, ImpEvent } from '@impz/api';
import { EVENT_VERSION } from '@impz/api';
import { buildMockImp } from './build-mock-imp';

type ImpChangedEvent = Extract<ImpEvent, { readonly ev: 'ImpChanged' }>;

interface ImpChangedEventOverrides extends Partial<Omit<ImpChangedEvent, 'imp'>> {
  readonly imp?: Partial<Imp>;
}

// the event impd streams after an imp's record changes
export function buildMockImpChangedEvent(
  overrides: ImpChangedEventOverrides = {},
): ImpChangedEvent {
  const { imp, ...rest } = overrides;

  return {
    v: EVENT_VERSION,
    at: faker.date.recent(),
    ev: 'ImpChanged',
    reason: 'updated',
    ...rest,
    imp: buildMockImp(imp),
  };
}
