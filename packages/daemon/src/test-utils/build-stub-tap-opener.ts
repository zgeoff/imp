import type { ResumeFrom } from '@imp/api';
import type { ExecStream } from '../agent-client/exec-stream';

// one call of the tap opener: the session it tapped and where it resumed
interface TapCall {
  readonly session: string;
  readonly resumeFrom: ResumeFrom | undefined;
}

// The agent's session tap, as the session logs open it: each call records
// what it asked for and takes the next answer the test queued, and a call
// with nothing queued is refused, as an agent that cannot tap refuses.
export function buildStubTapOpener() {
  const calls: TapCall[] = [];
  const answers: (() => Promise<ExecStream>)[] = [];

  return {
    calls,
    answers,
    openTap: (_vsockPath: string, session: string, resumeFrom?: ResumeFrom) => {
      calls.push({ session, resumeFrom });

      const answer = answers.shift() ?? (() => Promise.reject(new Error('no tap queued')));

      return answer();
    },
  };
}
