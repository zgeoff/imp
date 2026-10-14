import * as z from 'zod';

const StepSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const ConcurrencySchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

const JobSchema = z.looseObject({
  needs: z.array(z.string()),
  concurrency: ConcurrencySchema.optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
});

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({
    base: JobSchema,
    image: JobSchema,
    publish: JobSchema,
    latest: JobSchema,
    tap: JobSchema,
    'npm-pack': JobSchema,
  }),
});

export type ReleaseJobs = z.infer<typeof WorkflowSchema>['jobs'];

// The jobs of .github/workflows/release.yml that its tests read: base, image,
// publish, latest, and tap and npm-pack, which read latest's outputs. Throws
// when one is missing or has no needs or steps.
export function parseReleaseWorkflow(yaml: string): ReleaseJobs {
  return WorkflowSchema.parse(Bun.YAML.parse(yaml)).jobs;
}
