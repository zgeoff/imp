import { registerRunHooks } from './register-run-hooks';

// the end-to-end suites drive a real impd and real registries, so their run
// has no MSW server
registerRunHooks();
