import * as z from 'zod';

const StepSchema = z.looseObject({
  name: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
});

const MatrixRowSchema = z.looseObject({
  group: z.number(),
  browser: z.boolean(),
  'host-tests': z.boolean(),
});

const MatrixSchema = z.looseObject({ include: z.array(MatrixRowSchema) });

const GroupJobSchema = z.looseObject({
  strategy: z.looseObject({ matrix: MatrixSchema }),
  steps: z.array(StepSchema),
});

const AggregateJobSchema = z.looseObject({
  if: z.string(),
  needs: z.array(z.string()),
  steps: z.array(StepSchema),
});

const ReleaseJobSchema = z.looseObject({ needs: z.array(z.string()) });

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({
    'e2e-group': GroupJobSchema,
    e2e: AggregateJobSchema,
    'release-please': ReleaseJobSchema,
  }),
});

export type CiJobs = z.infer<typeof WorkflowSchema>['jobs'];

// The jobs of .github/workflows/ci.yml that the e2e group tests read: the
// e2e-group matrix, the required e2e aggregate, and release-please. Throws
// when one is missing or lacks the fields those tests read.
export function parseCiWorkflow(yaml: string): CiJobs {
  return WorkflowSchema.parse(Bun.YAML.parse(yaml)).jobs;
}
