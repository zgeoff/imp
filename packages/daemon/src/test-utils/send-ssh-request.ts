// how an ssh2 client method answers: its failure first, then its values
type RequestCallback<Values extends readonly unknown[]> = (
  failure?: Readonly<Error> | null,
  ...values: Values
) => void;

// Sends an ssh2 client request that answers through a callback, such as
// forwardIn or openssh_forwardInStreamLocal, and settles with its answer:
// the values after the failure argument, or a rejection with the failure.
export function sendSshRequest<Values extends readonly unknown[] = []>(
  send: (done: RequestCallback<Values>) => void,
): Promise<Values> {
  return new Promise((resolve, reject) => {
    send((failure, ...values) => {
      if (failure instanceof Error) {
        reject(failure);

        return;
      }

      resolve(values);
    });
  });
}
